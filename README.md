# Merchant MCP Gateway

WooCommerce hosting with a **team MCP gateway** on Kubernetes. An admin registers MCP servers once in a dashboard. Every team member then uses all of their tools through **one MCP endpoint and one personal API key**, from Claude Code, Cursor or MCP Inspector, or through a chat agent in the dashboard. A WooCommerce store, running in the same cluster, is the first data source.

> **Status: under construction.** See [docs/BUILD_LOG.md](docs/BUILD_LOG.md) for what's built so far and [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the full design and task plan. Full setup instructions arrive in Task 20.

## Repository layout

| Path                 | What it is                                                                    |
| -------------------- | ----------------------------------------------------------------------------- |
| `apps/`              | Deployable services: gateway, dashboard, woo-mcp, fx-mcp (added task by task) |
| `packages/contracts` | Zod schemas and types shared by the dashboard, gateway and MCP servers        |
| `packages/logger`    | pino logger with central secret redaction                                     |
| `charts/`            | Helm chart (`charts/urumi`) with local and production values                  |
| `docs/`              | Plan, build log, ADRs, runbooks                                               |

## Developer quick start

Prerequisites: Node.js 24, pnpm, Docker Desktop, [Task](https://taskfile.dev).

```sh
pnpm install
task check      # lint, typecheck and test every package
```

Secrets and API keys go in `.env.local` (git-ignored). Copy `.env.example` and fill it in.
