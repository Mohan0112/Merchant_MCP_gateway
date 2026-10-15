# ADR-0003: MCP SDK v2 with a stateless gateway endpoint

- **Status:** Accepted (validated by Spike B, see `docs/spikes.md`). Supersedes plan v1.2's ADR-013 (stateful `Mcp-Session-Id` sessions).
- **Date:** 2026-10-15

## Context

The plan assumed the v1 MCP SDK and a stateful gateway with an in-memory session map. Since then the MCP TypeScript SDK moved to **v2 split packages** implementing the **2026-07-28 specification**. Its HTTP entry point, `createMcpHandler(factory)`, builds a fresh server per request. It serves both 2026 clients (with `subscriptions/listen` change streams) and 2025-era clients (statelessly, without a standalone GET stream).

## Decision

- Use `@modelcontextprotocol/server`, `/client`, `/node` and `/fastify` (v2) everywhere.
- **Gateway `/mcp`:**
  - A Fastify route verifies the bearer credential (API key or chat token) and passes `authInfo`.
  - `createMcpHandler(factory)` calls the factory per request with `{ era, authInfo }`. The factory builds a low-level `Server` whose `tools/list` returns the caller's view of the catalog and whose `tools/call` runs `invokeTool()`.
  - On catalog changes the gateway calls `handler.notify.toolsChanged()`.
- **Upstream connections:** one `Client` per upstream server with `versionNegotiation: { mode: 'auto' }` and the upstream's static credential in `requestInit.headers`. Per-call `timeout` comes from the server's settings.
- **Our MCP servers:** `McpServer.registerTool` with Zod v4 schemas behind the same stateless handler, mounted with `createMcpFastifyApp` and host allow-lists.

## Consequences

- No session map: every request re-authenticates, so key revocation applies to the very next request. Nothing is lost on restart.
- **Horizontal scaling is close to free:** replicas share nothing except the change-event bus, which is pluggable (`ServerEventBus`). Phase 2 Task 25 swaps the in-memory bus for one backed by Valkey/Redis.
- **Clients:**
  - Claude Code 2.1.300 negotiates the 2026 protocol and receives live `tools/list_changed` events.
  - 2025-era clients (MCP Inspector 2.11 CLI) see changes on their next `tools/list`. Calls to disabled servers return a clear error either way.
- We depend on a newer SDK line, so versions are pinned in the lockfile, and the upstream `Client` is wrapped behind our `UpstreamClient` interface.

## Alternatives considered

- **v1 SDK (`@modelcontextprotocol/sdk` 1.32) with stateful sessions:** works, but it's the legacy line, needs a session map, and needs sticky routing or a shared session store to scale.
- **Sessionful legacy branch** (`isLegacyRequest` in front of a `NodeStreamableHTTPServerTransport` session map): would push `list_changed` to 2025-era clients too. Not needed now that Claude Code speaks the 2026 protocol; kept as an option.
