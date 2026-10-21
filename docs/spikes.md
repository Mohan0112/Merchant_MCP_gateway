# Technical spikes (Task 3)

Three throwaway experiments, run before building on these integrations so that risky assumptions failed early and cheaply. The spike code lived outside the repository and was deleted afterwards. The decisions it supports are ADR-0002 and ADR-0003.

| Spike | Question | Verdict |
|---|---|---|
| A | Can `woo-mcp` authenticate to WooCommerce over plain in-cluster HTTP? | ✅ Yes: Basic Auth + internal-host mu-plugin |
| B | Does the MCP SDK support our gateway design, and do real clients connect? | ✅ Yes, on **SDK v2** (stateless handler); Claude Code and MCP Inspector connect |
| C | Does the LLM tool loop work on free tiers with MCP-style schemas? | ✅ Yes: Groq `openai/gpt-oss-120b` (default), Gemini `gemini-2.5-flash` (fallback) |

---

## Spike A: WooCommerce REST authentication from inside the cluster

**Setup.** Docker network with `mariadb:11.4` and `wordpress:7.1.3-php8.4-apache`. WP-CLI (`wordpress:cli-php8.4`) installed WordPress and WooCommerce 11.2.1, and created a `shop_manager` user `mcp-bot`. A REST key was inserted for that user, hashed with WooCommerce's own `wc_api_hash()`. The mu-plugin `ahjin-internal-https.php` sets `$_SERVER['HTTPS'] = 'on'` only when the `Host` header equals the env var `AHJIN_INTERNAL_HOST` (the in-cluster Service name). A `curl` container called the API by the internal host name.

