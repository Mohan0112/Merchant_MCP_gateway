#!/usr/bin/env bash
# Store bootstrap, run by a Helm post-install/post-upgrade hook Job (and the wp-cron CronJob).
#
#   ahjin-bootstrap          install and configure the store (idempotent: safe on every upgrade)
#   ahjin-bootstrap cron     run due WP-Cron events (DISABLE_WP_CRON is on in wp-config)
#
# Every step checks before it acts, so re-running changes nothing when the store is already set up.
set -euo pipefail

WP_PATH=/var/www/html
wp() { command wp --path="$WP_PATH" --no-color "$@"; }
log() { echo "[bootstrap] $*"; }

# The official image writes wp-config.php only when it starts Apache, so Jobs create it from the
# same env-driven template.
ensure_config() {
  if [ ! -s "$WP_PATH/wp-config.php" ]; then
    cp "$WP_PATH/wp-config-docker.php" "$WP_PATH/wp-config.php"
  fi
}

wait_for_db() {
  local attempts="${1:-60}"
  for attempt in $(seq 1 "$attempts"); do
    if [ "$(php "$WP_PATH/healthz.php" 2>/dev/null)" = "ok" ]; then
      log "database reachable"
      return 0
    fi
    log "waiting for database ($attempt/$attempts)"
    sleep 3
  done
  log "database not reachable after $((attempts * 3))s"
  return 1
}

ensure_config

if [ "${1:-}" = "cron" ]; then
  # k3s admits a new pod through MariaDB's NetworkPolicy a moment after the pod starts (the policy
  # controller adds its IP asynchronously), so the first connection attempt can be refused.
  wait_for_db 10
  wp cron event run --due-now
  exit 0
fi

: "${WP_ADMIN_USER:?}" "${WP_ADMIN_EMAIL:?}" "${WP_ADMIN_PASSWORD:?}"
: "${WOO_CONSUMER_KEY:?}" "${WOO_CONSUMER_SECRET:?}" "${WP_HOME_URL:?}"
STORE_NAME="${STORE_NAME:-Ahjin}"
STORE_CURRENCY="${STORE_CURRENCY:-INR}"
STORE_TIMEZONE="${STORE_TIMEZONE:-Asia/Kolkata}"
STORE_COUNTRY="${STORE_COUNTRY:-IN:KA}"
STORE_CITY="${STORE_CITY:-Bengaluru}"
STORE_ADDRESS="${STORE_ADDRESS:-1 MG Road}"
STORE_POSTCODE="${STORE_POSTCODE:-560001}"
MCP_USER=mcp-bot

wait_for_db

# 1. WordPress core
if wp core is-installed; then
  log "WordPress already installed"
else
  wp core install --url="$WP_HOME_URL" --title="$STORE_NAME" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
  log "WordPress installed"
fi
wp option update blogname "$STORE_NAME" >/dev/null
wp option update timezone_string "$STORE_TIMEZONE" >/dev/null
wp rewrite structure '/%postname%/' >/dev/null

# 2. WooCommerce and the theme: Ahjin, a Storefront child theme (both baked into the image)
wp plugin is-active woocommerce || wp plugin activate woocommerce
[ "$(wp option get stylesheet)" = "ahjin" ] || wp theme activate ahjin
wp wc update >/dev/null 2>&1 || true   # pending WooCommerce DB migrations (no-op when current)

# 3. Store settings
wp option update woocommerce_currency "$STORE_CURRENCY" >/dev/null
wp option update woocommerce_default_country "$STORE_COUNTRY" >/dev/null
wp option update woocommerce_store_city "$STORE_CITY" >/dev/null
wp option update woocommerce_store_address "$STORE_ADDRESS" >/dev/null
wp option update woocommerce_store_postcode "$STORE_POSTCODE" >/dev/null
# New stores start in "Coming soon" mode, which hides the shop from visitors.
wp option update woocommerce_coming_soon no >/dev/null
wp option update woocommerce_store_pages_only no >/dev/null
# No shipping: cash-on-delivery checkout must not be blocked by missing shipping methods.
wp option update woocommerce_ship_to_countries disabled >/dev/null
wp option update woocommerce_enable_guest_checkout yes >/dev/null
wp option update woocommerce_allow_tracking no >/dev/null
wp option update woocommerce_show_marketplace_suggestions no >/dev/null
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
wp option update blogdescription "Laptops for work, play and everything in between" >/dev/null
# Product photos are landscape: 4:3 cards, sized for sharp three-column grids. Set before any image
# is imported, because WordPress generates the sizes at import time.
wp option update woocommerce_thumbnail_cropping custom >/dev/null
wp option update woocommerce_thumbnail_cropping_custom_width 4 >/dev/null
wp option update woocommerce_thumbnail_cropping_custom_height 3 >/dev/null
wp option update woocommerce_thumbnail_image_width 600 >/dev/null
wp option update woocommerce_single_image_width 900 >/dev/null
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash when your order is delivered.","instructions":"Pay with cash when your order is delivered.","enable_for_methods":[],"enable_for_virtual":"yes"}' >/dev/null
log "store settings applied (currency $STORE_CURRENCY, timezone $STORE_TIMEZONE, cash on delivery on)"

