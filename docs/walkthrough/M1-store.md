# Walkthrough M1: Store (Tasks 4–5)

## What runs in the cluster now

| Workload | Kind | What it does |
|---|---|---|
| `mariadb` | StatefulSet (1) + headless Service | Store database; 2 Gi volume; runs as uid 999 |
| `wordpress` | Deployment (1, `Recreate`) + Service `wordpress:8080` | Storefront and wp-admin; runs as uid 33 on port 8080; 1 Gi uploads volume |
| `store-bootstrap` | Job (Helm hook after install/upgrade) | Installs and configures the store, idempotently |
| `wp-cron` | CronJob (every 5 min) | Runs WordPress/WooCommerce scheduled tasks |
| Ingress `store` | Traefik | `store.127.0.0.1.nip.io` → `wordpress:8080` |

## Why the store image looks the way it does

- **Code is baked in, data is on volumes.** WordPress, WooCommerce 11.2.1 and Storefront are inside the image; only the database and `wp-content/uploads` persist. Upgrading or rolling back the store is just changing the image tag (ADR-011). Plugins can't be installed from wp-admin (`DISALLOW_FILE_MODS`), which also removes an attack path.
- **Non-root.** Apache listens on 8080 so it can run as `www-data`; MariaDB runs as `mysql`. Both drop all Linux capabilities.
- **Probes that don't cascade.** Readiness checks PHP and the database (`/healthz.php`). Liveness only checks that the port is open, so a database outage makes WordPress *unready* (no traffic) without restart loops.
- **Why `Recreate`?** The uploads volume is ReadWriteOnce on node-local storage, so an old and a new pod on different nodes can't share it during a rolling update.

## What the bootstrap does, and why it's safe to re-run

It runs after every `helm install`/`upgrade` and checks before every step ("is WordPress installed?", "does product AHJIN-MUG exist?"). Three WooCommerce defaults would otherwise break the brief's checkout test: **"Coming soon" mode** (hides the shop), **no shipping methods** (blocks checkout), and **no `.htaccess`** (pretty URLs 404). The bootstrap fixes the first two; the image ships the third.

It also creates the **`mcp-bot`** user as a `shop_manager`, not an admin, and gives it a REST key from a Kubernetes Secret. The WooCommerce MCP server (next milestone) uses that key.

## How we proved it works

- Pods ready about 60 s after deploy; database rows and uploads survived deleting both pods.
- A second upgrade changed nothing (idempotent).
- A cash-on-delivery checkout through the public URL created order #14, which WooCommerce's admin order list shows as Processing / Cash on delivery.
- The `mcp-bot` key works from inside the cluster but gets **401** when the request uses the public host name.

## Likely questions

**Where do the passwords come from?**
`scripts/secrets.mjs` generates them once into Kubernetes Secrets. The chart only references Secret names, and the values never appear in git or in logs. `task logins` prints the generated logins for you locally.

**What happens on `helm uninstall`?**
The volumes stay: StatefulSet claims are never deleted by Helm, and the uploads PVC has `helm.sh/resource-policy: keep`. Wiping data is a deliberate `task store:wipe`, which asks for confirmation.

**Why no email?**
There's no mail server in the cluster. WooCommerce works without it, and team invites use copyable links.
