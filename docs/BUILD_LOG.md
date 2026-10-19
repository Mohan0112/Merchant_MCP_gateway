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
| 3 | Technical spikes | ✅ | Woo Basic Auth ✅, MCP SDK v2 gateway + Claude Code ✅, Groq/Gemini tool loop ✅ |
| 4 | Store image and sub-chart | ✅ | WordPress 7.1.3 + WooCommerce 11.2.1 image (non-root, :8080), MariaDB 11.4.13, PVCs, Ingress, Secrets script |
| 5 | Store bootstrap and checkout | ✅ | Idempotent bootstrap Job, wp-cron CronJob, COD checkout via Store API → order #14 visible in admin |
| 6 | MCP server kit and sub-chart | ✅ | `@urumi/mcp-kit` (11 tests), generic `mcp-server` chart (no Ingress, gateway-only NetworkPolicy), shared Node image |
| 7 | WooCommerce MCP server | ✅ | 6 tools + server_info, 23 tests; in-cluster: today's orders in IST, product created and visible on storefront |
| 8 | Additional upstreams (fx-mcp, GitHub) | ✅ | fx-mcp deployed (live rates, header credential); GitHub Issues toolset verified with the PAT |
| 9 | Gateway skeleton and platform sub-chart | ✅ | Fastify app, schema v1 (8 tables), migrate initContainer, PostgreSQL 17.11, Ingress app.&lt;domain&gt;/api,/mcp |
| 10 | Identity and access | ✅ | Sessions, invites, roles, API keys (HMAC), CSRF guard, login throttling; 20 DB-backed tests |
| 11 | Upstream registry and connection manager | ✅ | Health checks, classified unreachable reasons, backoff; admin CRUD + test connection; credentials AES-256-GCM, write-only |
| 12 | Aggregating MCP endpoint and audit log | ✅ | One `/mcp`, `<slug>__<tool>` names, per-server timeouts, clear errors, `list_changed`; audit log with filters |
| 13 | Dashboard foundation | ✅ | React 19 + Vite 8 + React Router 8 + TanStack Query; nginx-unprivileged image; Ingress `/` |
| 14 | Dashboard screens | ✅ | Servers (status, tools, add/edit/disable/remove), members and invitations, API keys with client snippets, audit log |
| 15 | Chat module | ✅ | Groq `gpt-oss-120b` with Gemini fallback; tool loop through the gateway's own `/mcp` as the signed-in user |
| 16 | Chat UI | ✅ | Streaming answers with a card per tool call (arguments, result preview, duration) |
| 17 | Kubernetes production readiness | ✅ | Default-deny ingress + 7 allow policies (14/14 live connection tests), `task verify:k8s` in CI, NOTES fixed |
| 18 | Definition-of-Done check and CI/CD | ✅ | `task dod` 19/19; CI pushes five public images to GHCR per commit; chart release on tags; `task demo:reset` |
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
task secrets            # create/sync Kubernetes Secrets from .env.local (prints names only)
task images:build       # build + push images to the local registry (localhost:5001)
task logins             # print generated wp-admin / dashboard logins (local only)
task chart:lint         # helm lint + render with local and prod values
task verify:k8s         # probes, requests/limits, non-root, NetworkPolicies, kubeconform (needs Docker)
task deploy:local       # helm upgrade --install urumi on the local cluster
task cluster:reset      # delete and recreate the cluster (loses all cluster data)
task dod                # the brief's definition of done, end to end, against the running cluster
task dod -- --skip-chat # same without the LLM steps
task demo:reset         # clean demo state: no orders, sample products, all servers on, fresh users A and B, empty audit log
```

`task dod` never touches real accounts. It inserts a temporary admin into PostgreSQL and invites users A and B through the API. At the end it deletes them, their keys and audit rows, and the store's test products and orders, so "orders today" stays clean for the demo.

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
- **Tools not found right after installing them with winget:** open a new terminal. In VS Code, restart VS Code so new PATH entries are picked up. winget adds each package's own folder (`%LOCALAPPDATA%\Microsoft\WinGet\Packages\<Package>\…`) to the user PATH, not a shared links folder, so an already-open Git Bash needs those folders added by hand. One way in Git Bash: `for d in "$LOCALAPPDATA"/Microsoft/WinGet/Packages/{Helm.Helm*/windows-amd64,Task.Task*,k3d.k3d*,pnpm.pnpm*}; do PATH="$d:$PATH"; done`. Turborepo needs `pnpm` itself on PATH (`corepack pnpm` alone fails with "Unable to find package manager binary").
- **Slow installs:** the repo lives inside OneDrive. Pause OneDrive sync during big installs (risk R3).
- **`http://*.127.0.0.1.nip.io` doesn't load:** check the cluster is running (`k3d cluster list`), that nothing else holds port 80 (`Get-NetTCPConnection -LocalPort 80 -State Listen`), and that nip.io resolves (`nslookup store.127.0.0.1.nip.io`). Offline fallback: see `docs/local-domains.md`.
- **Pod stuck in `ImagePullBackOff` for a local image:** push to `localhost:5001/<name>:<tag>` and reference it as `urumi-registry:5000/<name>:<tag>` in the pod spec.
- **A pod is stuck in `CreateContainerConfigError`:** a referenced Secret or key is missing. Run `task secrets` and check `kubectl -n urumi describe pod <pod>`.
- **A brand-new pod can't reach a NetworkPolicy-protected service for its first second or two.** k3s's policy engine (kube-router) adds a new pod's IP to the allow-list a moment after the pod starts; measured: the first attempt is refused, the next one a second later succeeds. Probe pods must wait before testing, and anything short-lived must retry its first connection (the wp-cron job waits for MariaDB for exactly this reason).
- **Is a connection allowed by the NetworkPolicies?** Start a throwaway pod with the label of the component you want to impersonate and try it: `kubectl -n urumi run np-test --image=busybox:1.37.0 --labels=app.kubernetes.io/name=gateway --restart=Never -- sleep 300`, wait a few seconds, then `kubectl -n urumi exec np-test -- nc -z -w 3 postgres 5432` (exit 0 = allowed). Delete the pod afterwards.
- **Docker Desktop memory on the laptop:** WSL is capped at 5 GB in `%UserProfile%\.wslconfig` (`[wsl2] memory=5GB`). The stack itself needs about 2 GB; the rest of WSL's figure is Linux file cache. To hand the cache back to Windows immediately: `docker exec k3d-urumi-server-0 sh -c 'sync; echo 1 > /proc/sys/vm/drop_caches'`.
- **Testing an MCP server by hand from inside the cluster:** run a pod labelled `app.kubernetes.io/name=gateway` (the only label the policy admits), inject the credential with `valueFrom.secretKeyRef` through `--overrides`, wait for the policy to sync, then pipe a script over stdin (`kubectl exec -i pod -- sh < script.sh`).
- **`helm upgrade` fails with "conflict … with kubectl-patch":** Helm 4 applies manifests server-side and tracks field owners. Someone hand-edited a Helm-managed object, so `kubectl` co-owns a field. Don't hand-edit Helm-managed objects. To recover once, run `helm upgrade … --force-conflicts`.
- **Gateway database tests:** they run only when `TEST_DATABASE_URL` is set. Locally: `docker run -d --name urumi-test-pg -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17.11-alpine`, then `TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres pnpm turbo run test --filter=gateway`. CI provides a Postgres service container. The variable is declared in `turbo.json`, because Turborepo's strict env mode hides undeclared variables.
- **Inspecting the platform database:** `echo '\dt' | kubectl -n urumi exec -i postgres-0 -- psql -U urumi -d urumi`.
- **Running SQL by hand:** pipe it over stdin so PowerShell can't mangle quotes:
  `echo "SELECT 1;" | kubectl -n urumi exec -i mariadb-0 -- sh -c 'mariadb -uwordpress -p"$MARIADB_PASSWORD" wordpress'`

