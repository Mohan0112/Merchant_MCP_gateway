# Brief checklist

Every requirement of the brief ("AI FDE Internship, Round 1: MCP Gateway on Kubernetes"), with where it is implemented and how it was verified. Status as of 2026-10-19. ✅ done and verified · 🟡 partly · ⏳ owner's step.

`task dod` is `scripts/dod-check.mjs`, the automated end-to-end check against the running cluster: **19 of 19** on the local cluster with NetworkPolicies on, and **19 of 19 over HTTPS** on the production rehearsal.

## User stories: admin

| Story | | Where | Verified by |
|---|---|---|---|
| See registered MCP servers with status (Connected / Unreachable / Disabled) and their tools | ✅ | Dashboard **Servers** (`apps/dashboard/src/pages/ServersPage.tsx`), status kept by `mcp/upstream/connection.ts` | `task dod` (status and tool counts), UI walkthrough, [screenshot](screenshots/02-servers.png) |
| The WooCommerce MCP server already registered as the first server | ✅ | First-boot seed `woo` (`charts/ahjin/values.yaml` → `modules/servers/seed.ts`) | `task dod`: "WooCommerce MCP server is registered and connected" |
| Add another server by URL and credential; edit, disable or remove it | ✅ | **Servers → Add server / Edit / switch / Remove server**; `modules/servers` | Gateway end-to-end tests (`mcp/gateway.test.ts`), UI walkthrough, `task dod` (disable) |
| Invite team members; issue or revoke their API keys | ✅ | **Members** (invitation links, roles, per-member keys) | Gateway tests; `task dod` invites users A and B through the API and revokes B's key |
| An audit log of every tool call: who, server and tool, when, how long, success | ✅ | **Audit log** page; `modules/audit` | `task dod` checks A's and B's entries; [screenshot](screenshots/13-audit.png) |

## User stories: member

| Story | | Where | Verified by |
|---|---|---|---|
| Generate my own API key | ✅ | **API keys → New key** | `task dod`, UI walkthrough |
| One gateway URL + my key in Claude Code or Cursor shows every enabled server's tools | ✅ | `/mcp` (`mcp/endpoint.ts`); snippets per client (`lib/snippets.ts`) | `task dod` (MCP SDK client sees 21 tools from 3 servers); Claude Code in spike B and the manual checklist |
| Use the chat agent with the same tools | ✅ | **Chat**; `modules/chat` calls the gateway's own `/mcp` | `task dod` (chat as user A), chat tests over real HTTP |
| Never see or need upstream credentials | ✅ | Write-only credentials, no URLs for members, no passthrough | `task dod` ("members never see upstream URLs or credentials"); gateway tests scan responses and the database |

## Definition of done

