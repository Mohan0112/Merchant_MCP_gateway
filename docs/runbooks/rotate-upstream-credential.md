# Runbook: rotate an upstream credential

Every upstream MCP server has one static credential, a bearer token or a named header, stored encrypted in the gateway. Rotation means: new value at the source, then the same value in the dashboard. Members and their API keys are unaffected.

> The Helm values seed the in-cluster servers (`woo`, `fx`, `github`) **once**, on the gateway's first start. After that the dashboard is the source of truth: changing a Kubernetes Secret alone doesn't change what the gateway sends.

## A server outside the cluster (for example GitHub)

1. Create the new credential at the source. For GitHub: a new fine-grained token with the same repository and Issues permission.
2. Dashboard → **Servers** → the server's card → **Edit** → paste it into **Credential** → **Test connection** → **Save changes**. Leaving the field empty keeps the stored credential.
3. Check the card shows **Connected** with its tools, then revoke the old credential at the source.
4. Optional, for `task demo:reset` and fresh installs: put the new token in `.env.local` (`GITHUB_MCP_PAT`) and run `task secrets`.

## An in-cluster server (woo-mcp, fx-mcp)

These servers read their expected credential from a Secret at startup (`woo-mcp-auth` key `token`, `fx-mcp-auth` key `api-key`), so both sides change.

1. Generate a new value and restart the server so it accepts only that value:
   ```sh
   node scripts/secrets.mjs --recreate=fx-mcp-auth          # add --context=<ctx> for another cluster
   kubectl -n ahjin rollout restart deployment/fx-mcp
   ```
   The server is now Unreachable in the dashboard with reason **Credential rejected**, because the gateway still sends the old value.
2. Copy the new value **without printing it to the screen**, straight into the clipboard:
   ```sh
   kubectl -n ahjin get secret fx-mcp-auth -o jsonpath='{.data.api-key}' | base64 -d | clip    # Windows; pbcopy on macOS
   ```
3. Dashboard → **Servers** → **fx** → **Edit** → paste into **Credential** → **Test connection** → **Save changes**. The card returns to **Connected**.

For woo-mcp the same applies with `woo-mcp-auth`, key `token`, and `deployment/woo-mcp`.

The WooCommerce REST key that woo-mcp itself uses against the store (`store-woo-api`) is separate. It is registered for the `mcp-bot` user by the store bootstrap: recreate the Secret, restart woo-mcp, and run `task deploy:local` (or `deploy:prod`) so the bootstrap Job registers the new key.

## Afterwards

The audit log shows any calls that failed during the switch with outcome `upstream_unreachable`. Plan rotations for a quiet moment, or rotate the source and the dashboard within a minute of each other.
