# Build log

A running record of what has been built, how it was verified, and what went wrong along the way. It's written for anyone who needs to pick up the work, review it or debug it. The design and task list live in [PROJECT_PLAN.md](PROJECT_PLAN.md); this file tracks **execution**.

**How to read it**
- **Status board:** where every task stands right now.
- **Environment:** tool versions the build was verified with.
- **Resume or debug:** the commands to get back to a working state.
- **Log:** one entry per task, newest first. Each entry lists what was done, how it was verified, problems hit and how they were fixed, and follow-ups.

---

## Status board

Legend: ✅ done · 🔄 in progress · ⏳ not started · ⏸️ deferred

| Task | Title | Status | Notes |
|---|---|---|---|
| 1 | Repository and engineering baseline | ✅ | Monorepo, lint, typecheck, tests, CI workflow, gitleaks rule |
| 2 | Local Kubernetes platform | ⏳ | |
| 3 | Technical spikes | ⏳ | |
| 4 | Store image and sub-chart | ⏳ | |
| 5 | Store bootstrap and checkout | ⏳ | |
| 6 | MCP server kit and sub-chart | ⏳ | |
| 7 | WooCommerce MCP server | ⏳ | |
| 8 | Additional upstreams (fx-mcp, GitHub) | ⏳ | |
| 9 | Gateway skeleton and platform sub-chart | ⏳ | |
| 10 | Identity and access | ⏳ | |
| 11 | Upstream registry and connection manager | ⏳ | |
| 12 | Aggregating MCP endpoint and audit log | ⏳ | |
| 13 | Dashboard foundation | ⏳ | |
| 14 | Dashboard screens | ⏳ | |
| 15 | Chat module | ⏳ | |
| 16 | Chat UI | ⏳ | |
| 17 | Kubernetes production readiness | ⏳ | |
| 18 | Definition-of-Done check and CI/CD | ⏳ | |
| 19 | Production rehearsal (no VPS) | ⏳ | |
| 20 | Documentation | ⏳ | |
| 21 | Demo video | ⏳ | Owner records |
| 22–30 | Phase 2 extras | ⏳ | Start after Task 18 passes |
| 31 | Live VPS deployment | ⏸️ | Deferred by the owner |

---

## Environment

Verified on the owner's laptop (Windows 11, 16 GB RAM, 12 logical cores).

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.19.0 | |
| pnpm | 12.11.2 | Pinned via `packageManager` in `package.json` |
| TypeScript | 6.0.3 | **Pinned below 7.0**, see ADR-0001 |
| ESLint | 10.12.0 | typescript-eslint 8.71.2 |
| Vitest | 5.0.4 | |
| Turborepo | 2.11.8 | |
| Docker Desktop | Engine 29.8.2 | WSL2 backend; 12 CPUs and about 7.6 GiB available to containers |
| k3d / Helm / Task / gh | 5.9.0 / 4.3.1 / 3.54.0 / 2.102.0 | Installed with winget |
| git | 2.45.2 | |

---

## Resume or debug

```sh
# from the repository root (URUMI.ai/Project)
pnpm install            # restore dependencies from the lockfile
task check              # lint, typecheck and test every package
pnpm turbo run lint typecheck test --force   # same, ignoring Turborepo's cache
```

Common problems:
- **`ERR_PNPM_IGNORED_BUILDS`:** pnpm blocks dependency build scripts unless they're listed under `allowBuilds` in `pnpm-workspace.yaml`. Approve one with `pnpm approve-builds <package>`.
- **"unmet peer typescript":** typescript-eslint needs TypeScript `<6.1`. Don't upgrade `typescript` to 7.x until typescript-eslint supports it.
- **Tools not found right after installing them with winget:** open a new terminal. In VS Code, restart VS Code so new PATH entries are picked up.
- **Slow installs:** the repo lives inside OneDrive. Pause OneDrive sync during big installs (risk R3).

---

## Log

### 2026-10-15 · Task 1: Repository and engineering baseline · ✅

**What was done**
- `git init` on branch `main`. Remote repo: `github.com/Mohan0112/Merchant_MCP_gateway` (public, empty at this point).
- pnpm workspace (`apps/*`, `packages/*`) with Turborepo tasks `lint`, `typecheck`, `test`, `build`.
- Shared strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, Bundler module resolution).
- ESLint flat config: typescript-eslint recommended, `import-x/no-cycle` (feature modules must not import each other in a loop), `consistent-type-imports`. Prettier for formatting; hand-written docs under `docs/` are excluded from Prettier.
- `packages/contracts`: Zod schemas shared across apps:
  - `SlugSchema` (tool-name prefix rules from ADR-003).
  - Roles, upstream auth types and statuses, audit channels and outcomes.
  - The API key format (`umcp_<8-char prefix>_<43-char secret>`) and `apiKeyPrefix()`.
- `packages/logger`: `createLogger(service)` built on pino, with central redaction of `authorization`, `cookie`, `x-api-key`, `password`, `credential`, `apiKey`, `token` and `secret` (top level and one level deep).
- `.gitleaks.toml`: the default rules plus a rule for gateway API keys. Tests build sample keys at runtime, so no literal key is ever committed.
- GitHub Actions `ci.yml`: a `checks` job (install, lint, typecheck, test, build) and a `secrets-scan` job (gitleaks over full history).
- `Taskfile.yml` (install, check, build, format), README stub, PR template, `.editorconfig`, `.gitattributes` (LF line endings), `.nvmrc`.
- ADR template and ADR-0001 (TypeScript monorepo, TypeScript pinned to 6.0).
- Copied the plan into `docs/PROJECT_PLAN.md`; this copy is now the canonical one.

**Verification**
- `pnpm turbo run lint typecheck test`: 6 of 6 tasks pass (contracts: slug and key tests; logger: redaction tests).
- `prettier --check .`: all files formatted.
- gitleaks (Docker image `ghcr.io/gitleaks/gitleaks`) run with our config against a scratch folder containing a fake `umcp_` key: **1 leak found** (exit code 1), so the custom rule works.
- `.env.local` is ignored by git; only the empty `.env.example` is tracked.

**Problems and fixes**
1. **npm's `latest` TypeScript is 7.0.2** (the native Go compiler). typescript-eslint 8.71 declares `typescript >=4.8.4 <6.1.0`. Fix: pinned `typescript@~6.0.3`; recorded in ADR-0001.
2. **`@types/node` resolved to v26** while the runtime is Node 24. Fix: pinned `@types/node@^24`.
3. **`ERR_PNPM_IGNORED_BUILDS` for `unrs-resolver`** (native resolver used by `eslint-import-resolver-typescript`). Fix: `pnpm approve-builds unrs-resolver`, which added `allowBuilds` to `pnpm-workspace.yaml`.
4. Turborepo warned that `test` had no output files. Fix: `outputs: []` for `test`.
5. The first `pnpm install` took about 200 s, probably because of OneDrive sync. Watching it; no action yet.

**Follow-ups**
- CI runs for the first time after the first push (needs the owner's go-ahead to push to the public repo).
- `packages/mcp-kit` is created in Task 6, when it gets real content.
