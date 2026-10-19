# Walkthrough M3: Gateway (Tasks 9–12)

## Big picture

`apps/gateway` is one Fastify process with three faces: the REST API under `/api` for the dashboard, one MCP endpoint at `/mcp` for every MCP client, and the chat module ([M4](M4-dashboard-chat.md)). Behind `/mcp` it is itself an MCP client of every enabled upstream, with one shared, health-checked connection per server that carries that server's own credential. Clients see one catalog of `<slug>__<tool>` names; each call is routed to the right connection, bounded by that server's timeout, and written to the audit log under the caller's name. PostgreSQL holds users, sessions, keys, servers, the last known tool lists and the audit log; live connection state is in memory. The system-level view is in [system-design.md](../system-design.md).

## File map (`apps/gateway/src/`)

| File | What it does |
|---|---|
| [`main.ts`](../../apps/gateway/src/main.ts), [`compose.ts`](../../apps/gateway/src/compose.ts) | Composition root: config, database pool, bootstrap admin, seeds, wiring; `listen`, then connect the upstreams; bounded shutdown on SIGTERM. Tests reuse `createGatewayModules` with their own clock, upstream factory and LLM (everything goes through `GatewayContext`, no globals) |
| [`app.ts`](../../apps/gateway/src/app.ts), [`config.ts`](../../apps/gateway/src/config.ts), [`lib/errors.ts`](../../apps/gateway/src/lib/errors.ts) | Request ids, problem+json errors (5xx details hidden), `/livez`, `/readyz` (database only), environment checked with Zod at startup |
| [`db/schema.ts`](../../apps/gateway/src/db/schema.ts), [`db/migrate-main.ts`](../../apps/gateway/src/db/migrate-main.ts) | Eight tables (Drizzle); the `migrate` initContainer applies migrations before the server starts |
| [`lib/crypto.ts`](../../apps/gateway/src/lib/crypto.ts) | scrypt for passwords, HMAC-SHA256 with a pepper for API keys, SHA-256 for session and invite tokens, AES-256-GCM for upstream credentials |
| [`modules/auth/`](../../apps/gateway/src/modules/auth/), [`modules/keys/`](../../apps/gateway/src/modules/keys/) | Sign-in (5 tries a minute per IP and email), cookie sessions, CSRF header check, invitations, roles; API keys shown once, revoked, verified on every request with no cache |
| [`modules/servers/`](../../apps/gateway/src/modules/servers/) | Admin CRUD, test connection, write-only credentials, first-boot seeds (`woo`, `fx`, and `github` when its Secret has a token) |
| [`mcp/upstream/connection.ts`](../../apps/gateway/src/mcp/upstream/connection.ts) | One upstream's state machine: connect, health check every 10 s, failure counters, reconnect backoff |
| [`mcp/upstream/manager.ts`](../../apps/gateway/src/mcp/upstream/manager.ts) | One connection per enabled server; decrypts the credential into request headers (`targetFor`); saves status and tools; emits `catalog.changed` |
| [`sdk-client.ts`](../../apps/gateway/src/mcp/upstream/sdk-client.ts), [`errors.ts`](../../apps/gateway/src/mcp/upstream/errors.ts) | MCP SDK v2 client with the protocol version negotiated; failures classified as `DNS`, `CONNECTION_REFUSED`, `TIMEOUT`, `TLS`, `AUTH`, `HTTP_ERROR` or `PROTOCOL` |
| [`mcp/catalog.ts`](../../apps/gateway/src/mcp/catalog.ts), [`mcp/naming.ts`](../../apps/gateway/src/mcp/naming.ts) | Snapshot of the connected servers' tools under exposed names; descriptions prefixed `[Server name]` and capped at 2000 characters |
| [`mcp/endpoint.ts`](../../apps/gateway/src/mcp/endpoint.ts), [`mcp/invoke.ts`](../../apps/gateway/src/mcp/invoke.ts) | `/mcp`: Host check, API key or chat token, a fresh MCP server per request, `list_changed` push; `invokeTool()` routes, times out, maps errors and audits |
| [`modules/audit/service.ts`](../../apps/gateway/src/modules/audit/service.ts) | `recordAudit()` only inserts and never stores tool arguments; `queryAudit()` filters and pages, and gives members only their own rows |
| [`mcp/gateway.test.ts`](../../apps/gateway/src/mcp/gateway.test.ts) | End to end: the real app and PostgreSQL against real mcp-kit upstreams on loopback ports (routing, disable, kill and revive, timeout, wrong credential, revoked key, Host check) |

