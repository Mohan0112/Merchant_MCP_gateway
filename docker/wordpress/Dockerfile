# syntax=docker/dockerfile:1
# WordPress + WooCommerce store image. Code is baked in (immutable); only the database and
# wp-content/uploads are persistent, so upgrades and rollbacks are an image-tag change (ADR-011).
FROM wordpress:7.1.3-php8.4-apache

ARG WOOCOMMERCE_VERSION=11.2.1
ARG STOREFRONT_VERSION=4.6.2
ARG WPCLI_VERSION=2.12.0

COPY mu-plugins/ /tmp/ahjin/mu-plugins/
COPY healthz.php /tmp/ahjin/healthz.php
COPY htaccess /tmp/ahjin/htaccess

# One layer builds the whole document root, so nothing is stored twice:
# - WordPress core is copied from the image's source tree. The official entrypoint skips its own
#   copy at startup because index.php already exists, so containers start without copying files.
# - WooCommerce and Storefront are unpacked straight into wp-content; WP-CLI is used by the
#   bootstrap Job and the wp-cron CronJob.
# - wp-content/uploads is pre-created so the persistent volume mounts onto a directory www-data owns.
# - Apache listens on 8080 so it can run as www-data (uid 33) without root.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends unzip; \
    curl -fsSL -o /usr/local/bin/wp \
      "https://github.com/wp-cli/wp-cli/releases/download/v${WPCLI_VERSION}/wp-cli-${WPCLI_VERSION}.phar"; \
    chmod +x /usr/local/bin/wp; \
    cp -a /usr/src/wordpress/. /var/www/html/; \
    curl -fsSL -o /tmp/woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    unzip -q /tmp/woocommerce.zip -d /var/www/html/wp-content/plugins/; \
    curl -fsSL -o /tmp/storefront.zip "https://downloads.wordpress.org/theme/storefront.${STOREFRONT_VERSION}.zip"; \
    unzip -q /tmp/storefront.zip -d /var/www/html/wp-content/themes/; \
    cp -a /tmp/ahjin/mu-plugins /var/www/html/wp-content/; \
    cp /tmp/ahjin/healthz.php /var/www/html/healthz.php; \
    cp /tmp/ahjin/htaccess /var/www/html/.htaccess; \
    mkdir -p /var/www/html/wp-content/uploads; \
    chown -R www-data:www-data /var/www/html /var/run/apache2 /var/lock/apache2; \
    sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf; \
    rm -rf /tmp/woocommerce.zip /tmp/storefront.zip /tmp/ahjin; \
    apt-get purge -y --auto-remove unzip; \
    rm -rf /var/lib/apt/lists/*

# Small, often-changed layers last, so editing them doesn't re-run the downloads above:
# the Ahjin child theme, the catalogue the bootstrap seeds (products.json, photos, seed.php)
# and the bootstrap script itself.
COPY --chown=33:33 theme/ahjin/ /var/www/html/wp-content/themes/ahjin/
COPY catalog/ /usr/local/share/ahjin/catalog/
COPY --chmod=755 bootstrap.sh /usr/local/bin/ahjin-bootstrap

USER 33:33
EXPOSE 8080