# 4. Shop, cart, checkout and my-account pages
wp wc tool run install_pages --user="$WP_ADMIN_USER" >/dev/null
log "WooCommerce pages ensured"

# 5. Least-privilege user for woo-mcp and its REST key (ADR-0002)
if wp user get "$MCP_USER" --field=ID >/dev/null 2>&1; then
  wp user set-role "$MCP_USER" shop_manager >/dev/null
else
  wp user create "$MCP_USER" "mcp-bot@ahjin.local" --role=shop_manager \
    --user_pass="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" >/dev/null
  log "created user $MCP_USER (shop_manager)"
fi
# Replace the key on every run, so a rotated Secret takes effect. Stored with WooCommerce's own hash.
wp eval '
  global $wpdb;
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $user  = get_user_by("login", "mcp-bot");
  $ck    = getenv("WOO_CONSUMER_KEY");
  $cs    = getenv("WOO_CONSUMER_SECRET");
  $wpdb->delete($table, ["user_id" => $user->ID, "description" => "ahjin-mcp"]);
  $wpdb->insert($table, [
    "user_id"         => $user->ID,
    "description"     => "ahjin-mcp",
    "permissions"     => "read_write",
    "consumer_key"    => wc_api_hash($ck),
    "consumer_secret" => $cs,
    "truncated_key"   => substr($ck, -7),
  ]);
'
log "REST key for $MCP_USER in place"

# 6. The laptop catalogue: categories, brands, products with specs and photos (catalog/seed.php;
#    products are matched by SKU and created once, so re-runs never duplicate or overwrite them)
wp eval-file /usr/local/share/ahjin/catalog/seed.php --user="$WP_ADMIN_USER"
# Image sizes come from the theme; create any size a newer theme version added (quick when none is).
wp media regenerate --only-missing --yes >/dev/null || log "warning: some image sizes could not be generated"

# 7. Home page, menu, and no WordPress sample content
home_id="$(wp post list --post_type=page --name=home --field=ID --format=ids)"
if [ -z "$home_id" ]; then
  home_id="$(wp post create --post_type=page --post_title=Home --post_name=home --post_status=publish --porcelain)"
  log "created the home page"
fi
wp post meta update "$home_id" _wp_page_template template-homepage.php >/dev/null
wp option update show_on_front page >/dev/null
wp option update page_on_front "$home_id" >/dev/null
for sample in "post hello-world" "page sample-page"; do
  set -- $sample
  id="$(wp post list --post_type="$1" --name="$2" --field=ID --format=ids)"
  [ -z "$id" ] || wp post delete "$id" --force >/dev/null
done
if ! wp menu list --fields=slug --format=csv | grep -qx main; then
  wp menu create Main >/dev/null
  wp menu item add-post main "$(wp option get woocommerce_shop_page_id)" --title="All laptops" >/dev/null
  for slug in gaming ultrabooks creators business 2-in-1 everyday; do
    term_id="$(wp term get product_cat "$slug" --by=slug --field=term_id 2>/dev/null || true)"
    [ -z "$term_id" ] || wp menu item add-term main product_cat "$term_id" >/dev/null
  done
  log "created the main menu"
fi
wp menu location assign main primary >/dev/null
wp menu location assign main handheld >/dev/null

wp rewrite flush >/dev/null
log "done: $(wp post list --post_type=product --post_status=publish --format=count) products, store URL $WP_HOME_URL"