| Test | Expected | Result |
|---|---|---|
| Internal host + Basic Auth → `GET /wc/v3/products` | 200 | ✅ 200 |
| **Public** `Host` header + same credentials | 401 (plugin doesn't apply → WooCommerce refuses Basic Auth over HTTP) | ✅ 401 |
| Internal host, no credentials | 401 | ✅ 401 |
| `POST /wc/v3/products` (name, price 499) | 201 | ✅ created id 10, price 499 |
| `GET /wc/v3/orders` | 200 | ✅ 200 |
| `shop_manager` key → `GET /wp/v2/plugins` | denied | ✅ 401 |

**Findings**
1. **WooCommerce 11.2.1 requires WordPress ≥ 7.0** (tested up to 7.1.3). The `wordpress:6-*` images can't install it. The store image uses `wordpress:7.1.3-php8.4-apache`.
2. Because WordPress believes internal requests are HTTPS, **URLs in responses come back as `https://…`** (for example `permalink: https://store.spike.local/?product=spike-mug`). `woo-mcp` must rewrite returned store URLs to the configured public store URL (`STORE_PUBLIC_URL`).
3. Inserting the key with `wc_api_hash()` works, so the bootstrap Job can create a known key from a Kubernetes Secret with no Kubernetes API access.
4. Without pretty permalinks the REST route is reachable as `/?rest_route=/wc/v3/...`. The bootstrap Job enables pretty permalinks so `/wp-json/wc/v3/...` works too.

---

## Spike B: MCP SDK, aggregation and real clients

**Discovery.** The MCP TypeScript SDK now ships as **v2 split packages** (`@modelcontextprotocol/server`, `/client`, `/node`, `/fastify`; 2.3.x). They implement the **2026-07-28 MCP specification** and replace v1's single `@modelcontextprotocol/sdk` package. Relevant v2 behaviour:
- `createMcpHandler(factory)` is **stateless**: the factory builds a fresh server per HTTP request and receives `{ era, authInfo }`. Authentication is pass-through: we verify the bearer key ourselves and hand `authInfo` to the handler.
- **Modern (2026-07-28) clients** get change events (`notifications/tools/list_changed`) on a `subscriptions/listen` stream. We publish them with `handler.notify.toolsChanged()`. The event bus is pluggable (`ServerEventBus`) for multi-replica fan-out.
- **2025-era clients** are served statelessly from the same factory: `initialize` works, but there is no standalone GET stream (405), so they see tool changes on their next `tools/list`.
- The upstream `Client` with `versionNegotiation: { mode: 'auto' }` talks to both 2026 and 2025 servers.
- There's an official Fastify adapter (`createMcpFastifyApp`, `toNodeHandler`) with DNS-rebinding protection (host and origin allow-lists).

**Setup.** An upstream server (tools `echo` and `slow`, static bearer credential) and a mini gateway: an upstream `Client` in auto mode, plus a `createMcpHandler` factory building a low-level `Server` with `tools/list` (namespaced `up__*`) and `tools/call` (forwarding with a 2 s timeout). Bearer keys map to users, and there's an admin toggle that calls `handler.notify.toolsChanged()`.

| Check | Result |
|---|---|
| Gateway → upstream negotiation | ✅ `modern` era |
| `tools/list` through the gateway | ✅ `up__echo, up__slow` |
| Forwarded call | ✅ `echo: hi` |
| Upstream sleeps 5 s, gateway timeout 2 s | ✅ `isError: true`, "Request timed out"; other calls unaffected |
| Modern client `listen({ toolsListChanged: true })` | ✅ `honoredFilter: {"toolsListChanged":true}` |
| Disable upstream → notification | ✅ 1 `list_changed` received; list becomes empty; direct call returns "disabled by an admin" |
| 2025-era client (`versionNegotiation: legacy`) | ✅ list and call work (stateless) |
| Wrong key | ✅ HTTP 401 → `SdkHttpError` `CLIENT_HTTP_AUTHENTICATION` |
| Audit attribution | ✅ `[audit] user=userA …` / `user=userB …` from `ctx.http.authInfo` |
| **Claude Code 2.1.300** (`claude mcp add --transport http … --header "Authorization: Bearer …"`) | ✅ `✔ Connected`, speaks the **modern** era, so it can receive `list_changed` |
| **MCP Inspector 2.11.0** CLI (`--cli … --transport http --header … --method tools/list`) | ✅ lists `up__echo, up__slow`; speaks the **2025 (legacy)** era |

**Consequences for the design (ADR-0003)**
- The gateway's `/mcp` uses `createMcpHandler` with a per-request factory. This **replaces the plan's stateful session map** (old ADR-013): every request is authenticated, the factory builds the caller's tool view, and nothing is held between requests. Revocation is immediate, and horizontal scaling only needs a shared `ServerEventBus` (Phase 2).
- Claude Code gets live tool-list updates. Inspector and other 2025-era clients see changes on re-list, and calls to disabled servers fail with a clear error either way.
- Our MCP servers (`woo-mcp`, `fx-mcp`) use `McpServer.registerTool` with Zod v4 schemas behind the same stateless handler.

---

## Spike C: LLM tool calling on free tiers

**Setup.** The `openai` SDK 7.34 against OpenAI-compatible endpoints. Two tools used **exactly the JSON Schemas Zod v4 emits** (with `$schema` and `additionalProperties: false`), with fake tool results. Prompt: "What was today's total order revenue, converted to USD?"

| Model | Turns | Latency | Tool calls | Result |
|---|---|---|---|---|
| Groq `openai/gpt-oss-120b` | 3 | 2.3 s | `woo__list_orders({period:"today"})` → `fx__convert_currency({amount:1749,from:"INR",to:"USD"})` | ✅ correct answer |
| Groq `openai/gpt-oss-20b` | 3 | 1.4 s | same | ✅ correct answer |
| Gemini `gemini-2.5-flash` (OpenAI-compatible endpoint) | 3 | 7.3 s | same | ✅ correct answer |

**Findings**
- **Default model: Groq `openai/gpt-oss-120b`**; fallback Gemini `gemini-2.5-flash`. Both are set through Helm values.
- Both providers accepted the raw Zod v4 JSON Schemas, so the per-provider schema clean-up can stay minimal (only strip keywords a provider rejects).
- Tool names in `slug__tool` form are accepted by both providers.
- Groq's free catalog (11 models) includes `openai/gpt-oss-120b`, `openai/gpt-oss-20b` and `qwen/qwen3.8-27b`; the Llama 3.3 model named in the original plan is no longer listed.
