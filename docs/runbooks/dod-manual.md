# Definition of Done: manual browser checklist

`task dod` checks the brief's whole definition of done through the APIs. This checklist is the same flow by hand, in a browser and a real MCP client, with two users. Run it before recording the demo; [../demo-script.md](../demo-script.md) is the recording version of it.

## Before you start

```sh
task demo:reset     # no orders, the 19-laptop catalogue, all servers connected, users A and B, empty audit log
task logins         # wp-admin, your dashboard admin, and users A and B
```

Use three browser profiles (or one normal and two private windows): **Admin** (your account), **User A** and **User B**. Your admin account asks for a new password at its first sign-in.

## Store

1. Open **http://store.127.0.0.1.nip.io/shop/**: 19 laptops in six categories, with photos, specifications, sale prices and stock.
2. Open **Dell XPS 13** → **Add to cart** → **View cart** → **Proceed to checkout**.
3. Fill in the billing details (any name, an address in India, email, phone). There's no shipping section: shipping is off on purpose.
4. Choose **Cash on delivery** → **Place order**. You land on "Order received" with an order number.
5. **http://store.127.0.0.1.nip.io/wp-admin/** with the wp-admin login → **WooCommerce → Orders**: the order is **Processing**, paid by **Cash on delivery**.

## Admin view

1. Sign in at **http://app.127.0.0.1.nip.io** as Admin. **Servers** shows **woo** (WooCommerce store, 7 tools), **fx** (4) and **github** (10), all **Connected**. Click **woo** to see its tools.
2. **Members** lists User A and User B as members.

## Chat agent, as User A

1. Sign in as User A → **Chat**.
2. Ask: `Create a product named "Ahjin Laptop Sleeve 14" with a price of 1499.` A card for `woo__create_product` appears, with its arguments and result; the answer confirms the product.
3. Reload **http://store.127.0.0.1.nip.io/shop/**: the sleeve is listed. Order it by hand (as in Store, steps 2–4).
4. Back in the chat: `What orders came in today?` The agent calls `woo__list_orders` and lists the order you just placed.

## External MCP client, as User B

1. Sign in as User B → **API keys** → **New key** → name `Claude Code` → **Create key**. Copy the key; it's shown once. The dialog has ready-made settings per client.
2. In a terminal:
   ```sh
   claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <B's key>"
   claude                       # then: /mcp  → urumi connected, 21 tools
   ```
   (Or MCP Inspector: `npx @modelcontextprotocol/inspector`, Streamable HTTP, URL `http://app.127.0.0.1.nip.io/mcp`, header `Authorization: Bearer <key>`, **List Tools**.)
3. Ask Claude Code: `What orders came in today?`: it uses `woo__list_orders` and finds both orders.
4. Ask: `What is the total of today's orders in US dollars?`: it uses `woo__list_orders` and `fx__convert_currency`, two upstream servers in one prompt.

## Team and control

1. **Revoke:** as User B (or Admin → **Members** → User B → **API keys**), **Revoke** the key. The next Claude Code request fails with 401 `invalid_token`.
2. **Disable:** as Admin, switch **fx** off on its card. Its tools disappear: User A asks `Convert 100 USD to INR` and the agent has no fx tool; a client with a valid key no longer lists `fx__…` (Claude Code updates via `list_changed`; in Inspector click **List Tools**). Switch it back on.
3. **Kill:** stop the fx server and keep it down:
   ```sh
   kubectl -n urumi scale deployment fx-mcp --replicas=0
   ```
   Within about 20 s the **fx** card shows **Unreachable · Connection refused**, and `woo__…` tools keep working (ask the orders question again). Bring it back with `--replicas=1`; it reconnects by itself. (Deleting the pod instead works too, but the Deployment replaces it within seconds.)
4. **Audit log:** as Admin, **Audit log** lists every call above: User A's with **Via** `chat_agent`, User B's with `mcp_client`, including the rejected call after revocation (`denied_auth`), the call to the disabled server (`rejected_disabled`) and to the dead one (`upstream_unreachable` or `timeout`). As User B, the audit log shows only B's own calls.

## If something is off

- No products, or a "Coming soon" page: `task store:bootstrap-logs`; `task deploy:local` runs the bootstrap again.
- Checkout says there are no shipping options: the bootstrap sets `woocommerce_ship_to_countries=disabled`; check its logs.
- A server stays Unreachable: [upstream-unreachable.md](upstream-unreachable.md).
- The chat says the LLM is rate-limited: wait a minute, or set `GEMINI_API_KEY` too (the fallback), then `task secrets` and `task deploy:local`.