---

## Log

### 2026-10-19 · Task 18: CI image publishing, chart release and demo reset · ✅

**What was done**
- **`.github/workflows/images.yml`:** on every push to `main`, a matrix job builds the five images exactly like the Taskfile does (wordpress, woo-mcp, fx-mcp, gateway, dashboard) for linux/amd64.
  - Pushes to `ghcr.io/mohan0112/merchant_mcp_gateway/<app>`, tagged with the full git SHA and `main`.
  - Uses the GitHub Actions layer cache, one scope per image.
  - Sets the `org.opencontainers.image.source` label, which links each package to the repo.
- **`.github/workflows/release.yml`:** a `vX.Y.Z` tag packages `charts/urumi` at that version and creates a GitHub release with the chart attached and generated notes.
- **`scripts/demo-reset.mjs` (`task demo:reset`, which asks for confirmation first):**
  - Store: deletes every order, and every product except the four seeded samples (matched by SKU).
  - Servers: makes sure `fx-mcp` runs, enables every server, and waits until all are connected.
  - Users: removes users left over by interrupted runs, then recreates the members `user-a@example.com` and `user-b@example.com` with new passwords.
  - Audit log: empties it.
  - Like `task dod`, it works through a temporary admin and never touches real accounts.
  - The demo logins go to Secret `demo-users`. `task logins` prints them; the script prints them only when run in a terminal.
- **`scripts/lib/cluster.mjs`:** the plumbing shared by `dod-check` and `demo-reset`, moved out of `dod-check.mjs` (105 lines fewer there):
  - option parsing, `kubectl`, `psql` and WP-CLI helpers, the dashboard session
  - temporary admin and invitation helpers
  - a new `--insecure` option for self-signed certificates (the production rehearsal)

**Verification**
- Both workflows pass actionlint 1.7.7, and every pinned action tag exists.
- First run on `c3ecdb3`: all five image jobs succeeded and CI is green. An **anonymous** pull of `gateway` and `wordpress` at that SHA returns HTTP 200, so the packages are public and a VPS needs no pull secret.
- `demo:reset` on the local cluster:
  - deleted the leftover order and product, kept the 4 samples, all 3 servers connected
  - users A and B created; both sign in as members, without a forced password change
  - the owner's admin account is untouched
  - a second run gives the same result
- `dod-check` after the refactor: 16 of 16 with `--skip-chat`.

**Problems and fixes**
1. **The first `demo:reset` deleted its own temporary admin.** The clean-up of leftover temporary users (`demo-reset-%@example.com`) also matched the run's own admin, so the next call got 401. The clean-up now excludes the current run's admin id.

### 2026-10-19 · Task 17: Kubernetes production readiness · ✅

**Context.** On 2026-10-15 eight agents worked on Tasks 17–20 in parallel and were all cut off together by the usage limit after about 18 minutes. Nothing was committed or deployed. Their partial chart work was kept, reviewed and finished here; the remaining tasks continue one at a time, with a commit after each.

**What was done**
- **NetworkPolicies, deny by default** (plan §10.8):
  - `default-deny-ingress` selects every pod in `urumi`, so a new or forgotten workload starts closed.
  - Allow rules, each restricted to one port:
    - `mariadb` ← `wordpress`, `store-bootstrap`, `wp-cron` (3306)
    - `wordpress` ← Traefik and `woo-mcp` (8080)
    - `postgres` ← `gateway` (5432)
    - `gateway` and `dashboard` ← Traefik (8080)
    - `woo-mcp` and `fx-mcp` ← `gateway` (existing, unchanged rules)
  - Traefik is matched by namespace **and** pod labels in one `from` entry, configurable as `global.networkPolicy.ingressController`. `global.networkPolicy.enabled` switches every policy off at once. The schema rejects an empty allow list, because that would admit every pod.
  - With TLS on, an extra policy admits cert-manager's HTTP-01 solver pods, so certificate issuance isn't blocked.
  - Egress stays open (Phase 2, Task 22).
- **Workload audit:**
  - `automountServiceAccountToken: false` on MariaDB, WordPress, the bootstrap Job and wp-cron. No component calls the Kubernetes API.
  - Exec probe timeouts on Postgres raised to 5 s.
  - Gateway memory request raised to 192Mi, after `kubectl top` showed about 165Mi idle.
  - The Jobs document why they have no probes: they run to completion, and `activeDeadlineSeconds` bounds them.
- **`scripts/verify-k8s.mjs` (`task verify:k8s`, also in CI).** It renders the chart with the local and the production values and fails on:
  - a long-running container without readiness or liveness probes
  - any container, including init containers, Jobs and CronJobs, without CPU and memory requests and limits
  - a container that may run as root, allows privilege escalation, keeps capabilities, or has no `RuntimeDefault` seccomp profile
  - with policies on: a missing default deny, an allow rule without sources or ports, a rule admitting a whole namespace, or a Service whose pods no allow rule admits
  - a secret-like literal in any values file
  - It then runs kubeconform v0.8.0 (Kubernetes 1.35 schemas, strict) in Docker. The root dev dependency `yaml` 2.9.1 was added for parsing.
- **Chart NOTES** now print the real URLs (including the MCP endpoint), where the logins live, and what's public versus internal.
- **wp-cron waits for MariaDB** (`docker/wordpress/bootstrap.sh`), see problem 1. The chart is now version 0.5.0.

