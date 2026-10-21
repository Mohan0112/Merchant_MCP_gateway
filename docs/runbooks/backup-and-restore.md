# Runbook: backups and restore

Two databases hold everything that isn't rebuilt from the images:

| Component | Database | What's in it | Backup volume |
|---|---|---|---|
| `store` | MariaDB `wordpress` | products, orders, customers, store settings | PVC `store-backups` |
| `platform` | PostgreSQL `ahjin` | users, sessions, API key hashes, servers and their encrypted credentials, tool approvals, permissions, assistant settings, audit log | PVC `platform-backups` |

Product photos live in the `wp-uploads` volume; the store bootstrap re-creates them from the image, so they need no backup here.

## When backups are taken

- **Nightly** at 02:30 (Asia/Kolkata): CronJobs `store-backup` and `platform-backup`.
- **Before every `helm upgrade`:** Helm runs the same backup as a `pre-upgrade` hook (`store-backup-pre-upgrade`, `platform-backup-pre-upgrade`). If a backup fails, the upgrade doesn't start. The hook is rendered only once its volume exists, so the first upgrade after backups are switched on (the one that creates the volumes) runs without it.
- **On demand:** `task backup:now`.

Each backup is one gzipped SQL file named by its UTC time, for example `20261022T103000Z.sql.gz`. The newest seven are kept (`backup.keep`). The volumes carry `helm.sh/resource-policy: keep`, so even `helm uninstall` leaves them in place.

Values (per sub-chart, `store.backup` and `platform.backup`): `enabled`, `schedule`, `timeZone`, `keep`, `beforeUpgrade`, `persistence.size`, `persistence.storageClass`.

## See what's there

```sh
task backup:list
```

## Restore

```sh
task backup:restore COMPONENT=store                          # the newest store backup
task backup:restore COMPONENT=platform NAME=20261022T103000Z.sql.gz
```

`scripts/backup.mjs restore`:
1. Stops the component's writers: `wordpress` for the store, `gateway` for the platform. It also suspends the component's CronJobs, so nothing writes during the load.
2. Loads the dump in a one-off pod with the backup volume mounted:
   - store: `mariadb`, with `DROP TABLE` before each table;
   - platform: `psql`, from a `pg_dump --clean --if-exists`.
3. Starts the writers again and resumes the CronJobs, even if the load failed.

Restoring the platform also restores its schema version. Restore a backup from the same or an older release, then run `task deploy:local` (or `deploy:prod`), so the `migrate` init container brings the schema forward again.

On another cluster, pass the context: `node scripts/backup.mjs restore --component=store --context=<context> --namespace=ahjin`.

## Off-site copies

The backup volumes live on the same node as the databases. For a real VPS, copy them off the machine. For example, a nightly `kubectl cp` from a pod that mounts the volume, or an S3 sync from a sidecar. That isn't part of this chart.

## Drill

See [docs/BUILD_LOG.md](../BUILD_LOG.md) (Task 28) for the recorded drill: back up, change data, restore, and check that the change is gone and the platform still works.
