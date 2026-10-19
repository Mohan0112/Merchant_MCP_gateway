# Demo script

A recording plan for the demo video. It covers every item of the brief's "Demo video requirements", in this order, in about **18 minutes**. Each segment lists what to show, the exact clicks and commands, and what to say. The browser steps are the same as [runbooks/dod-manual.md](runbooks/dod-manual.md).

## Preparation (before recording)

- [ ] `task demo:reset` → no orders, 4 sample products, all servers connected, users A and B, empty audit log.
- [ ] `task logins` → note the Admin, User A and User B logins. Sign in as Admin once beforehand, so the forced password change isn't in the video.
- [ ] Three browser profiles side by side, signed in as **Admin**, **User A** and **User B**; a fourth tab with the storefront.
- [ ] A terminal at the repo root, large font, with `kubectl config use-context k3d-urumi`. Claude Code installed. Remove any old entry first: `claude mcp remove urumi`.
- [ ] The diagram in [README.md](../README.md#architecture) open in a tab.
- [ ] Test the LLM once (`task dod` passes); if Groq rate-limits, wait a minute: Gemini is the fallback.

## 1. System design (2 min)

Show the README architecture diagram.

- "Four layers: a WooCommerce store, an MCP server I wrote for it, the gateway with its dashboard, and a chat agent. Everything runs in one namespace, installed by one Helm chart."
- "The gateway is the only thing that talks to upstream MCP servers. It's an MCP client of each of them, and itself one MCP server for the team: one URL, one personal key."
- "Three upstreams: my WooCommerce server, my currency server, and GitHub's hosted MCP server outside the cluster."

## 2. Kubernetes tour (2.5 min)

```sh
kubectl -n urumi get pods,svc,ingress,pvc
kubectl -n urumi get secrets                       # names only; values come from a git-ignored file
kubectl -n urumi get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].readinessProbe}{"\n"}{.spec.template.spec.containers[0].resources}{"\n"}'
kubectl -n urumi get networkpolicy
task verify:k8s -- --no-kubeconform                # every workload: probes, requests and limits, non-root, policies
kubectl -n urumi run np-test --image=busybox:1.37.0 --restart=Never -- sleep 300
kubectl -n urumi exec np-test -- nc -z -w 3 woo-mcp 8080 || echo "blocked"
kubectl -n urumi delete pod np-test
```

- "Two Ingress hosts: store and app. MariaDB, Postgres and the MCP servers are internal: ClusterIP only, and the MCP server chart has no Ingress template at all."
- "Every pod in the namespace denies ingress by default; each component admits only its known clients. A random pod can't reach woo-mcp; only the gateway can."
- "Databases and uploads are on PVCs, so data survives restarts and upgrades. Probes and requests and limits on every workload are checked in CI."

## 3. Store (1.5 min)

Storefront tab → **Urumi Coffee Mug** → **Add to cart** → **View cart** → **Proceed to checkout** → billing details → **Cash on delivery** → **Place order**. Then **/wp-admin** → **WooCommerce → Orders**: the order is **Processing**.

## 4. Chat agent as User A (2.5 min)

User A → **Chat**:

1. `Create a product named "Urumi Water Bottle" with a price of 349.` Expand the `woo__create_product` card: arguments, result, duration.
2. Storefront → **Shop**: the bottle is there. Order it by hand.
3. `What orders came in today?` The agent calls `woo__list_orders` and lists both orders.

- "The agent runs inside the gateway but calls the gateway's own MCP endpoint, as User A, with a five-minute token tied to her session. So permissions and the audit log are exactly the same as for an external client."

## 5. External client as User B (2.5 min)

User B → **API keys** → **New key** `Claude Code` → **Create key** → show the Claude Code tab of the dialog and copy the command.

```sh
claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <B's key>"
claude
```

In Claude Code: `/mcp` → **urumi**, 21 tools. Then:

1. `What orders came in today?` → `woo__list_orders`.
2. `What is the total of today's orders in US dollars?` → `woo__list_orders`, then `fx__convert_currency`: two servers in one prompt.

- "B configured one URL and one key. She never sees the WooCommerce token or the GitHub token, and couldn't if she tried."

## 6. Team and control (2.5 min)

1. **Revoke:** User B → **API keys** → **Revoke**. In Claude Code, ask again: the call fails with 401.
2. **Disable:** Admin → **Servers** → switch **fx** off. User A: `Convert 100 USD to INR`: no fx tool any more. Switch it on again.
3. **Kill:**
   ```sh
   kubectl -n urumi scale deployment fx-mcp --replicas=0
   ```
   Admin → **Servers**: **fx** turns **Unreachable · Connection refused** within about 20 s. User A asks the orders question: woo still works. Then `kubectl -n urumi scale deployment fx-mcp --replicas=1`; fx reconnects by itself.
4. **Audit log** (Admin): every call above with user, **Via** (`chat_agent` or `mcp_client`), server, tool, duration and outcome: `success`, `denied_auth` after the revocation, `rejected_disabled`, and `upstream_unreachable` or `timeout`. Switch to User B: she sees only her own entries.

## 7. MCP internals (1.5 min)

Admin → **Servers** → **woo** → its tools.

- "Tools are exposed as server slug, two underscores, tool name. woo and fx both have a `server_info` tool; clients see `woo__server_info` and `fx__server_info`. Slugs can't contain underscores, so a name always splits unambiguously and no server can shadow another."
- "A call is routed by its prefix to that server's connection, with that server's own credential and timeout: 30 s for woo, 15 s for fx."
- "Health checks every 10 s: after 2 failed checks or 3 failed calls a server is Unreachable with a reason, calls to it fail fast, and it reconnects with backoff. The tool list comes from memory, so a dead server never blocks listing."

## 8. Security posture (2 min)

```sh
echo "select name, prefix, left(key_hash, 12) || '…' as stored_hash from api_keys limit 3;" | kubectl -n urumi exec -i postgres-0 -- psql -U urumi -d urumi
echo "select slug, auth_type, octet_length(credential_ciphertext) as encrypted_bytes from upstream_servers;" | kubectl -n urumi exec -i postgres-0 -- psql -U urumi -d urumi
```

- "API keys are shown once and stored as an HMAC with a server-side pepper. Upstream credentials are AES-256-GCM encrypted, write-only in the API, and only the gateway sends them, each only to its own server. Client tokens are never passed through."
- "A member uses tools, manages her own keys and sees her own audit entries. She can't see URLs or credentials, add servers, or touch other people's keys."
- "A malicious server: its tools are namespaced and labelled, descriptions are capped, the agent treats tool output as data, and the server only ever sees calls to its own tools. Disabling it removes its tools everywhere at once. What's not there yet: an SSRF guard for admin-entered URLs, and tool-definition pinning." (Details: [threat-model.md](threat-model.md).)

## 9. Chat agent internals (1 min)

Open `apps/gateway/src/modules/chat/agent.ts`.

- "The loop: send the conversation and the tool list to the model; run every tool call it asks for through MCP; feed the results back; stop when it answers. At most 8 rounds and 120 seconds. Groq first, Gemini as the fallback."

## 10. Local to VPS (2 min)

```sh
diff charts/urumi/values-local.yaml charts/urumi/values-prod.yaml
cat charts/urumi/values-rehearsal.yaml
helm -n urumi history urumi
```

- "Same chart everywhere; only values differ: domain, TLS through cert-manager and Let's Encrypt, images from GHCR with immutable git-SHA tags, bigger volumes and limits. Secrets are created by the same script against the VPS's context."
- "I rehearsed production on a fresh single-node k3s with the production values and the CI-built images, over HTTPS: the full definition-of-done check passed. Then an upgrade, a rollback, and a broken upgrade that Helm rolled back automatically while the gateway kept answering."
- Optional live: `helm -n urumi rollback urumi 0 --wait` and `helm -n urumi history urumi` again.

## 11. Extras (0.5 min)

Show the README's "Extras and stand-out items" table and say which are done.

## After recording

- [ ] `claude mcp remove urumi`.
- [ ] `task demo:reset` if you record again.
