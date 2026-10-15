# Walkthrough M2: Upstream MCP servers (Tasks 6–8)

## What exists now

| Piece | What it is |
|---|---|
| `packages/mcp-kit` | Shared foundation every MCP server we write uses: stateless MCP endpoint, credential check, Host allow-list, health endpoints, `server_info`, safe error handling |
| `charts/urumi/charts/mcp-server` | One Helm chart for any in-cluster MCP server, used twice through aliases (`woo-mcp`, `fx-mcp`) |
| `apps/woo-mcp` | The WooCommerce MCP server we wrote: 6 store tools |
| `apps/fx-mcp` | A currency-conversion MCP server: second upstream, kill-pod demo target |
| GitHub remote MCP | External third upstream (Issues toolset), verified with the fine-grained token |

## How a tool call reaches the store

```text
gateway ──HTTP, Bearer <woo token>──▶ woo-mcp :8080/mcp
  1. Host header must be woo-mcp / woo-mcp.urumi.svc…  (else 403: DNS-rebinding guard)
  2. Bearer token compared in constant time            (else 401)
  3. MCP SDK builds a fresh server for this request (stateless) and runs the tool
woo-mcp ──HTTP, Basic <REST key>──▶ wordpress :8080/wp-json/wc/v3/...
  4. mu-plugin: Host is the internal name, so treat as HTTPS, so WooCommerce accepts Basic Auth
  5. mcp-bot is a shop_manager: products and orders, no plugins or users
```

## Why "internal only" is enforced three ways

1. **No Ingress:** the `mcp-server` chart has no Ingress template, so these servers can't be exposed by a values mistake.
2. **NetworkPolicy:** only pods labelled `app.kubernetes.io/name=gateway` may connect (tested: other pods are blocked).
3. **Credential + Host check:** even inside the cluster, a caller needs the token, and a forged Host header gets 403.

## Design points worth explaining

- **"Today" is computed by the server, not the model.** `list_orders(period="today")` resolves the store's local day (Asia/Kolkata) into exact UTC bounds, so an order at 00:15 IST counts as today even though UTC is still yesterday. Daylight-saving days are handled too.
- **Errors the model can act on.** Store failures are classified (not found / rejected / credentials / unavailable) and returned as tool errors with a clear sentence. Unexpected crashes return a generic message with an incident id; internals never leak (tested with a fake "password" in the error).
- **Reads retry, writes don't.** GETs retry twice on 5xx or timeouts; creating a product or changing a status never retries, so it can't happen twice.
- **Privacy:** list views have names and totals but no addresses, emails or phones; `get_order` is for when details are needed.
- **Tiny, locked-down images:** each Node service is bundled into one file and runs on a distroless, non-root, read-only image with no shell.

## Likely questions

**Why write `fx-mcp` instead of using a public server?**
The demo needs an upstream we can kill to show the gateway survives, and a second credential style (header instead of bearer). It also gives a meaningful cross-server question: "today's revenue in USD".

**What if the currency website is down?**
`fx-mcp` tries the CDN, then a mirror, then a built-in rate table, and caches live rates for an hour. The tool still answers.

**What did the NetworkPolicy "bug" teach you?**
A brand-new pod is blocked for a few seconds until the policy engine learns its IP. So the gateway must retry upstream connections when it starts, and that's built into its connection manager.
