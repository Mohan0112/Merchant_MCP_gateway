# ADR-0002: woo-mcp talks to WooCommerce over the REST API with Basic Auth

- **Status:** Accepted (validated by Spike A, see `docs/spikes.md`)
- **Date:** 2026-10-15

## Context

The WooCommerce MCP server must read and write products and orders. The brief asks us to document how it talks to the store and why. Traffic between `woo-mcp` and WordPress stays inside the cluster over plain HTTP, and WooCommerce only accepts Basic Auth (consumer key and secret) on requests it considers HTTPS. Over plain HTTP it requires OAuth 1.0a signatures, which are built from the site's public home URL and break when the request goes to an internal host name.

## Decision

- Use the **WooCommerce REST API v3** as a dedicated WordPress user `mcp-bot` with the **`shop_manager`** role (products and orders, but no plugins, users or settings).
- Authenticate with **HTTP Basic Auth** using a REST key generated from a Kubernetes Secret. The bootstrap Job stores the key with WooCommerce's own `wc_api_hash()`.
- Bake a must-use plugin `ahjin-internal-https.php` into the store image. It sets `$_SERVER['HTTPS'] = 'on'` **only when the request's `Host` header equals `AHJIN_INTERNAL_HOST`** (the in-cluster Service name).
- `woo-mcp` rewrites store URLs in responses to the public store URL. WordPress emits `https://` URLs on internal requests because of the plugin.

## Consequences

- Standard WooCommerce authentication with no signing code and no Kubernetes API permissions.
- Business logic (validation, stock, hooks, emails) runs exactly as for any WooCommerce client.
- Public traffic can't trigger the plugin. Traefik only routes `store.<domain>` to WordPress, and NetworkPolicy only lets Traefik and `woo-mcp` reach the WordPress pod. Spike A showed a request with the public host and valid credentials gets 401.
- Basic Auth credentials cross the pod network in clear text, restricted by NetworkPolicy. mTLS is a documented production gap.

## Alternatives considered

- **OAuth 1.0a over HTTP:** WooCommerce signs against the home URL, so calling the internal Service name needs a forged signature base. It's fragile and harder to explain.
- **WP-CLI through `kubectl exec`:** needs `pods/exec` permission (close to cluster-admin), couples the MCP server to pod names, and parses CLI text.
- **Direct SQL to MariaDB:** bypasses WooCommerce's business logic and breaks across WooCommerce versions.
