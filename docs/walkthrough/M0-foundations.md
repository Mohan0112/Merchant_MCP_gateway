# Walkthrough M0: Foundations (Tasks 1–3)

A short guide to what exists after the first milestone, why it's built this way, and questions you may be asked in the Round 2 walkthrough.

## What exists

| Piece | Where | One-line explanation |
|---|---|---|
| Monorepo | `package.json`, `pnpm-workspace.yaml`, `turbo.json` | One repo for every service; pnpm installs, Turborepo runs `lint`/`typecheck`/`test`/`build` per package and caches results |
| Shared schemas | `packages/contracts` | Zod schemas used by both the dashboard and the backend (slug rules, roles, audit outcomes, API key format) |
| Logger | `packages/logger` | pino JSON logs; secrets (`authorization`, `password`, `token`…) are replaced with `[REDACTED]` centrally |
| Secret scanning | `.gitleaks.toml`, CI `secrets-scan` | Blocks committed secrets, including our own `amcp_…` API key format |
| CI | `.github/workflows/ci.yml` | Lint/typecheck/test/build, Helm lint and render (local and prod values), gitleaks over full history |
| Local cluster | `deploy/k3d/cluster.yaml` | k3s in Docker (k3d): 1 server + 1 agent, Traefik ingress on ports 80/443, local image registry on 5001 |
| Helm chart | `charts/ahjin` | One umbrella chart; for now only the Traefik timeout override, components are added task by task |
| Decisions | `docs/adr/0001…0003`, `docs/spikes.md` | Why TypeScript 6, why WooCommerce REST + Basic Auth, why MCP SDK v2 stateless |

## How a request reaches a pod (local)

```text
browser → store.127.0.0.1.nip.io (DNS says 127.0.0.1)
        → laptop port 80 → k3d load balancer → Traefik → Service → Pod
```

`nip.io` is a public DNS service that maps `anything.127.0.0.1.nip.io` to `127.0.0.1`, so no hosts-file edits are needed.

## Key design decisions, in one sentence each

- **TypeScript everywhere, pinned to 6.0:** one language for UI and services; 7.0 isn't supported by the linter yet.
- **k3d locally, k3s on a VPS:** the same Kubernetes distribution, ingress, storage and NetworkPolicy engine in both places, so only values files differ.
- **WooCommerce via REST + Basic Auth:** the official API runs WooCommerce's business logic. The mu-plugin enables Basic Auth only for requests addressed to the internal Service name, which outside traffic can't send.
- **MCP SDK v2, stateless gateway:** the gateway builds a fresh MCP server *per request* for the authenticated user. Revoking a key takes effect on the next request, and scaling out doesn't need sticky sessions.
- **Groq `openai/gpt-oss-120b`:** free, fast (≈2 s for a two-tool question), correct tool chaining; Gemini as fallback.

## Likely questions and short answers

**Why did the first CI run fail?**
The gitleaks GitHub Action scans the commit range `first^..last`, and on a brand-new repository the first commit has no parent. We switched to running the gitleaks container over the whole history.

**How do you know NetworkPolicies actually work on k3d?**
Task 2 tested it: a pod could call a service, then a deny-all policy blocked it, then an allow-by-label policy let only the labelled pod through (see BUILD_LOG Task 2).

**Isn't faking HTTPS in WordPress dangerous?**
It only applies when the `Host` header is the internal Service name. Traefik only routes the public store host to WordPress, and NetworkPolicy only lets Traefik and `woo-mcp` reach the pod. Spike A showed the same credentials with the public host get 401.

**What happens to a client like MCP Inspector when a server is disabled?**
It uses the 2025 protocol, so it gets no push. It sees the change on its next `tools/list`, and calling a disabled tool returns "disabled by an admin". Claude Code uses the 2026 protocol and gets the change pushed live.

**Why not keep MCP sessions like the original plan?**
The current SDK serves each request statelessly. That removes a whole class of bugs (session leaks, sticky routing, lost state on restart) and still supports push notifications through subscriptions.