## Four flows through the code

1. **An MCP client calls `woo__list_orders`:**

```text
client ──POST app.<domain>/mcp, Bearer umcp_…──▶ Traefik ──▶ gateway:8080
endpoint.ts    hostHeaderValidation   Host not on the allow-list → 403 (DNS-rebinding guard)
               authenticate           verifyApiKey: prefix lookup, HMAC compare, revoked / expired / user disabled?
                                      no → 401 + WWW-Authenticate, and a denied_auth row if the owner is known
               createMcpHandler       fresh Server for this request: tools/list = catalog.list(), tools/call ↓
invoke.ts      catalog.resolve        woo__list_orders → woo's connection, original name list_orders, 30 s
connection.ts  callTool               not connected → UpstreamUnavailable; a transport error counts as a failure
sdk-client.ts  client.callTool        Bearer <woo token> (decrypted by targetFor) ──▶ woo-mcp ──▶ WooCommerce (M2)
invoke.ts      recordAudit            user, key, mcp_client, woo, list_orders, ms, success | tool_error; result as is
```

2. **An admin adds a server.** The form can first call `POST /api/servers/test`, which runs `initialize` and `tools/list` with a throwaway client and returns latency, protocol era and tool names, or a classified reason; nothing is stored. Saving calls `POST /api/servers`: `requireAdmin` → contract checks (slug `^[a-z][a-z0-9-]{1,19}$`, http(s) URL, header name, timeout 1–120 s) → 409 if the slug is taken → credential sealed with AES-256-GCM → row inserted → `manager.reload(id)`. The manager decrypts the credential into headers and starts an `UpstreamConnection`: connect (5 s), `tools/list` (10 s), `connected`, status and tools saved, `catalog.changed` → `ToolCatalog.rebuild()` → `handler.notify.toolsChanged()`. Editing, disabling and "Reconnect now" take the same `reload()` path; deleting removes the row (its tools cascade) and the connection.
3. **An upstream dies** (`task dod` scales `fx-mcp` to 0). The health check, a `tools/list` every 10 s that also refreshes the tools, starts failing, or calls do. Two failed checks or three failed calls in a row mark the server `unreachable` with a reason from `classifyError()`, which walks the error's cause chain because the SDK wraps network errors (a refused connection arrives as `ERA_NEGOTIATION_FAILED` → `fetch failed` → `ECONNREFUSED`). The catalog drops `fx__*` and clients get `list_changed`; `woo` and `github` keep their own connections, and `tools/list` only reads the snapshot. A call to an `fx__` tool now gets `isError` "Server 'fx' is unreachable right now (CONNECTION_REFUSED: connection refused). Other servers are unaffected.", audited as `upstream_unreachable`. Reconnects back off from 1 s to 30 s with jitter and stay `unreachable` until one succeeds. See [upstream-unreachable](../runbooks/upstream-unreachable.md).
4. **An admin revokes user B's key.** `DELETE /api/api-keys/:id` sets `revoked_at`. B's next request to `/mcp` runs `verifyApiKey()` again (no cache, and no MCP session that could outlive the key), gets `revoked`, and B receives 401; the audit log gets a `denied_auth` row attributed to B and that key. See [revoke-compromised-key](../runbooks/revoke-compromised-key.md).

## Design decisions, one line each

