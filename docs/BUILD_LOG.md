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
| 2 | Local Kubernetes platform | ✅ | k3d cluster, registry, Traefik timeouts, nip.io domains, NetworkPolicy proven |
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
| k3s (in k3d) | v1.35.5+k3s1 | Pinned in `deploy/k3d/cluster.yaml`; containerd 2.2.3 |
| Traefik | 3.6.13 | Bundled with k3s |
| local-path provisioner | v0.0.36 | Default StorageClass `local-path` |

---

## Resume or debug

```sh
# from the repository root (URUMI.ai/Project)
pnpm install            # restore dependencies from the lockfile
task check              # lint, typecheck and test every package
pnpm turbo run lint typecheck test --force   # same, ignoring Turborepo's cache

task cluster:up         # create the k3d cluster + registry (no-op if it exists)
task chart:lint         # helm lint + render with local and prod values
task deploy:local       # helm upgrade --install urumi on the local cluster
task cluster:reset      # delete and recreate the cluster (loses all cluster data)
```

Useful cluster checks:
```sh
kubectl config current-context                     # should be k3d-urumi
kubectl get nodes                                  # 1 server + 1 agent, Ready
kubectl -n kube-system get deploy traefik          # ingress controller
docker exec k3d-urumi-server-0 cat /etc/rancher/k3s/registries.yaml   # registry mirror
helm -n urumi history urumi                        # release revisions
```

Common problems:
- **`ERR_PNPM_IGNORED_BUILDS`:** pnpm blocks dependency build scripts unless they're listed under `allowBuilds` in `pnpm-workspace.yaml`. Approve one with `pnpm approve-builds <package>`.
- **"unmet peer typescript":** typescript-eslint needs TypeScript `<6.1`. Don't upgrade `typescript` to 7.x until typescript-eslint supports it.
- **Tools not found right after installing them with winget:** open a new terminal. In VS Code, restart VS Code so new PATH entries are picked up.
- **Slow installs:** the repo lives inside OneDrive. Pause OneDrive sync during big installs (risk R3).
- **`http://*.127.0.0.1.nip.io` doesn't load:** check the cluster is running (`k3d cluster list`), that nothing else holds port 80 (`Get-NetTCPConnection -LocalPort 80 -State Listen`), and that nip.io resolves (`nslookup store.127.0.0.1.nip.io`). Offline fallback: see `docs/local-domains.md`.
- **Pod stuck in `ImagePullBackOff` for a local image:** push to `localhost:5001/<name>:<tag>` and reference it as `urumi-registry:5000/<name>:<tag>` in the pod spec.

---

## Log

### 2026-10-15 · Task 2: Local Kubernetes platform · ✅

**What was done**
- `deploy/k3d/cluster.yaml`:
  - Cluster `urumi`: 1 server + 1 agent, k3s pinned to `v1.35.5-k3s1`.
  - Host ports 80 and 443 mapped to the k3d load balancer.
  - Local registry `urumi-registry` on host port 5001.
  - Waits for nodes before returning.
- Umbrella chart skeleton `charts/urumi`:
  - `Chart.yaml`, `values.yaml`, `values-local.yaml`, `values-prod.yaml`, and `values.schema.json` (requires `global.domain` and `global.ingressClassName`).
  - Helpers for standard labels and per-component hosts (`store.<domain>`, `app.<domain>`).
  - `NOTES.txt`.
  - `templates/traefik-config.yaml`: a k3s `HelmChartConfig` that sets Traefik's `readTimeout`/`writeTimeout` to 0 (no limit) and `idleTimeout` to 600 s on both entrypoints. Without it, Traefik v3 cuts SSE streams (`GET /mcp`, `/api/chat`) after 60 s.
- Taskfile targets: `cluster:up` (no-op if the cluster exists), `cluster:down`, `cluster:reset`, `chart:lint`, `deploy:local`.
- CI: a new `chart` job runs `helm lint` with both values files and renders both environments.
- `docs/local-domains.md`: the nip.io approach, hosts-file fallback, port-conflict fallback, and how in-cluster traffic uses Service names.

**Verification**
- `task cluster:up` from nothing: cluster ready in **77 s**. Both nodes are `Ready` on Kubernetes v1.35.5+k3s1 (WSL2 kernel 6.18).
- kube-system: coredns, local-path-provisioner v0.0.36 (default StorageClass), metrics-server and Traefik 3.6.13 all rolled out.
- `task chart:lint`: both values files lint cleanly. `task deploy:local` installed release `urumi` (revision 1) in namespace `urumi`.
- After the deploy, k3s re-ran `helm-install-traefik`. The Traefik pod's args now include `--entryPoints.web.transport.respondingTimeouts.readTimeout=0`, plus the matching `writeTimeout` and `idleTimeout` args, and the same three for `websecure`.
- **Registry, ingress and DNS together:** pushed `traefik/whoami` as `localhost:5001/whoami:check`, deployed it as `urumi-registry:5000/whoami:check` with an Ingress for `hello.127.0.0.1.nip.io`. `curl http://hello.127.0.0.1.nip.io` returned the pod's hostname.
- **NetworkPolicy enforcement** (k3s's built-in controller), with an `outsider` pod and an `insider` pod (`allowed=true`) calling the `hello` Service:

  | Step | outsider | insider |
  |---|---|---|
  | No policy | 200 | — |
  | Deny all ingress | blocked (curl exit 7) | blocked |
  | Allow only `allowed=true` | blocked | 200 |

- The throwaway check resources (namespace `k8s-check`) were deleted afterwards. Their manifests aren't committed.

**Problems and fixes**
1. k3d 5.9 names the registry container `urumi-registry`, not `k3d-urumi-registry` as older k3d versions do. Checked the node's `/etc/rancher/k3s/registries.yaml`: it mirrors both `urumi-registry:5000` and `urumi-registry:5001` to `http://urumi-registry:5000`. **Convention: push to `localhost:5001/…`, reference `urumi-registry:5000/…` in manifests.** The comment in `cluster.yaml` was corrected.
2. PowerShell mangles `\n` inside kubectl JSONPath expressions; switched to splitting the output in PowerShell instead. This only affects interactive debugging.

**Follow-ups**
- `images:build` and `secrets` Taskfile targets arrive with the first image and Secrets (Task 4).
- VPS provisioning was removed from this task (plan v1.2); see Task 31.

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