**Verification**
- `task verify:k8s`: all checks pass for both renders. kubeconform: local 27 valid and 1 skipped (Traefik's `HelmChartConfig` CRD); prod 28 valid and 1 skipped.
- Negative test: an override that removes the dashboard's limits makes it fail, naming both missing limits.
- `helm upgrade` to revision 13 succeeded. All pods are Ready, the post-upgrade bootstrap Job completed, and the storefront (200), dashboard (200) and gateway (401 without a session) answer.
- 14 live connection tests from throwaway pods, all passed:
  - A pod with an unrelated label is blocked from all seven services.
  - A pod labelled `gateway` reaches Postgres, woo-mcp and fx-mcp, but not MariaDB.
  - A pod labelled `woo-mcp` reaches WordPress, but not MariaDB or Postgres.
- `task dod` (real LLM): **19 of 19** with the policies on, including the killed upstream and its reconnection.

**Problems and fixes**
1. **wp-cron failed with "Error establishing a database connection"** once the MariaDB policy was on. A throwaway pod labelled `wp-cron` showed why: its first connection attempt is refused, and one second later it's open. kube-router admits a new pod's IP asynchronously, and wp-cron connects immediately without retrying. The bootstrap Job had survived only because it already waited for the database.
   - Fix: cron mode now calls `wait_for_db 10` (up to 30 s) before running due events. The store image was rebuilt, and a manual cron run logs one wait and then succeeds.
2. **Git Bash rewrote a `--values=C:/...` argument** into a broken Windows path. Running with `MSYS_NO_PATHCONV=1` fixes it; this only affects running the script by hand from Git Bash.

**Follow-ups**
- Default-deny egress, an SSRF guard and Pod Security Admission come in Phase 2 (Task 22).
- `readOnlyRootFilesystem` is set for the Node services and the dashboard; WordPress, MariaDB and Postgres keep writable roots, because their images write outside their volumes.

### 2026-10-15 · Tasks 11–16 and part of 18: gateway core, chat agent, dashboard, DoD check · ✅

**Checkpoint.** The owner paused the session here because of the usage limit. The next session starts with the "Next session" list at the end of this entry.

**What was done**
- **Task 11, upstream registry and connection manager** (`apps/gateway/src/mcp/upstream/`, `modules/servers/`)
  - One MCP SDK v2 client per enabled server. The protocol version is negotiated automatically: woo and fx speak 2026-07-28, GitHub's hosted server speaks 2025.
  - Health checks run every 10 s. A server is marked unreachable after 2 failed checks or 3 failed calls, with a reason: `DNS`, `CONNECTION_REFUSED`, `TIMEOUT`, `TLS`, `AUTH`, `HTTP_ERROR` or `PROTOCOL`. Reconnects use backoff from 1 s to 30 s with jitter.
  - Status and tool lists are stored in PostgreSQL, so the dashboard has data right after a restart.
  - Admin API: create, edit, disable and delete servers, test a connection before saving, and reconnect. Credentials are sealed with AES-256-GCM and are write-only. Members get no URLs or credentials.
  - Seeds on first boot: `woo` and `fx`, plus `github` (GitHub's hosted MCP server, issues toolset) when Secret `github-mcp` has a token. Credentials come from Secrets through `credentialEnv`. Each seed is applied once.
- **Task 12, aggregating MCP endpoint and audit log** (`mcp/endpoint.ts`, `invoke.ts`, `catalog.ts`, `modules/audit/`)
  - `/mcp` is stateless. It accepts API keys or short-lived chat tokens and checks the Host header against an allow-list (DNS rebinding).
  - Tools are named `<slug>__<tool>`. Descriptions are prefixed with the server name and capped at 2000 characters.
  - Calls are routed with each server's own timeout. Clear errors cover a disabled server, an unreachable server, a timeout and an unknown tool. `tools/list_changed` is sent when the catalog changes.
  - Every call writes an audit row: user, key, channel, server, tool, duration, outcome and error. `GET /api/audit-logs` has filters and a cursor; members only see their own rows.
- **Task 15, chat module** (`modules/chat/`)
  - `POST /api/chat` streams server-sent events.
  - The agent is a plain MCP client of the gateway's own `/mcp`, using a 5-minute in-memory token bound to the user's session. So permissions and audit apply exactly as for external clients, with channel `chat_agent`.
  - It uses the OpenAI-compatible API: Groq `openai/gpt-oss-120b` first, Gemini `gemini-2.5-flash` as fallback. A turn is capped at 8 iterations and 120 s. The system prompt treats tool output as untrusted data.
- **Tasks 13, 14 and 16, dashboard** (`apps/dashboard/`, `docker/dashboard/`, `charts/.../platform/templates/dashboard.yaml`)
  - Pages:
    - sign-in, invitation acceptance, forced password change
    - servers: cards with live status, tools, add/edit with a connection test, disable switch, remove
    - members: invite by link, role, disable, per-member keys
    - API keys: shown once, with snippets for Claude Code, Cursor, VS Code and MCP Inspector
    - audit log with filters
    - chat with tool-call cards
  - Served by `nginxinc/nginx-unprivileged:1.30.6-alpine`: read-only root filesystem, uid 101, CSP and other security headers, SPA fallback. The Ingress sends `/` to the dashboard, and `/api` and `/mcp` to the gateway.
- **Task 18, partly done:** `scripts/dod-check.mjs` (`task dod`) checks the whole definition of done against the running cluster. See *Resume or debug*.
- **Security:** fixed the gitleaks CI failure, and audited the full history for leaks (problem 7 below).

**Verification**
- `pnpm turbo run lint typecheck test build`: **25 of 25 tasks** pass.
  - Gateway: 72 tests in 11 files. They include an end-to-end MCP suite with real in-process upstreams covering:
    - aggregation and routing with each server's own credential
    - disable and re-enable
    - an upstream killed and brought back on the same port, so reconnection needs no manual action
    - timeouts, a wrong upstream credential, the DNS-rebinding check, revoked keys, member visibility, and the audit log
  - Chat: a scripted model drives the real tool loop over real HTTP.
  - Dashboard: 5 tests (SSE parser, formatting, client snippets).
- **In the cluster with `task dod`:** 18 of 19 checks passed on the first full run, with the real LLM.
  - Store and upstreams:
    - storefront checkout by cash on delivery
    - order visible in WooCommerce
    - 3 upstreams connected (woo 7 tools, fx 4, github 10)
    - members can't see URLs or credentials
  - Chat agent:
    - creates a product, which appears on the storefront
    - answers "orders today" with the new order
  - External client and team controls:
    - an external MCP client sees 21 tools, answers "orders today", and runs a request across two servers
    - revoking a key rejects the next call
    - disabling `fx` hides its tools from the client and the chat
    - with the `fx` pod gone, the dashboard shows `CONNECTION_REFUSED` and woo keeps working
  - The one miss was the script's own expectation. The call to the dead server was audited as `timeout`: a keep-alive connection to the vanished pod IP waited out the 15 s limit instead of being refused. The script now accepts either outcome. **It hasn't been re-run since that one-line change.**
- **UI walkthrough:** headless Edge through `playwright-core`, scratch script not in the repo. 9 of 9 steps passed:
  - sign-in redirect, servers, server detail, connection test
  - invitation, then a second browser accepting it and seeing the servers as a member
  - key with snippets
  - a live chat answer that used `woo__list_orders` and `fx__convert_currency`
  - audit log
  - Screenshots are in `docs/screenshots/`.

**Problems and fixes**
1. **Shutdown could hang forever.** `createMcpHandler().close()` in MCP SDK 2.3 waits on an exchange whose client gave up after a timeout, and that exchange's HTTP response is never ended. Both mcp-kit and the gateway now bound the wait (`settleWithin`, `shutdown()`) and force-close leftover connections after the grace period: 5 s in mcp-kit, 10 s in the gateway.
2. **Fresh connections were misclassified.** A refused connection showed as `PROTOCOL`, because SDK v2 wraps it: `ERA_NEGOTIATION_FAILED` → `fetch failed` → `ECONNREFUSED`. The classifier stopped at the outermost code; it now walks the whole cause chain. There are unit tests for it.
3. **The chat stream was empty behind Traefik.** The abort listened to the request's `close` event, which Node.js fires once the request body has been read. The abort now listens on the response and only fires if the response hasn't ended. Injected test requests never showed this; it's timing-dependent behind a proxy.
4. **Status flapped during reconnects.** Retries showed unreachable → connecting → unreachable. Retries now keep `unreachable` until one succeeds.
5. **Test pitfall:** fetch refuses port 1 as a "bad port", so tests use a free ephemeral port.
6. **Script pitfall:** a long bash heredoc broke on quoting, so long scripts are written with the editor instead.
7. **gitleaks failed in CI.** It flagged a dummy pepper hard-coded in the test harness (commit `79210b3`, rule `generic-api-key`). The harness now generates a random pepper, and `.gitleaks.toml` allowlists exactly that historic value in exactly that file. The full-history scan is clean (commit `13ac1dc`).
   - Value-based audit: all 39 real secret values were searched for across the whole history, including deleted files and commit messages. Sources: `.env.local` and every Opaque Secret in the cluster. **None was found.**
   - Only public identifiers match: the GitHub username and repo names in docs links, the documented default usernames `storeadmin` and `ubuntu`, and the root `package.json` name.
   - Commit metadata carries the owner's personal Gmail address, which is normal git metadata (see follow-ups).

**Follow-ups and known limitations**
- An exchange abandoned by a timed-out client stays in the SDK's in-flight set until shutdown. That's a small leak per abandoned call; it's an SDK issue, now bounded at shutdown.
- The dashboard's `/healthz` is reachable through the Ingress (it answers `ok`), which is harmless. The gateway's probes stay internal.
- The chart NOTES still say "Components appear here as later tasks add them".
- Optional for the owner: use the GitHub noreply address for future commits (`git config user.email <id>+<user>@users.noreply.github.com`) and turn on "Block command line pushes that expose my email". Rewriting past commits would need a force push and isn't recommended.

**Next session**
1. Re-run `task dod`; 19 of 19 is expected.
2. Task 17:
   - Deny-by-default NetworkPolicies for store and platform: MariaDB only from WordPress and the bootstrap Job; PostgreSQL only from the gateway; the gateway reachable only from Traefik.
   - Check probes, requests and limits on every workload.
   - Fix the chart NOTES.
3. Task 20, the mandatory deliverables: `README.md` (local setup, VPS setup, placing an order, connecting a client, using the chat), `docs/system-design.md` and `docs/threat-model.md`, plus a demo script.
4. Task 19: production rehearsal values and a VPS runbook.
5. Final pass:
   - requirement-by-requirement checklist against the brief
   - clean-up: the `urumi-test-pg` container and scratch files
   - flag the outdated `URUMI.ai/docs/PROJECT_PLAN.md` copy outside the repo
6. Optional: CI builds images to GHCR. After that, Phase 2.

### 2026-10-15 · Task 10: Identity and access · ✅

**What was done**
- **Shared contracts** (`packages/contracts/src/api.ts`, used by both the gateway and the dashboard):
  - Login, password, user, invitation, user-update and API-key request/response schemas.
  - Emails are normalised (trimmed, lower-cased) *before* validation.
  - Passwords need at least 12 characters, with no composition rules (NIST 800-63B).
  - The base enums moved to `enums.ts` to avoid an import cycle.
- **`lib/crypto.ts`** (node:crypto only):
  - **scrypt** password hashes stored as `scrypt$N$r$p$salt$hash`.
  - **HMAC-SHA256 + pepper** for API keys; **SHA-256** for session and invite tokens; constant-time digest comparison.
  - Unbiased random alphanumerics.
  - **AES-256-GCM** encrypt/decrypt for upstream credentials (used in Task 11).
- **`lib/rate-limit.ts`:** an in-memory fixed-window limiter, used for login.
- **`modules/auth`:**
  - Sessions: an opaque 256-bit cookie token; only its SHA-256 is stored; **12 h idle / 7 day absolute** expiry; activity recorded at most every 5 minutes.
  - Principal guards: `requireUser` and `requireAdmin`. A **forced password change** blocks every other route.
  - Users:
    - Bootstrap admin on an empty DB.
    - **Last active admin protected.**
    - **Disabling a user revokes all their keys and ends their sessions.**
  - Invitations: a one-time link valid for 72 h; only its hash is stored; 410 when used, expired or revoked.
  - Routes:
    - `/api/auth/login|logout|me|password`; the password change signs out other sessions and must choose a *different* password.
    - `/api/users`, `/api/invitations`, and `/api/invitations/accept/:token`.
  - Plugin: cookie parsing, the principal on every request, and **an anti-CSRF guard**: state-changing `/api` calls need `X-Requested-With`.
  - Login throttled to 5 attempts per minute per IP+email (429 + `Retry-After`). The same message for an unknown email and a wrong password.
- **`modules/keys`:**
  - Issue: `umcp_<prefix8>_<secret43>`, plaintext returned once with `Cache-Control: no-store`, max 10 active keys per user, admins may issue for others.
  - List: own keys, or anyone's for admins. Revoke: owner or admin.
  - **`verifyApiKey`** (used by the MCP endpoint in Task 12): denials report the owner when known (revoked / expired / user disabled), so they can be audited. A real prefix with a wrong secret counts as *unknown*. `last_used_at` is written at most once a minute.
- **App:** `buildApp` became async so the cookie plugin loads before the session hook. Feature modules plug in through `register`.
- **Chart:** the gateway gets `API_KEY_PEPPER` (`gateway-crypto`) and `BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` (`gateway-bootstrap-admin`).
- `vitest.config.ts` runs gateway test files one at a time (they share one database). A test harness (`src/test/harness.ts`) gives each test a fresh schema, the full app, and a cookie-keeping "browser".

**Verification**
- **38 gateway tests pass**, 20 of them new DB-backed end-to-end tests:
  - **Auth (8):** bootstrap admin created once; identical answers for an unknown email and a wrong password; httpOnly + SameSite=Lax cookie with only the hash stored; forced password change gates admin routes; CSRF header required; **6th bad login → 429**; idle expiry after 12 h; logout.
  - **Team (5):** invitation accepted once (second use → 410) and signs the user in as a member; expired invitation → 410; members get 403 on admin routes; last admin can't be demoted or disabled (409); disabling a member ends their session immediately.
  - **Keys (7):** plaintext once, HMAC only in the DB, no plaintext in lists; **valid key verified, then rejected as `revoked` (with owner attribution) right after revocation**; forged secret with a real prefix → `unknown`; lifetime expiry; admin issues and revokes for a member while the member can't touch the admin's keys; 10-key cap (409); disabling a user revokes their keys.
- Unit: scrypt verify, reject, salt and malformed input; HMAC depends on the pepper; AES-GCM round trip, fresh IV, tamper and wrong-key detection; rate limiter windows.
- Deployed **revision 9**. The bootstrap admin was created from the Secret (`role admin`, `must_change_password = t`).
- Through the ingress:
  - Login without `X-Requested-With` → **403**; wrong password → **401**; correct → **200**.
  - `Set-Cookie: urumi_session=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax` (`Secure` is added automatically on https).
  - `/me` → admin with `mustChangePassword: true`; `/api/users` → **403 `password_change_required`**.
  - Logout → 204, then `/me` → 401.
  - The admin password was deliberately **not** changed, so the owner sees the forced change at first login.

**Problems and fixes**
1. **scrypt memory.** The plan's N=2^17 (r=8, p=1) needs about 128 MiB per hash, so concurrent logins could exhaust the 512 Mi gateway pod. Switched to OWASP's equivalent **N=2^15, r=8, p=3** (about 32 MiB per hash, same cost). The parameters are stored with each hash, so they can be raised later.
2. **An import cycle in contracts** (`api.ts` ↔ `index.ts`). The base enums moved to `enums.ts`.
3. **`z.email()` before normalising** would have rejected `" Asha@Example.com "`. The schema now trims and lower-cases first, then validates.
4. **Hook ordering:** the session hook must run after `@fastify/cookie` has parsed cookies, so `buildApp` awaits plugin registration before adding hooks.
5. A Windows tooling quirk while verifying: `curl.exe` wrote the cookie jar to `C:\tmp`, while Git Bash's `grep` read its own `/tmp`. Verified the cookie flags from the `Set-Cookie` header instead and removed the stray file. `.prettierignore` now excludes drizzle-kit's generated metadata.

**Follow-ups**
- Task 11: upstream registry, credential vault and connection manager. Task 12: the MCP endpoint uses `verifyApiKey` and writes audit rows for denials too.

### 2026-10-15 · Task 9: Gateway skeleton and platform sub-chart · ✅

**What was done**
- **`apps/gateway`** (Fastify, TypeScript, bundled with tsup into `server.mjs` and `migrate.mjs`, with the SQL migrations copied alongside):
  - **Config** validated with Zod at startup (`PG*`, `PUBLIC_BASE_URL`, version info).
  - **`app.ts`:**
    - Request ids: a well-formed incoming `X-Request-Id` is reused, otherwise a new one is generated; it's echoed on every response.
    - **RFC 9457 problem+json** for every error (`AppError` helpers, Zod field errors). 5xx details are never leaked.
    - `/livez`, and `/readyz` (database ping only, **never upstream health**).
    - `/api/version`.
  - **Database:** Drizzle ORM on node-postgres. **Schema v1** (plan §8.6):
    - Tables `users` (case-insensitive unique email via `UNIQUE(lower(email))`), `sessions`, `invitations`, `api_keys` (prefix plus HMAC hash), `upstream_servers` (AES-GCM credential columns as `bytea`), `upstream_tools`, `audit_logs` (bigserial; indexes on time, user+time, server+time), `system_settings`.
    - Enums for roles, statuses, auth types, audit channels and outcomes.
    - The migration `drizzle/0000_initial_schema.sql` was generated by drizzle-kit (`pnpm db:generate`).
- **`charts/urumi/charts/platform`:**
  - **PostgreSQL 17.11-alpine StatefulSet:** uid 70, 1 Gi volume, `PGDATA` in a subdirectory, `pg_isready` probes.
  - **Gateway Deployment:**
    - Label `app.kubernetes.io/name=gateway`, which the MCP servers' NetworkPolicies admit.
    - **`migrate` initContainer** (same image, `migrate.mjs`).
    - Non-root, read-only root filesystem, no service-account token, `maxUnavailable 0`.
  - **Ingress `app.<domain>`:** `/api` and `/mcp` to the gateway; health paths deliberately not routed.
  - Umbrella chart 0.4.0 with the `platform` dependency; local and prod image values; schema.
- **CI:** the `checks` job gets a **PostgreSQL service container** and `TEST_DATABASE_URL`. `turbo.json` declares that variable for `test`.

**Verification**
- Tests: **8 pass**.
  - 6 app tests: version, readiness up/down, liveness independent of the DB, problem+json with request id, 5xx detail hidden, Zod field errors, request-id reuse and rejection.
  - **2 migration tests on real PostgreSQL** (throwaway `postgres:17.11-alpine`): apply on an empty DB, **re-run is a no-op**, all 8 tables present, case-insensitive email uniqueness enforced.
- Gateway image built in 20 s. Deployed as **revision 8**. Initial migration in the initContainer: **184 ms**. The local rollout restart ran it again harmlessly (idempotent).
- Through the ingress:
  - `GET /api/version` → `{"name":"gateway","version":"0.1.0","commit":"dev"}`.
  - **`GET /livez` → 404** (health stays internal).
  - Unknown route → problem+json with `requestId`.
- **Database outage:** with PostgreSQL scaled to 0, the gateway pod became **NotReady with 0 restarts**, and the ingress answered 503. After scaling back, Ready again, still 0 restarts. Readiness and liveness behave as designed.

**Problems and fixes**
1. **Turborepo strict env mode** would have hidden `TEST_DATABASE_URL` from the test task, so the DB tests would silently skip in CI. Declared in `turbo.json`; confirmed the DB tests run through `turbo run test`.
2. drizzle-kit names migrations randomly (`0000_perfect_ricochet.sql`). Regenerated as `0000_initial_schema.sql` with `--name`.

**Deviation from the plan**
- The plan's throwaway "walking-skeleton `/mcp` pass-through" was **not built**. Its purpose (prove client → ingress → gateway → MCP server → store) is already covered: Spike B proved the SDK path with real clients, and Tasks 6–7 proved the in-cluster path from gateway-labelled pods. Task 12 builds the real endpoint directly.

**Follow-ups**
- Task 10 (identity and access) and Task 11 (registry and connection manager) add modules and routes to this app.
- A throwaway `urumi-test-pg` container on port 55432 is kept for local DB tests. Remove it with `docker rm -f urumi-test-pg`.

### 2026-10-15 · Task 7: WooCommerce MCP server · ✅

**What was done**
- **`apps/woo-mcp`** on `@urumi/mcp-kit`, built as ports and adapters.
  - **`WooCommercePort`** (`woo/port.ts`): the operations woo-mcp needs, compact output types, and a classified `WooError` (`not_found` / `invalid` / `auth` / `unavailable`).
  - **`WooRestClient`** adapter:
    - WooCommerce REST v3 over `http://wordpress:8080` with **Basic Auth** (ADR-0002) and a 10 s timeout.
    - **GETs retried twice with backoff; writes never retried.**
    - Error bodies classified; auth failures logged at error level.
    - Order windows sent as GMT with `dates_are_gmt=true`.
  - **Mappers:**
    - **Links rebased onto `STORE_PUBLIC_URL`** (WordPress emits `https://` on the internal path).
    - HTML stripped from descriptions.
    - **List views carry no addresses or contact details** (FR-WM-07); `get_order` returns billing details.
  - **`period.ts`:** `today` / `yesterday` / `last_7_days` / `this_month` resolved to exact UTC bounds **in the store timezone**, using `Intl` only. Daylight-saving safe.
  - **Tools:**
    - `list_products`, `get_product`, `create_product` (price given as a number or a string), `list_orders` (period, or `after`/`before` where a date means a whole local day), `get_order`, `update_order_status` (returns the previous status, optional private note), plus the kit's `server_info` (store name, URL, timezone, currency; reports "unreachable" instead of failing).
    - Every tool has Zod input/output schemas and annotations; `update_order_status` is marked destructive.
    - Store errors become actionable `ToolError` messages, for example "Order 99999 not found." or "The store is unavailable right now (…)".
  - Config validated at startup; store settings cached for 10 minutes.
- **Chart:**
  - `woo-mcp` alias enabled. Env `WOO_BASE_URL`, plus `STORE_PUBLIC_URL` templated from `global.scheme` and `global.domain`.
  - Secrets: `woo-mcp-auth` (bearer the gateway sends) and `store-woo-api` (REST key).
  - The generic chart now runs `tpl` on env values. **`global.scheme`** replaces `store.wordpress.scheme`, so the store and woo-mcp derive URLs from one setting.
- Taskfile `images:build` now builds woo-mcp too.

**Verification**
- Unit tests: **23 pass**.
  - `period.test.ts` (5): IST midnight while UTC is still the previous day, yesterday, last 7 days, month across a year boundary, New York DST fall-back day (25 h).
  - `rest-client.test.ts` (10), against a fake WooCommerce HTTP server: Basic Auth header, link rebasing, GMT window params, HTML stripping, 404 → `not_found`, GET retried on 503 (3 calls), write not retried (1 call), timeout → `unavailable`, validation message passed through, status update sequence (GET, PUT, POST note), store settings.
  - `tools.test.ts` (8): tool set; `today` window in Asia/Kolkata; date-only bounds; period + bounds rejected; numeric price → `"499.00"`; not-found and unavailable messages; unknown status rejected.
- Image built in 48 s. Deployed as revision 7; `woo-mcp` Ready.
- **In-cluster, as the gateway would call it** (gateway-labelled pod, bearer from the Secret):
  1. No token → **401**.
  2. 7 tools listed.
  3. `list_orders(period=today)` → window `2026-10-15 00:00 → 2026-10-16 00:00` (IST), total 1, order **#14 (Asha Rao)**.
  4. `create_product(Urumi Water Bottle, 349)` → id 15, price `349.00`, permalink **`http://store.127.0.0.1.nip.io/product/urumi-water-bottle/`** (rebased).
  5. `get_order(14)` → processing / 499.00 / Cash on delivery.
  6. `update_order_status` 14 → on-hold, then back to processing (previous status reported both times).
  7. `get_order(99999)` → `isError`, "Order 99999 not found."
  8. `server_info` → Urumi Store, public URL, Asia/Kolkata, INR.
- **Storefront `/shop/` lists "Urumi Water Bottle"** straight after the tool call.

**Problems and fixes**
1. **`helm upgrade` failed with a server-side-apply conflict** on the `fx-mcp` NetworkPolicy. My `kubectl patch` during the Task 6 investigation had made `kubectl-patch` a co-owner of `.spec.ingress`, and Helm 4 refuses to overwrite fields another manager owns. Recovered with one `helm upgrade --force-conflicts`; the policy is back to Helm-owned (port `http`). Troubleshooting note added above. Lesson: never hand-edit Helm-managed objects.

**Follow-ups**
- Test data now in the store: product 15 "Urumi Water Bottle" (from the tool test). `task demo:reset` (Task 18) will clean demo data.
- The gateway (Tasks 9–12) registers `woo` and `fx` from this namespace's Secrets on first boot.

### 2026-10-15 · Tasks 6 and 8: MCP server kit, generic chart, fx-mcp and the GitHub upstream · ✅

Task 8 was done together with Task 6: `fx-mcp` is small, and as the kit's first real consumer it verified the kit, the image pipeline and the chart end to end. Task 7 (`woo-mcp`) builds on the same pieces next.

**What was done**
- **`packages/mcp-kit`**, used by every MCP server we write:
  - `createMcpHttpServer()`: MCP SDK v2 stateless handler (ADR-0003) on Fastify with our redacting logger.
  - **Host allow-list** on `/mcp` (`hostHeaderValidation`, DNS-rebinding protection).
  - Static credential, bearer or custom header, compared in constant time (`credential.ts`).
  - `/livez` and `/readyz` (probe logs muted to warn).
  - Shared `server_info` tool; `closeOnSignals()` for graceful SIGTERM.
  - `ToolHandler` / `defineTool()`: one object per tool. `ToolError` messages are returned to the caller as `isError` results; any other exception is logged and reported as "failed unexpectedly (incident …)" without internals.
- **`charts/urumi/charts/mcp-server`**, a generic sub-chart used through **aliases** (`woo-mcp`, `fx-mcp`); the alias becomes the resource name.
  - Deployment with `maxUnavailable 0`, non-root uid 65532, read-only root filesystem, all capabilities dropped, seccomp `RuntimeDefault`, no service-account token. Probes on `/livez` and `/readyz`.
  - ClusterIP Service. `MCP_ALLOWED_HOSTS` set automatically to every in-cluster form of the Service name.
  - Env from Secrets through `secretEnv`.
  - **NetworkPolicy allowing only `app.kubernetes.io/name=gateway` pods.**
  - **No Ingress template at all.**
- **`docker/node-app/Dockerfile`**, shared by every Node service:
  - Build stage `node:24-alpine`: `pnpm fetch` from the lockfile (cached layer), then `install --offline`, then `tsup` bundles the app into **one `server.mjs`**.
  - Runtime stage **`gcr.io/distroless/nodejs24-debian13:nonroot`**: just the bundle, no shell or package manager.
  - Root `.dockerignore` keeps `.env*`, `.git` and docs out of the build context.
- **`apps/fx-mcp`:**
  - Tools: `convert_currency`, `get_exchange_rate`, `list_currencies` (Zod input/output schemas, read-only annotations) plus `server_info`.
  - `RatesSource` interface with a live source (currency-api on the jsDelivr CDN, then a mirror, 5 s timeout), a static table, and a 1 h cache with fallback.
  - Header credential `X-API-Key` from Secret `fx-mcp-auth`. Config validated with Zod at startup (fail fast).
- **GitHub remote MCP** checked as the third upstream (registered in the gateway later): URL `https://api.githubcopilot.com/mcp/x/issues`, bearer = fine-grained PAT.
- Umbrella chart 0.3.0: `woo-mcp` (disabled until Task 7) and `fx-mcp` dependencies, `global.logLevel`, schema definitions for MCP servers, local and prod image values. Taskfile `image:node APP=…`.

**Verification**
- `@urumi/mcp-kit`: **11 tests** pass. They cover the tool list including `server_info`, structured output, `ToolError` → `isError`, unexpected errors hidden (secret text not leaked), extra `server_info` fields, wrong key → 401, forged Host → **403**, `/livez` and `/readyz`.
- `fx-mcp`: **8 tests** (conversion and rounding, same-currency rate, unknown codes → `ToolError`, schema rejects malformed codes, cache TTL, static fallback).
- The bundled `dist/server.mjs` runs standalone. An MCP client got `convert_currency(1749 INR→USD) = 18.42` from live CDN rates; a wrong key gets 401.
- Image `urumi-fx-mcp:dev`: 223 MB, built in 35 s.
- Deployed: `fx-mcp` Ready in seconds (probes unaffected by the NetworkPolicy). In-cluster checks from a gateway-labelled pod:

  | Check | Result |
  |---|---|
  | `/livez` | 200 |
  | MCP without key | **401** |
  | MCP with key + forged `Host` | **403** |
  | `initialize` | `serverInfo fx-mcp 0.1.0` |
  | `convert_currency(499 INR→USD)` | **5.26**, source `cdn.jsdelivr.net`, live rates over the cluster's outbound internet |
  | Pod **without** the gateway label | **blocked** (curl exit 7) |

- GitHub remote MCP, with the PAT from `.env.local` (never printed):
  - `/mcp/x/issues`: 2026 protocol, **10 tools**; `list_issues(Mohan0112/Urumi-Challenge-demo-issues)` OK (0 issues).
  - The full `/mcp/` endpoint has 46 tools. We use the Issues toolset URL to keep the model's tool list small.

**Problems and fixes**
1. **Fastify typing:** passing a pino logger made Fastify infer a logger-specific instance type. Fixed by typing it as `FastifyBaseLogger`.
2. **The Host-check test got 200.** Node's `fetch` treats `Host` as a forbidden header and silently drops overrides. The test now uses `node:http`; the check itself was fine (403).
3. **Fastify 5.12 deprecated `disableRequestLogging`.** Replaced it with per-route `logLevel: 'warn'` on the probes, which also keeps useful request logs for `/mcp`.
4. **Frankfurter and open.er-api were unreachable from this network** (timeouts / immediate failures). Switched to the key-less **currency-api on jsDelivr** (0.16 s), with a mirror and a static table. The plan's §8.3 and Task 8 lines were updated, and the static INR rate was refreshed to about 95/USD.
5. **NetworkPolicy "blocked the gateway" in the first test.** Two theories were ruled out first: named vs numeric port (both work) and `--overrides` dropping labels. The real cause is that kube-router adds a **new pod's IP to the allow-list a few seconds after start**, and the probe ran `curl` instantly. With a 10 s wait, the labelled pod gets 200 and others stay blocked. **Consequence for Task 11:** the gateway must retry upstream connections at startup (backoff is already in the design). Debug tips were added above.
6. `pnpm` blocked esbuild's install script (used by tsup). Approved with `pnpm approve-builds esbuild`.

**Follow-ups**
- Task 7: `woo-mcp` on the same kit, chart and Dockerfile.
- `issue_write` on the GitHub upstream is exercised in the demo flow (Task 12 onwards).

### 2026-10-15 · Task 5: Store bootstrap and checkout · ✅

**What was done**
- **`urumi-bootstrap`** (`docker/wordpress/bootstrap.sh`, baked into the image), idempotent: every step checks before it acts.
  1. Waits for the DB through `healthz.php`, then installs WordPress core if it isn't installed.
  2. Sets the title, timezone and pretty permalinks; activates WooCommerce and Storefront; runs `wp wc update`.
  3. Applies store settings: INR, IN:KA, address.
     - **Turns off "Coming soon" mode**, which new WooCommerce stores enable by default and which hides the shop.
     - **Turns shipping off**, so cash-on-delivery checkout isn't blocked by missing shipping methods.
     - Guest checkout, tracking and marketplace suggestions off; onboarding skipped; **cash on delivery enabled**.
  4. Creates the shop, cart, checkout and my-account pages (`wp wc tool run install_pages`).
  5. Creates `mcp-bot` (`shop_manager`) and **replaces** its REST key from Secret `store-woo-api` on every run (hashed with `wc_api_hash()`), so a rotated Secret takes effect.
  6. Seeds 4 products by SKU (Mug ₹499, T-Shirt ₹899, Notebook ₹249, Sticker Pack ₹99).
  - `urumi-bootstrap cron` runs due WP-Cron events.
- **WordPress `.htaccess` baked into the image.** Pretty permalinks need it, and a Job can't write into the web pod's immutable document root. It also passes the `Authorization` header to PHP for WooCommerce Basic Auth.
- **Helm:**
  - `store-bootstrap` Job as a `post-install,post-upgrade` hook with delete policy `before-hook-creation`, so the last run's logs stay available. `backoffLimit 3`, `activeDeadlineSeconds 600`.
  - `wp-cron` CronJob every 5 minutes (`concurrencyPolicy: Forbid`).
  - Store settings and the schedule are in values.
- **Taskfile:** `deploy:local` now restarts Deployments after `helm upgrade`, so pods pick up freshly pushed `:dev` images. New `store:bootstrap-logs`.
- `docs/runbooks/dod-manual.md`: the browser checklist for the store.

**Verification**
- First run: Job `Complete` in **52 s**. Log: installed, activated, settings applied, pages ensured, `mcp-bot` created, REST key in place, 4 products created.
- **Idempotency:** a second `helm upgrade` (revision 4) re-ran the Job, which logged "already installed" and created nothing new: still 4 products, no new user.
- **Storefront:** `GET /` → 200; `/shop/` lists all 4 products; `GET /wp-login.php` → 200.
- **Cash-on-delivery checkout through the public URL** (WooCommerce Store API, the same calls the checkout page makes):
  - `GET /cart` returned a Cart-Token; `add-item` for the Mug gave `items_count 1`, `total_price 49900` (paise).
  - `POST /checkout` with `payment_method: cod` returned **`order_id 14`, `status processing`**.
- **Order visible to the admin:** `wp wc shop_order list` → `14, processing, 499.00, "Cash on delivery", billing Asha Rao`.
- **mcp-bot REST access in the real cluster** (ADR-0002), from a throwaway pod with the key from the Secret:
  - Internal host → `GET /wc/v3/orders` **200**.
  - **Same key with the public `Host` → 401**.
  - Order 14 reads back as `processing`.
- **wp-cron:** a manual run of the CronJob executed `action_scheduler_run_queue` and three other due events.

**Problems and fixes**
1. **Three WooCommerce defaults would have broken the brief's checkout test.** They were found while designing the bootstrap and handled in it: "Coming soon" mode, no shipping methods (checkout blocked), and missing `.htaccess` (pretty permalinks 404).
2. **`helm: command not found` in Git Bash.** winget adds each package folder to the user PATH, which an already-open shell doesn't see. Added the folders explicitly; the troubleshooting note above is updated.
3. **`/usr/sbin/sendmail: not found`** in the first bootstrap log: WordPress tried to send a notification email. Harmless; the cluster has no mail server and invites work by link (out of scope).

**Follow-ups**
- The owner runs the browser half of the Store DoD (`docs/runbooks/dod-manual.md`) whenever convenient.
- `scripts/dod-check.mjs` (Task 18) will reuse the Store API checkout calls above.

### 2026-10-15 · Task 4: Store image and sub-chart · ✅

**What was done**
- **Image `docker/wordpress`** (`localhost:5001/urumi-wordpress:dev` locally):
  - Base `wordpress:7.1.3-php8.4-apache`, with WooCommerce 11.2.1, Storefront 4.6.2 and WP-CLI 2.12.0 baked in.
  - The internal-HTTPS mu-plugin (ADR-0002), and `healthz.php`, which checks PHP and the DB connection.
  - The whole site is baked into `/var/www/html`, so the official entrypoint skips its startup copy and code is immutable (ADR-011).
  - Apache listens on **8080** and the image runs as **uid 33 (non-root)**.
  - `bootstrap.sh` is a placeholder until Task 5.
- **Sub-chart `charts/urumi/charts/store`**, wired into the umbrella as a dependency with `condition: store.enabled`:
  - **MariaDB 11.4.13 StatefulSet** with a headless Service `mariadb`, a 2 Gi `volumeClaimTemplate`, and runs as uid 999. Startup, readiness and liveness probes use the image's `healthcheck.sh`.
  - **WordPress Deployment** with `strategy: Recreate` (RWO volume) and a Service `wordpress:8080`.
  - A 1 Gi uploads PVC `wp-uploads` with `helm.sh/resource-policy: keep`.
  - Probes: startup and readiness on `/healthz.php`; liveness is TCP only, so a DB outage never restarts the web pod.
  - Restricted security context (drop ALL capabilities, no privilege escalation, seccomp `RuntimeDefault`) on both pods.
  - `WORDPRESS_CONFIG_EXTRA` sets `WP_HOME`/`WP_SITEURL` from values, `DISABLE_WP_CRON`, `DISALLOW_FILE_MODS`, and `X-Forwarded-Proto` trust.
  - **Ingress `store`** on `store.<domain>`, with a TLS block and cert-manager annotation when `global.tls.enabled`.
- **Umbrella values:**
  - `global.tls` added.
  - `values-local.yaml`: local registry image, `pullPolicy: Always`, `http`.
  - `values-prod.yaml`: GHCR image, `https`, TLS via `letsencrypt-prod`, larger volumes and limits.
  - The schema validates TLS, scheme and image fields.
- **`scripts/secrets.mjs`** (run as `task secrets`):
  - Creates every Secret the plan needs: `store-db`, `store-wp`, `store-woo-api`, `woo-mcp-auth`, `fx-mcp-auth`, `platform-db`, `gateway-crypto`, `gateway-bootstrap-admin`, `llm`, `github-mcp`.
  - Generated values are created once. Values from `.env.local` are re-synced on every run.
  - Manifests go to `kubectl apply -f -` on **stdin**, so values never appear in a command line or in output.
- **Taskfile:** `secrets`, `logins` (prints generated logins for the owner), `images:build`/`image:wordpress`, `store:wipe` (asks for confirmation).

**Verification**
- `task chart:lint`: both values files lint and render.
- `task deploy:local`: release upgraded in **65 s**. `mariadb-0` (server node) and `wordpress` (agent node) are both `1/1 Running`. Both PVCs `Bound` (`local-path`). Ingress `store.127.0.0.1.nip.io` has an address.
- Through the ingress: `GET /` returns `302` to `/wp-admin/install.php` (expected until Task 5); `GET /healthz.php` returns `ok`.
- **Persistence:**
  - Wrote a row into a test table and a file into `wp-content/uploads`, then deleted `mariadb-0` and the WordPress pod.
  - After the pods were recreated, the row (`written-before-restart`) and the file (`uploads-before-restart`) were both still there.
  - The markers were removed afterwards.
- Deployed pod security contexts: WordPress `runAsUser 33, fsGroup 33, runAsNonRoot`; MariaDB `runAsUser 999, fsGroup 999, runAsNonRoot`.
- Image sanity check: runs as `uid=33(www-data)`; `wp-content/plugins/woocommerce` and `mu-plugins/urumi-internal-https.php` are present; uploads directory owned by `www-data`; `WP-CLI 2.12.0`; `Listen 8080`.

**Problems and fixes**
1. **Image size 1.43 GB** on the first build: a MySQL client package, plus a separate `chown -R` layer that duplicated every file. Fix: no MySQL client (`healthz.php` and WP-CLI talk to the DB through PHP), and unzip is purged in the same layer.
2. **WooCommerce stored twice** (image source tree and document root). Fix: one `RUN` copies WordPress core into `/var/www/html`, unpacks the plugins straight into `wp-content`, and chowns in the same layer. Result: 1.39 GB, of which the official base image is 1.13 GB.
3. **Non-root plus the official entrypoint:** the entrypoint copies `/usr/src/wordpress` at startup when `/var/www/html` is empty. With the uploads volume mounted inside it, Kubernetes creates root-owned parent folders that the non-root copy can't write into. Fix: bake the site into `/var/www/html` so the copy never runs. The bootstrap Job (Task 5) will use the same files.
4. My first persistence test failed because PowerShell mangled nested SQL quotes and the `kubectl delete` mixed a pod name with a label selector. Redone in bash with SQL piped over stdin. A tip was added to "Resume or debug".

**Follow-ups**
- Task 5: the bootstrap Job (install, WooCommerce setup, `mcp-bot` and REST key, sample products) and the wp-cron CronJob.
- NetworkPolicies for `mariadb` and `wordpress` come in Task 17 (plan §10.8).

### 2026-10-15 · Task 3: Technical spikes · ✅

Full write-up with every test result: [spikes.md](spikes.md). Decisions: [ADR-0002](adr/0002-woocommerce-rest-basic-auth.md) and [ADR-0003](adr/0003-mcp-sdk-v2-stateless-gateway.md). The spike code ran outside the repository and was deleted; only the findings are kept.

**What was done**
- **Spike A (WooCommerce auth).** Docker: MariaDB 11.4 + WordPress 7.1.3 + WP-CLI + WooCommerce 11.2.1, a `shop_manager` user, a REST key inserted with `wc_api_hash()`, and the internal-HTTPS mu-plugin.
  - Basic Auth via the internal host: 200. Same credentials with the public `Host`: 401. No credentials: 401.
  - Create product: 201. List orders: 200. `shop_manager` blocked from plugins.
- **Spike B (MCP SDK + clients).** A mini upstream and a mini gateway on **MCP SDK v2** (`createMcpHandler`, low-level `Server`, upstream `Client` in auto mode, Fastify adapter).
  - Namespacing and forwarding work. A 2 s timeout on a 5 s upstream gives a clear error.
  - A modern client received `list_changed` after the upstream was disabled. A 2025-era client is served statelessly.
  - A wrong key gets 401. The audit lines carry the right user.
  - **Claude Code 2.1.300 connected (`✔ Connected`) and negotiated the 2026 protocol. MCP Inspector 2.11 CLI listed the tools (2025 protocol).**
- **Spike C (LLM tool loop).** `openai` SDK 7.34 with Zod v4 JSON Schemas.
  - Groq `openai/gpt-oss-120b` (2.3 s), `openai/gpt-oss-20b` (1.4 s) and Gemini `gemini-2.5-flash` (7.3 s) all produced the correct two-step tool chain and answer.
- Plan updated to **v1.3**: tech stack rows, ADR-013 superseded, §8.1.7 rewritten, Task 4 base image.

**Problems and fixes**
1. **`wp plugin install woocommerce` failed:** "Minimum WordPress requirement is 7.0". `wordpress:6-php8.3-apache` ships WordPress 6.x, and WooCommerce 11.2.1 needs 7.0+. Fix: pin `wordpress:7.1.3-php8.4-apache` and `wordpress:cli-php8.4`.
2. **The MCP SDK changed major version.** v2 split packages implement the 2026-07-28 spec, with a stateless per-request handler and a new change-subscription mechanism. Read the v2 docs and typings, then validated the design with real code and real clients. Outcome: the stateless gateway (ADR-0003) replaces the planned session map.
3. **WordPress reports `https://` permalinks on internal requests**, a side effect of the mu-plugin. `woo-mcp` will rewrite store URLs to `STORE_PUBLIC_URL` (Task 7).
4. **The Llama 3.3 model is no longer in Groq's catalog.** Default is now `openai/gpt-oss-120b`.
5. Claude Code isn't on the shell PATH. The VS Code extension's binary at `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe` was used. The temporary `spike-gw` MCP entry was removed from `~/.claude.json` afterwards.

**Follow-ups**
- Task 4 uses WordPress 7.1.3 / PHP 8.4 and bakes in WooCommerce 11.2.1, Storefront 4.6.2 and the mu-plugin.
- Task 6 (`mcp-kit`) and Task 12 (gateway) build on the v2 APIs exactly as in Spike B.
- The demo can show tools disappearing live in Claude Code (modern protocol). In MCP Inspector, click "List tools" again.

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
- ~~CI runs for the first time after the first push.~~ Done. The first run failed only in the gitleaks job: `gitleaks-action` builds a `first-commit^..last` range, which doesn't exist on a repository's first push. Fixed in commit `2f5a80a` by running the pinned `ghcr.io/gitleaks/gitleaks:v8.30.1` image over the full history. Actions were also bumped to Node 24 versions (checkout v7, setup-node v7, pnpm/action-setup v6, setup-helm v5). CI is green on all three jobs.
- `packages/mcp-kit` is created in Task 6, when it gets real content.
