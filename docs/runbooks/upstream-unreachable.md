# Runbook: an upstream server is Unreachable

The gateway health-checks every enabled server every 10 seconds. After 2 failed checks, or 3 failed calls, it marks the server **Unreachable** with a reason. Calls to it then fail fast with a clear error, its tools stay out of the tool list, and the other servers keep working. It retries with backoff (1 s growing to 30 s), and the server returns to **Connected** by itself once a check succeeds.

## 1. Read the reason

Dashboard → **Servers**: the card shows the reason and since when; click it for the detailed message.

| Reason on the card | Meaning | Usual cause |
|---|---|---|
| Host name not found (`DNS`) | The URL's host doesn't resolve | Typo in the URL; for in-cluster servers, the Service doesn't exist |
| Connection refused (`CONNECTION_REFUSED`) | Nothing listens there | The pod is down, scaled to 0 or restarting; wrong port |
| Timed out (`TIMEOUT`) | No answer within the server's timeout | The server is overloaded or hung, or a NetworkPolicy drops the packets |
| TLS problem (`TLS`) | The HTTPS handshake failed | Expired or self-signed certificate on an external server |
| Credential rejected (`AUTH`) | HTTP 401 or 403 | Wrong or rotated credential: [rotate-upstream-credential.md](rotate-upstream-credential.md) |
| HTTP error (`HTTP_ERROR`) | Another HTTP error status | Wrong path (the URL must be the MCP endpoint, usually `/mcp`), or a server error |
| Not a working MCP endpoint (`PROTOCOL`) | It answered, but not as an MCP server over Streamable HTTP | A web page or an old SSE-only server at that URL |

## 2. Check the server (in-cluster: woo-mcp, fx-mcp)

```sh
kubectl -n ahjin get pods -l app.kubernetes.io/name=fx-mcp           # Running and 1/1?
kubectl -n ahjin describe pod -l app.kubernetes.io/name=fx-mcp       # events: image pulls, probes, OOMKilled
kubectl -n ahjin logs deploy/fx-mcp --tail=50
kubectl -n ahjin get deploy fx-mcp                                   # replicas 0? (task dod scales it to 0 and back)
```

**NetworkPolicy:** only pods labelled `app.kubernetes.io/name=gateway` may reach the MCP servers. Probe the path the gateway uses with a throwaway pod carrying that label:

```sh
kubectl -n ahjin run np-test --image=busybox:1.37.0 --labels=app.kubernetes.io/name=gateway --restart=Never -- sleep 300
kubectl -n ahjin exec np-test -- nc -z -w 3 fx-mcp 8080 && echo reachable
kubectl -n ahjin delete pod np-test
```

Wait a few seconds after the pod starts before testing: k3s admits a new pod through the policies a moment after it starts.

## 3. Check the server (external, e.g. GitHub)

- From your machine: `curl -sI https://api.githubcopilot.com/mcp/x/issues` should answer (401 without a token is fine; it means the host is up).
- **Credential rejected:** the token expired or was revoked. Issue a new one and update it in the dashboard.
- The gateway pod needs outbound HTTPS; egress isn't restricted today.

## 4. Bring it back

- Fix the cause; the next health check (within about 10 to 30 s) reconnects it.
- To retry right away: **Servers** → the server → **Reconnect now**.
- While a server is down for a long time, **disable** it (the switch on its card). Its tools leave every client's list instead of failing call by call.

## Timeouts

Each server has its own call timeout (seeded: woo 30 s, fx 15 s, github 30 s), set in **Edit**. A call that runs out returns "Server '<slug>' did not respond within <n>s." and is audited as `timeout`; enough of them in a row mark the server Unreachable.
