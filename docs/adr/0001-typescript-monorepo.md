# ADR-0001: TypeScript monorepo for every service and the dashboard

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

The system has a React dashboard, a gateway (REST API, aggregating MCP endpoint and chat module) and two MCP servers. They share schemas (API payloads, tool inputs, enums such as roles and audit outcomes). The official MCP SDK with the most complete Streamable HTTP client and server support is the TypeScript one.

## Decision

- One pnpm workspace with Turborepo: `apps/*` for deployables, `packages/*` for shared code.
- TypeScript in strict mode on Node.js 24 LTS everywhere.
- Shared packages export their TypeScript source directly (`"exports": "./src/index.ts"`). Apps bundle what they import when they are built, so packages need no build step of their own.
- **TypeScript is pinned to 6.0.x.** TypeScript 7.0 (the native Go compiler) is npm's `latest`, but typescript-eslint supports only `<6.1`. We move to 7.x once the lint tooling supports it.

## Consequences

- One toolchain, one lockfile and one CI job for everything.
- Zod schemas in `packages/contracts` drive both server validation and dashboard forms.
- Pinning TypeScript to 6.0 means we don't get TypeScript 7's faster type checking yet.

## Alternatives considered

- **Python (FastAPI) backend with a React dashboard:** a solid MCP SDK, but two languages and no shared types.
- **Go:** small binaries, but a younger MCP SDK and the same two-language split.
- **Building each shared package with `tsc`:** more build steps and watch processes for no runtime benefit, since apps bundle their dependencies anyway.