- **Stateless `/mcp`** ([ADR-0003](../adr/0003-mcp-sdk-v2-stateless-gateway.md)): every request re-authenticates, so revocation is immediate, a restart loses nothing and replicas need no sticky sessions.
- **`<slug>__<tool>` with immutable slugs:** no collisions and no shadowing, every tool shows its origin, and clients can cache names safely.
- **Upstreams never block the gateway:** `tools/list` reads a catalog snapshot and readiness checks only PostgreSQL, so a slow or dead server can't stall listing or take the gateway out of its Service.
- **One connection per server, shared by all users:** the upstream credential belongs to the team; user identity stays at the gateway for the audit log, and a client's key is never forwarded.
- **Errors the model can read:** disabled, unreachable, timed-out and failing servers come back as `isError` results with one plain sentence (only an unknown tool is a JSON-RPC `-32602`), and `tools/call` is never retried because tools like `create_product` aren't idempotent.
- **HMAC with a pepper for API keys, scrypt for passwords:** keys are 256 random bits, so a fast keyed hash is safe and cheap on every request; passwords are guessable and need a slow, salted hash.

## Likely questions and short answers

**How do you handle two servers exposing the same tool name?**
Every tool is exposed as `<slug>__<tool>`. Slugs can't contain `_`, so the first `__` always splits correctly. Characters outside `[A-Za-z0-9_-]` become `_`, and names over 64 characters are cut and end in an 8-character hash of the original. `woo` and `fx` both have `server_info`, exposed as `woo__server_info` and `fx__server_info`. First-come-wins would let a new server silently shadow a trusted tool.

**What happens when an upstream is slow?**
Each server has its own timeout (woo 30 s, fx 15 s, 1 to 120 s per server), passed to the SDK call. The caller gets "Server 'woo' did not respond within 30s." and the row says `timeout`. A timeout counts as a failed call and triggers an immediate health check; if `tools/list` still answers, the server stays connected (tested). In `task dod`, a call to the dead `fx` once recorded `timeout` rather than a refusal, because a keep-alive connection to the vanished pod's IP waited out the 15 s limit.

**Can a member see or use an upstream credential?**
Only indirectly, by calling that server's tools through the gateway, and every call is audited under their name. Credentials are write-only in the API, sealed with AES-256-GCM (key in Secret `gateway-crypto`) and decrypted only in `targetFor()` to build request headers; members don't even get server URLs. A test checks the plaintext appears in neither API responses nor the database.

**Why not pass the user's token through to the upstream?**
Upstreams don't know our users, and forwarding a gateway key would hand every upstream a credential it could replay against the gateway (MCP's "token passthrough" anti-pattern). The gateway authenticates the user, calls the upstream with that server's own credential, and keeps the user's identity in the audit log; inside the MCP handler the token is replaced by `'redacted'`.

**What if an admin adds a malicious or compromised server?**
Its tools are namespaced, so it can't replace `woo__create_product`; its descriptions carry its name and are capped at 2000 characters; it receives only its own credential, never users' keys; and the gateway's `instructions` and the chat's system prompt tell models to treat tool output as data. It can still return false data, but every call is audited, and disabling it hides its tools from everyone at once. Not yet covered (Phase 2, Task 22): an SSRF guard on the URL and pinning of tool definitions, so adding servers is trusted to admins. More in [threat-model.md](../threat-model.md).

**Is every call really in the audit log?**
`invokeTool()` writes exactly one row on every path: success, tool error, timeout, unreachable, disabled and unknown tool. A refused key is recorded as `denied_auth` when its owner is known (revoked, expired, user disabled); a made-up key has no user to attribute. A failed insert is logged and doesn't fail the call, which favours availability over a complete log.

**Could the gateway run two replicas?**
`/mcp` is stateless, but change events, chat tokens and the login throttle live in one process's memory, and each replica would hold its own upstream connections. A shared event bus (Valkey) is Phase 2 Task 25, so the chart runs one replica.
