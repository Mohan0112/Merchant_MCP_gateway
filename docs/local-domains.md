# Local domains

The brief asks for stable URLs through Ingress and a documented local domain approach. This is it.

## Default: `*.127.0.0.1.nip.io`

[nip.io](https://nip.io) is a public wildcard DNS service: any name ending in `.127.0.0.1.nip.io` resolves to `127.0.0.1`. k3d maps the laptop's ports 80 and 443 to Traefik inside the cluster, so these URLs work in browsers, `curl`, Claude Code and Cursor with **no hosts-file edits**:

| URL | Routed to |
|---|---|
| `http://store.127.0.0.1.nip.io` | WordPress + WooCommerce storefront and `/wp-admin` |
| `http://app.127.0.0.1.nip.io/` | Dashboard |
| `http://app.127.0.0.1.nip.io/api`, `/mcp` | Gateway REST API and MCP endpoint |

The domain comes from `global.domain` in `charts/ahjin/values-local.yaml`; every Ingress host is built from it.

```text
browser / MCP client
   │  store.127.0.0.1.nip.io  →  DNS answers 127.0.0.1
   ▼
laptop port 80  →  k3d load balancer  →  Traefik (kube-system)  →  Service  →  Pod
```

## Fallback: hosts file (offline, or if nip.io is unreachable)

1. Open Notepad **as administrator** and edit `C:\Windows\System32\drivers\etc\hosts`. Add:
   ```text
   127.0.0.1 store.ahjin.test app.ahjin.test
   ```
2. Deploy with `--set global.domain=ahjin.test`.

## Port conflicts

If something else on Windows already uses port 80 or 443, change the host side of the `ports` mappings in `deploy/k3d/cluster.yaml` (for example `8080:80`) and include the port in URLs (`http://store.127.0.0.1.nip.io:8080`).

## Inside the cluster

Pods don't use these public names to talk to each other. They use Service DNS names such as `http://wordpress:8080`, so nothing inside the cluster depends on nip.io.
