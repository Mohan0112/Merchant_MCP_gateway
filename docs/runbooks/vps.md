# Runbook: deploy to a VPS (k3s)

> **Status:** not yet run on a real VPS (deferred by the owner, plan Task 31). The same chart, the same production values and the same task commands were rehearsed end to end on a local single-node k3s cluster over HTTPS; see [Production rehearsal](#production-rehearsal-on-a-laptop) and the build log.

The VPS runs the **same chart** as the laptop. Only values change: `values-prod.yaml`, plus the domain, image tag and Let's Encrypt email passed by `task deploy:prod`.

| | Local (`values-local.yaml`) | VPS (`values-prod.yaml`) |
|---|---|---|
| Kubernetes | k3d (k3s v1.35.5 in Docker), 1 server + 1 agent | k3s v1.35.5, one node |
| Domain | `*.127.0.0.1.nip.io` | `store.<domain>`, `app.<domain>` (for example DuckDNS) |
| TLS | none (HTTP) | cert-manager, Let's Encrypt via HTTP-01 through Traefik |
| Images | local registry, tag `dev` | `ghcr.io/mohan0112/merchant_mcp_gateway/<app>`, immutable git-SHA tag built by CI (public) |
| Volumes (`local-path`) | MariaDB 2 Gi, uploads 1 Gi, Postgres 1 Gi | MariaDB 10 Gi, uploads 5 Gi, Postgres 5 Gi |
| Limits | lean laptop profile | higher (gateway and WordPress 768 Mi, databases 1 Gi) |
| Secrets | `scripts/secrets.mjs` → `k3d-urumi` | the same script → the VPS context |

## What you need

- A VPS with **x86-64**, Ubuntu 24.04, at least 2 vCPU and 4 GB RAM, and a public IPv4 address. CI publishes amd64 images only; on an ARM server (Oracle A1) add arm64 builds to `.github/workflows/images.yml` first (`platforms: linux/amd64,linux/arm64`, or native arm64 runners).
- A domain whose `store.` and `app.` names point at the VPS. DuckDNS is free: a name `<name>.duckdns.org` also resolves every subdomain such as `app.<name>.duckdns.org`.
- An email address for Let's Encrypt expiry notices.
- Your laptop with this repository, `.env.local` filled in, and `kubectl`, `helm` 4, `task`, Node.js 24 and pnpm.

## 1. Prepare the server

```sh
ssh ubuntu@<vps-ip>
sudo apt update && sudo apt -y full-upgrade && sudo apt -y install unattended-upgrades ufw
# SSH with keys only
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
# Firewall: SSH from your IP only, HTTP and HTTPS from anywhere; the Kubernetes API (6443) stays closed
sudo ufw default deny incoming
sudo ufw allow from <your-ip> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

On Oracle Cloud, also open 80 and 443 in the VCN security list; its Ubuntu images block them in iptables too (`sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT`, then `sudo netfilter-persistent save`).

## 2. Install k3s

Same version as the local cluster, so both run the same Kubernetes, Traefik and local-path provisioner:

```sh
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.35.5+k3s1 sh -
sudo kubectl get nodes                      # Ready
sudo kubectl -n kube-system get deploy traefik local-path-provisioner
```

k3s enforces NetworkPolicies with its embedded controller, exactly as k3d does locally.

## 3. Reach the cluster from your laptop (SSH tunnel)

The API port stays closed to the internet; `kubectl` goes through SSH.

```sh
scp ubuntu@<vps-ip>:/etc/rancher/k3s/k3s.yaml ~/.kube/urumi-vps.yaml   # on the VPS first: sudo chmod 644 or copy with sudo
sed -i 's#https://127.0.0.1:6443#https://127.0.0.1:16443#' ~/.kube/urumi-vps.yaml
ssh -N -L 16443:127.0.0.1:6443 ubuntu@<vps-ip> &                         # keep this running
export KUBECONFIG=~/.kube/config:~/.kube/urumi-vps.yaml
kubectl config rename-context default urumi-vps
kubectl --context urumi-vps get nodes
```

## 4. DNS

Point the domain at the VPS and check both names resolve to it:

```sh
curl "https://www.duckdns.org/update?domains=<name>&token=<duckdns-token>&ip=<vps-ip>"   # prints OK
nslookup app.<name>.duckdns.org
nslookup store.<name>.duckdns.org
```

## 5. cert-manager

```sh
task cert-manager KUBE_CONTEXT=urumi-vps      # pinned version, CRDs included
```

The chart renders two ClusterIssuers, `letsencrypt-staging` and `letsencrypt-prod` (HTTP-01 through Traefik). The namespace's default-deny NetworkPolicy admits cert-manager's short-lived solver pods from Traefik, so challenges get through.

## 6. Secrets

```sh
task secrets CONTEXT=urumi-vps
```

The same script as locally: it reads `.env.local`, generates database passwords, the credential encryption key, the API-key pepper and the WordPress salts **once** (re-running never rotates them), and never prints values.

## 7. Deploy: staging certificates first

`IMAGE_TAG` defaults to the commit at `origin/main`; check in GitHub Actions that the `images` workflow finished for it.

```sh
task deploy:prod PROD_CONTEXT=urumi-vps DOMAIN=<name>.duckdns.org LETSENCRYPT_EMAIL=<you@example.com> ISSUER=letsencrypt-staging
kubectl --context urumi-vps -n urumi get certificate      # READY True for app-tls and store-tls
```

Staging certificates aren't trusted by browsers, but staging's rate limits are generous, so mistakes are cheap. Once both are ready, switch to the production issuer:

```sh
task deploy:prod PROD_CONTEXT=urumi-vps DOMAIN=<name>.duckdns.org LETSENCRYPT_EMAIL=<you@example.com>
kubectl --context urumi-vps -n urumi delete secret app-tls store-tls     # make cert-manager reissue from letsencrypt-prod
```

`task deploy:prod` runs `helm upgrade --install … --wait --rollback-on-failure`, so a release whose pods don't become ready is rolled back automatically.

## 8. Verify

```sh
task dod CONTEXT=urumi-vps -- --domain=<name>.duckdns.org --scheme=https
```

Then sign in at `https://app.<domain>`. The first admin's login is in the cluster (`task logins` reads the current context; or `kubectl --context urumi-vps -n urumi get secret gateway-bootstrap-admin -o jsonpath='{.data.password}' | base64 -d`), and the first sign-in forces a new password. Create an API key and connect Claude Code:

```sh
claude mcp add --transport http urumi https://app.<domain>/mcp --header "Authorization: Bearer <key>"
```

## 9. Upgrades, rollback and backups

- Upgrades and rollback: [upgrade-and-rollback.md](upgrade-and-rollback.md). Deploying a newer commit is `task deploy:prod … IMAGE_TAG=<sha>`.
- Backups are not automated yet (plan Task 28). Before risky upgrades, take dumps by hand:

  ```sh
  kubectl --context urumi-vps -n urumi exec mariadb-0 -- sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction wordpress' > wordpress.sql
  kubectl --context urumi-vps -n urumi exec postgres-0 -- pg_dump -U urumi urumi > urumi.sql
  ```

## Troubleshooting

- **Certificate stays not ready:** `kubectl -n urumi describe certificate app-tls`, then `kubectl -n urumi get challenges` and describe the challenge. Usually port 80 isn't reachable from the internet (firewall or security list) or DNS doesn't point at the VPS yet.
- **`ImagePullBackOff`:** the tag wasn't built (check the `images` workflow for that commit) or a package was made private.
- **404 from Traefik:** the host name doesn't match the Ingress; check `global.domain` (`helm --kube-context urumi-vps -n urumi get values urumi`).
- **Pods `Pending`:** the node is out of memory or CPU (`kubectl describe pod`); a 2 GB VPS is too small.

## Production rehearsal on a laptop

The commands above were rehearsed locally on a fresh single-node k3s cluster with the production values. Only `values-rehearsal.yaml` differs: nip.io instead of a public domain, and a self-signed issuer instead of Let's Encrypt (which can't reach a laptop).

```sh
task rehearsal:up       # stops the local cluster; creates k3d cluster urumi-rehearsal; installs cert-manager
task rehearsal:deploy   # secrets, then helm upgrade --install with values-prod.yaml + values-rehearsal.yaml and CI's GHCR images
task rehearsal:dod      # the definition-of-done check over HTTPS (--insecure: self-signed certificates)
task rehearsal:down     # deletes the rehearsal cluster and starts the local one again
```
