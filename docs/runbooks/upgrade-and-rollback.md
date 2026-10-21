# Runbook: upgrade and roll back

Everything (store, MCP servers, gateway, dashboard, databases) is **one Helm release**, `ahjin` in namespace `ahjin`. Every `helm upgrade` creates a revision, and `helm rollback` returns the whole platform to a known-good combination of image tags and settings. Commands below use the VPS context; locally use `k3d-ahjin` and `values-local.yaml`.

## See where you are

```sh
helm --kube-context ahjin-vps -n ahjin history ahjin       # every revision, its chart version and status
helm --kube-context ahjin-vps -n ahjin get values ahjin     # the values of the deployed revision
kubectl --context ahjin-vps -n ahjin get pods
```

## Upgrade

1. **Build:** merge to `main`. CI builds the five images and pushes them to GHCR tagged with the commit SHA. Check that the `images` workflow finished for that commit.
2. **Preview (optional):** render the change before applying it:
   ```sh
   helm template ahjin charts/ahjin -n ahjin -f charts/ahjin/values-prod.yaml > new.yaml
   helm --kube-context ahjin-vps -n ahjin get manifest ahjin > current.yaml
   diff current.yaml new.yaml
   ```
3. **Backups are automatic:** the chart's `pre-upgrade` hooks dump MariaDB and PostgreSQL into their backup volumes before Helm changes anything, and a failed backup stops the upgrade. `task backup:list` shows them ([backup-and-restore.md](backup-and-restore.md)).
4. **Upgrade:**
   ```sh
   task deploy:prod PROD_CONTEXT=ahjin-vps DOMAIN=<domain> LETSENCRYPT_EMAIL=<email> IMAGE_TAG=<sha>
   ```
   It runs `helm upgrade --install … --wait --timeout 15m --rollback-on-failure`. If the new pods don't become ready in time, Helm rolls back to the previous revision by itself (Helm 4's `--rollback-on-failure` replaces Helm 3's `--atomic`).
5. **Check:** `kubectl -n ahjin get pods`, then `task dod CONTEXT=ahjin-vps -- --domain=<domain> --scheme=https`.

Stateless Deployments (gateway, dashboard, MCP servers) roll with `maxUnavailable: 0, maxSurge: 1`: a new pod must be ready before an old one stops, so an upgrade, or a failed one, causes no downtime. WordPress uses `Recreate`, because its uploads volume is ReadWriteOnce and can't attach to two pods; the storefront is down for the few seconds the new pod takes to start.

## Roll back

```sh
helm --kube-context ahjin-vps -n ahjin history ahjin
helm --kube-context ahjin-vps -n ahjin rollback ahjin <revision> --wait
```

A rollback is itself a new revision, so it can be undone the same way.

## Data and migrations

- **Volumes survive** upgrades, rollbacks and even `helm uninstall`. StatefulSet volume claims aren't deleted with the release, and the uploads PVC has `helm.sh/resource-policy: keep`.
- **Gateway migrations are expand-only.** The `migrate` init container applies pending migrations before the new gateway starts. A release may only add tables and columns; removals ship one release later, so the previous gateway always works with the current schema and `helm rollback` is safe. There are four migrations so far (`apps/gateway/drizzle/0000`–`0003`), and every one only adds: tool pinning columns, the tool permissions table, the `managed_by` column.
- **WooCommerce is different.** A new store image can bring a WooCommerce version whose database updates the bootstrap hook applies (`wp wc update`). Helm can't undo those, so a rollback after a WooCommerce upgrade also restores the database from the backup the pre-upgrade hook took: `helm rollback`, then `task backup:restore COMPONENT=store NAME=<that file>`.

## What a failed upgrade costs

- **Gateway, dashboard, MCP servers:** nothing. The new pod never becomes ready, the old one keeps serving, and the release is rolled back when `--timeout` expires.
- **WordPress:** the storefront is down until the rollback. `Recreate` stops the old pod before the new one starts, so a WordPress image that can't start leaves no pod serving. Check a new store image on the rehearsal cluster first, and keep `--timeout` short for store upgrades. Removing this needs storage that more than one pod can mount (ReadWriteMany, for example Longhorn or NFS), so WordPress could roll like the others.

## A quick change without the values files

To change one setting of the deployed release, use `--reuse-values` **alone**:

```sh
helm --kube-context ahjin-vps -n ahjin upgrade ahjin charts/ahjin --reuse-values --set global.logLevel=debug --wait --rollback-on-failure
```

Don't add `-f values-prod.yaml` to such a command. The file would be applied on top of the reused values, and its placeholder image tags (`CHANGE-ME-git-sha`) would replace the real ones, so every image would fail to pull. Full deploys go through `task deploy:prod`, which passes the real tags.

## Drill

Run on the production rehearsal cluster (`values-prod.yaml` + `values-rehearsal.yaml`, GHCR images) on 2026-10-19:

```sh
CTX=k3d-ahjin-rehearsal
H="helm --kube-context $CTX -n ahjin"
# 1. A good upgrade: change a setting and roll forward
$H upgrade ahjin charts/ahjin --reuse-values --set global.logLevel=debug --wait --timeout 5m --rollback-on-failure
# 2. Roll it back by hand (0 = the previous revision)
$H rollback ahjin 0 --wait
# 3. A broken upgrade: a gateway image tag that doesn't exist, while probing the gateway every second
$H upgrade ahjin charts/ahjin --reuse-values --set platform.gateway.image.tag=does-not-exist --wait --timeout 2m --rollback-on-failure
$H history ahjin
```

| Step | Result |
|---|---|
| 1. Good upgrade | Revision deployed; the gateway's `LOG_LEVEL` changed from `info` to `debug` |
| 2. Manual rollback | Back to `info`; the store's 4 products and the platform's users unchanged |
| 3. Broken upgrade | Helm reported "UPGRADE FAILED … has been rolled back due to rollback-on-failure" after the 2-minute timeout; the gateway answered 108 of 108 probes during it; its image is the previous SHA again |