| Check | | Verified by |
|---|---|---|
| Storefront: add to cart, check out with cash on delivery | ✅ | `task dod` (Store API checkout), [manual checklist](runbooks/dod-manual.md#store) |
| The order is visible in WooCommerce admin | ✅ | `task dod` (order read back as the store admin); manual checklist |
| User A: the agent creates a product; it appears on the storefront | ✅ | `task dod` (`woo__create_product`, then the product page) |
| User A: an order placed by hand; "what orders came in today?" returns it | ✅ | `task dod` (`woo__list_orders` with `period: today`) |
| User B: connect Claude Code, Cursor or MCP Inspector with only the URL and B's key | ✅ | `task dod` (MCP SDK client), [manual checklist](runbooks/dod-manual.md#external-mcp-client-as-user-b) with Claude Code |
| User B: sees the tools of every enabled server and asks the orders question | ✅ | `task dod` (21 tools; orders found) |
| User B: one prompt that needs tools from two servers | ✅ | `task dod` (`woo__get_order` total → `fx__convert_currency`) |
| Revoke B's key; the next call is rejected | ✅ | `task dod` (401 `invalid_token`, audited `denied_auth`) |
| Disable one server; its tools disappear from the chat agent and the external client | ✅ | `task dod` (client list, direct call, chat turn) |
| Kill one upstream's pod; others keep working; the dashboard shows it unreachable | ✅ | `task dod` (fx scaled to 0 → `CONNECTION_REFUSED`, woo still answers, then reconnects) |
| Every call above in the audit log under the right user | ✅ | `task dod` (A: `chat_agent` entries; B: success, timeout, rejected_disabled, denied_auth; a member sees only their own) |

## Requirements: Kubernetes and Helm

| Requirement | | Where | Verified by |
|---|---|---|---|
| Runs on local Kubernetes (Kind, k3d or Minikube) | ✅ | k3d (`deploy/k3d/cluster.yaml`) | Everything above |
| Deployable to a production-like VPS (k3s) with the same Helm charts | 🟡 | `values-prod.yaml`, [runbooks/vps.md](runbooks/vps.md), `task deploy:prod` | Production rehearsal on a fresh single-node k3s with the production values and CI's GHCR images, over HTTPS: `task dod` 19/19. A live VPS is deferred by the owner |
| Helm only; local and production differences through values files | ✅ | `charts/ahjin` with `values-local.yaml`, `values-prod.yaml` (`values-rehearsal.yaml` for the rehearsal) | CI renders both; `task verify:k8s` renders all three |
| Everything runs in the cluster: store, its database, the WooCommerce MCP server, the gateway, the dashboard | ✅ | One release in namespace `ahjin` | `kubectl -n ahjin get pods` |
| Persistent storage for the store's database and WordPress content | ✅ | PVCs `data-mariadb-0` and `wp-uploads` (kept on uninstall); Postgres too | Data survived pod restarts, cluster restarts and the rollback drill |
| Storefront and dashboard exposed through Ingress with stable URLs; local domain approach documented | ✅ | Ingresses `store` and `app`; [local-domains.md](local-domains.md), [system-design §7.4](system-design.md#74-local-domain-approach) | Used by every check |
| Readiness and liveness checks on every workload; requests and limits | ✅ | All templates | `task verify:k8s` (CI) fails on any gap; Jobs are bounded by `activeDeadlineSeconds` instead |
| No hardcoded secrets; credentials in Kubernetes Secrets | ✅ | `scripts/secrets.mjs` from a git-ignored `.env.local`; the chart references Secret names only | gitleaks over the full history in CI; `verify:k8s` scans values files |

## Requirements: WooCommerce MCP server

| Requirement | | Where | Verified by |
|---|---|---|---|
| Written for this project; no existing WooCommerce MCP server or plugin | ✅ | `apps/woo-mcp` on `packages/mcp-kit` | Source |
| Speaks MCP over Streamable HTTP | ✅ | `packages/mcp-kit/src/server.ts` | mcp-kit and woo-mcp tests; the gateway connects to it |
| Tools: list products, create product, list orders, get order, update order status | ✅ | `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` (plus `get_product`, `server_info`) in `apps/woo-mcp/src/tools.ts` | woo-mcp tests against a fake store; in-cluster checks; `task dod` |
| Not reachable from outside the cluster; only the gateway can call it | ✅ | ClusterIP only, no Ingress template in the `mcp-server` chart, NetworkPolicy (gateway only), static bearer credential, Host allow-list | Live tests: a pod with any other label is blocked; the gateway label connects |
| Document how it talks to the store, and why | ✅ | [system-design §2.1](system-design.md#21-how-woo-mcp-talks-to-the-store), [ADR-0002](adr/0002-woocommerce-rest-basic-auth.md) | |

## Requirements: gateway

| Requirement | | Where | Verified by |
|---|---|---|---|
| Admins add, edit, disable and remove upstream servers (Streamable HTTP), each with an optional static credential (header or bearer) | ✅ | `modules/servers`; auth types `none`, `bearer`, `header` | Gateway tests; seeds use bearer (woo, github) and header (fx) |
| One MCP endpoint; listing returns every enabled server's tools; calls are routed to the right server | ✅ | `mcp/endpoint.ts`, `mcp/catalog.ts`, `mcp/invoke.ts` | Gateway tests; `task dod` |
| Same tool name on two servers handled by a documented scheme | ✅ | `<slug>__<tool>` (`mcp/naming.ts`); [system-design §3.2](system-design.md#32-naming-scheme-and-collisions) | `naming.test.ts`; `woo__server_info` and `fx__server_info` live |
| A slow or dead upstream doesn't break listing or other servers; calls time out with a clear error | ✅ | Per-server timeouts, health checks, catalog from memory | Gateway tests (slow upstream, killed and revived); `task dod` (dead fx) |
| Upstream credentials stay server-side, never sent to a browser or client | ✅ | AES-256-GCM, write-only API, no passthrough | Gateway tests; `task dod` |
| At least three upstream servers: the WooCommerce one plus two others | ✅ | `woo` (7 tools), `fx` (ours, 4), `github` (GitHub's hosted MCP, 10) | `task dod`: "at least three upstream servers connected" |

## Requirements: team and access

| Requirement | | Where | Verified by |
|---|---|---|---|
| At least two roles: admin and member | ✅ | `modules/auth`, server-side checks in every route | Tests call admin routes as a member and get 403 |
| A personal API key per user; revocable; stored hashed | ✅ | `modules/keys`: HMAC-SHA256 with a pepper, shown once | Tests; `task dod` |
| Every tool call audited (user, server, tool, timestamp, duration, outcome), visible in the dashboard | ✅ | `modules/audit`, **Audit log** page | `task dod`, chat test |

## Requirements: chat agent

| Requirement | | Where | Verified by |
|---|---|---|---|
| A chat in the dashboard using an LLM to call tools through the gateway, showing which tools it called | ✅ | `modules/chat`, `ChatPage.tsx` (a card per tool call) | `task dod`, UI walkthrough, [screenshot](screenshots/12-chat-answer.png) |
| Acts as the logged-in user; its calls are audited under that user | ✅ | Short-lived chat token bound to the session; channel `chat_agent` | `task dod`, chat test |
| Any model or provider | ✅ | Groq `openai/gpt-oss-120b`, Gemini `gemini-2.5-flash` fallback | |
| LLM API keys follow the secrets rule | ✅ | Secret `llm`, from `.env.local` | gitleaks |

## Deliverables in the repo

| Deliverable | | Where |
|---|---|---|
| README: local setup | ✅ | [README → Local setup](../README.md#local-setup) |
| README: VPS or production-like setup | ✅ | [README → Production-like and VPS setup](../README.md#production-like-and-vps-setup), [runbooks/vps.md](runbooks/vps.md) |
| README: place an order, connect an external MCP client, use the chat agent | ✅ | [README → Using it](../README.md#using-it) |
| Source: dashboard, backend and gateway, WooCommerce MCP server, chat agent | ✅ | `apps/dashboard`, `apps/gateway` (chat in `src/modules/chat`), `apps/woo-mcp` |
| Helm charts and values files (local and production) | ✅ | `charts/ahjin` |
| "System design and tradeoffs" note | ✅ | [system-design.md](system-design.md) |
| Threat model note (shared credentials, no token passthrough, manipulative tool descriptions, member versus member) | ✅ | [threat-model.md](threat-model.md) |
| Bonus and stand-out items attempted, and where | ✅ | [README → Extras and stand-out items](../README.md#extras-and-stand-out-items) |

## Demo video and submission

| Item | | Where |
|---|---|---|
| Demo video covering every listed topic | ⏳ owner | Script: [demo-script.md](demo-script.md); `task demo:reset` prepares the state |
| Submit the video and the repo through the form | ⏳ owner | https://forms.gle/nftwgyNeenSDmiRb6 |
