# Runbook: revoke a compromised API key

Use this when a key may have leaked: committed to a repo, pasted in a chat, left on a lost laptop.

## 1. Revoke it (takes effect on the next request)

- **The key's owner:** dashboard → **API keys** → **Revoke** next to the key, and confirm.
- **An admin, for anyone:** **Members** → the person's row → **API keys** → **Revoke**.
- **Can't tell which key leaked?** An admin can **Disable** the member on the **Members** page. That ends their dashboard sessions and stops all their keys at once. **Enable** them again once new keys are issued.

`/mcp` authenticates every request, and no MCP session outlives a key: the next call with it gets HTTP 401 `invalid_token` and is audited as `denied_auth`.

## 2. Find out what it was used for

Dashboard → **Audit log**. An admin sets the user filter to the key's owner; members can only see their own entries anyway. Then:

- Look at entries since the suspected leak: tools, servers, times and outcomes. Calls made with an API key have channel `mcp_client`; the owner's own chat calls have `chat_agent`.
- After the revocation, `denied_auth` entries mean someone is still trying the key.
- Check the key's **Last used** time in the key list, compared with when the owner last used it themselves.

With database access you can also filter by the key itself:

```sh
echo "select occurred_at, server_slug, tool_name, outcome from audit_logs where api_key_id = (select id from api_keys where prefix = '<8-char prefix>') order by occurred_at desc limit 50;" \
  | kubectl -n urumi exec -i postgres-0 -- psql -U urumi -d urumi
```

The prefix is the part after `umcp_` shown in the key list (`umcp_<prefix>_…`).

## 3. Repair and follow up

- Undo unwanted changes the key made, using each audit entry's server and tool. For example, restore an order's status in WooCommerce admin, or close a GitHub issue.
- If the key reached tools that use a shared upstream credential in a way that may have exposed it, rotate that credential too: [rotate-upstream-credential.md](rotate-upstream-credential.md). A key alone never reveals an upstream credential.
- Tell the owner, and have them create a new key (**API keys** → **New key**) with an expiry.
