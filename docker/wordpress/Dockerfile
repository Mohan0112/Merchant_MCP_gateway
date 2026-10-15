# syntax=docker/dockerfile:1
# WordPress + WooCommerce store image. Code is baked in (immutable); only the database and
# wp-content/uploads are persistent, so upgrades and rollbacks are an image-tag change (ADR-011).
FROM wordpress:7.1.3-php8.4-apache

ARG WOOCOMMERCE_VERSION=11.2.1
ARG STOREFRONT_VERSION=4.6.2
ARG WPCLI_VERSION=2.12.0

COPY mu-plugins/ /tmp/urumi/mu-plugins/
COPY healthz.php /tmp/urumi/healthz.php
COPY bootstrap.sh /usr/local/bin/urumi-bootstrap

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
    chmod +x /usr/local/bin/wp /usr/local/bin/urumi-bootstrap; \
    cp -a /usr/src/wordpress/. /var/www/html/; \
    curl -fsSL -o /tmp/woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    unzip -q /tmp/woocommerce.zip -d /var/www/html/wp-content/plugins/; \
    curl -fsSL -o /tmp/storefront.zip "https://downloads.wordpress.org/theme/storefront.${STOREFRONT_VERSION}.zip"; \
    unzip -q /tmp/storefront.zip -d /var/www/html/wp-content/themes/; \
    cp -a /tmp/urumi/mu-plugins /var/www/html/wp-content/; \
    cp /tmp/urumi/healthz.php /var/www/html/healthz.php; \
    mkdir -p /var/www/html/wp-content/uploads; \
    chown -R www-data:www-data /var/www/html /var/run/apache2 /var/lock/apache2; \
    sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf; \
    rm -rf /tmp/woocommerce.zip /tmp/storefront.zip /tmp/urumi; \
    apt-get purge -y --auto-remove unzip; \
    rm -rf /var/lib/apt/lists/*

USER 33:33
EXPOSE 8080
