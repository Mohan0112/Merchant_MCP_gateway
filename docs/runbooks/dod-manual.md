# Definition of Done: manual browser checklist

The automated check (`task dod`, Task 18) covers everything that doesn't need a browser. These steps are the browser half. Run them before recording the demo. Sections are added as each task lands.

Get the logins first:

```sh
task logins
```

## Store (Tasks 4–5)

1. Open **http://store.127.0.0.1.nip.io/shop/**. You should see four products (Urumi Coffee Mug ₹499, T-Shirt ₹899, Notebook ₹249, Sticker Pack ₹99).
2. Open **Urumi Coffee Mug** and click **Add to cart**, then **View cart**, then **Proceed to checkout**.
3. Fill in the billing details (any name, address in India, email, phone). No shipping section appears, because shipping is turned off on purpose.
4. Choose **Cash on delivery** and click **Place order**. You land on "Order received" with an order number.
5. Open **http://store.127.0.0.1.nip.io/wp-admin/** and log in with the wp-admin user and password from `task logins`.
6. Go to **WooCommerce → Orders**. The new order is listed as **Processing** with payment method **Cash on delivery**.

**If something is off**
- No products: `task store:bootstrap-logs` shows what the bootstrap did.
- "Coming soon" page instead of the shop: the bootstrap sets `woocommerce_coming_soon=no`. Re-run it with `task deploy:local`.
- Checkout says no shipping options: the bootstrap sets `woocommerce_ship_to_countries=disabled`. Check the bootstrap logs.
