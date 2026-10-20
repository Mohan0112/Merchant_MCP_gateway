<?php
/**
 * Ahjin: a Storefront child theme for the Ahjin laptop store (demo).
 *
 * style.css holds the look; this file changes Storefront's layout and home page in code, so the
 * design is versioned with the image instead of living in Customizer settings in the database.
 */

defined( 'ABSPATH' ) || exit;

/** The shop's category links, in catalogue order (used by the header, home page and footer). */
function ahjin_categories(): array {
	$terms = get_terms(
		array(
			'taxonomy'   => 'product_cat',
			'hide_empty' => true,
			'parent'     => 0,
			'orderby'    => 'meta_value_num',
			'meta_key'   => 'order', // phpcs:ignore WordPress.DB.SlowDBQuery
			'exclude'    => array( (int) get_option( 'default_product_cat' ) ),
		)
	);
	return is_wp_error( $terms ) ? array() : $terms;
}

function ahjin_icon( string $name ): string {
	$paths = array(
		'truck'  => 'M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
		'cash'   => 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v4M18 10v4',
		'shield' => 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
		'swap'   => 'M7 7h11l-3-3M17 17H6l3 3',
	);
	return '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' . esc_attr( $paths[ $name ] ) . '"/></svg>';
}

// Storefront's colour settings, so the Customizer's inline CSS agrees with style.css.
add_filter(
	'storefront_setting_default_values',
	fn( $defaults ) => array_merge(
		$defaults,
		array(
			'storefront_heading_color'               => '#0b1220',
			'storefront_text_color'                  => '#475569',
			'storefront_accent_color'                => '#2563eb',
			'storefront_header_background_color'     => '#0b1220',
			'storefront_header_text_color'           => '#cbd5e1',
			'storefront_header_link_color'           => '#ffffff',
			'storefront_footer_background_color'     => '#0b1220',
			'storefront_footer_heading_color'        => '#ffffff',
			'storefront_footer_text_color'           => '#94a3b8',
			'storefront_footer_link_color'           => '#e2e8f0',
			'storefront_button_background_color'     => '#2563eb',
			'storefront_button_text_color'           => '#ffffff',
			'storefront_button_alt_background_color' => '#2563eb',
			'storefront_button_alt_text_color'       => '#ffffff',
		)
	)
);

// Image sizes for wide product photos (Storefront's 416 px and 324 px look soft on large screens).
// Theme support wins over WooCommerce's settings, so the sizes are set here.
add_filter(
	'storefront_woocommerce_args',
	fn( $args ) => array_merge( $args, array( 'single_image_width' => 900, 'thumbnail_image_width' => 600, 'gallery_thumbnail_image_width' => 160 ) )
);
// Whole rupees: laptops aren't priced in paise.
add_filter( 'wc_get_price_decimals', fn() => 0 );

// Full-width pages everywhere: no sidebar of blog widgets next to the products.
add_action( 'wp', fn() => remove_action( 'storefront_sidebar', 'storefront_get_sidebar', 10 ) );
add_filter(
	'body_class',
	fn( $classes ) => array_merge( array_diff( $classes, array( 'right-sidebar', 'left-sidebar' ) ), array( 'storefront-full-width-content', 'ahjin' ) )
);
// Storefront repeats the sorting box, result count and page numbers above and below the grid.
// Keep sorting and the count on top, and the page numbers only at the bottom.
add_action(
	'init',
	function () {
		remove_action( 'woocommerce_after_shop_loop', 'woocommerce_catalog_ordering', 10 );
		remove_action( 'woocommerce_after_shop_loop', 'woocommerce_result_count', 20 );
		remove_action( 'woocommerce_before_shop_loop', 'storefront_woocommerce_pagination', 30 );
	}
);
add_filter( 'storefront_loop_columns', fn() => 3 );
add_filter( 'loop_shop_per_page', fn() => 12 );
add_filter( 'woocommerce_output_related_products_args', fn( $args ) => array_merge( $args, array( 'posts_per_page' => 3, 'columns' => 3 ) ) );

// A slim announcement bar above the header.
add_action(
	'storefront_before_header',
	function () {
		echo '<div class="ah-topbar"><div class="col-full">Free delivery across India &middot; Cash on delivery &middot; 1-year warranty on every laptop</div></div>';
	}
);

// Product cards: the brand above the name and the key specs below it.
add_action(
	'woocommerce_before_shop_loop_item_title',
	function () {
		global $product;
		$brands = taxonomy_exists( 'product_brand' ) ? wp_get_post_terms( $product->get_id(), 'product_brand', array( 'fields' => 'names' ) ) : array();
		if ( $brands && ! is_wp_error( $brands ) ) {
			echo '<span class="ah-card-brand">' . esc_html( $brands[0] ) . '</span>';
		}
	},
	20
);
add_action(
	'woocommerce_after_shop_loop_item_title',
	function () {
		global $product;
		$specs = array_filter( array_map( fn( $name ) => $product->get_attribute( $name ), array( 'Processor', 'Memory', 'Storage' ) ) );
		if ( $specs ) {
			echo '<p class="ah-card-specs">' . esc_html( implode( ' · ', $specs ) ) . '</p>';
		}
	},
	5
);

// Product page: the key specs next to the price, a reassurance line under the button, and
// "Specifications" instead of "Additional information".
add_action(
	'woocommerce_single_product_summary',
	function () {
		global $product;
		$rows = '';
		foreach ( array( 'Processor', 'Graphics', 'Memory', 'Storage', 'Display', 'Battery' ) as $name ) {
			$value = $product->get_attribute( $name );
			if ( $value ) {
				$rows .= '<div><dt>' . esc_html( $name ) . '</dt><dd>' . esc_html( $value ) . '</dd></div>';
			}
		}
		if ( $rows ) {
			echo '<dl class="ah-keyspecs">' . $rows . '</dl>'; // phpcs:ignore WordPress.Security.EscapeOutput -- escaped above
		}
	},
	25
);
add_action(
	'woocommerce_single_product_summary',
	function () {
		echo '<ul class="ah-assurance"><li>' . ahjin_icon( 'truck' ) . 'Free delivery in 3–5 days</li><li>' . ahjin_icon( 'cash' ) . 'Cash on delivery</li><li>' . ahjin_icon( 'shield' ) . '1-year warranty</li></ul>'; // phpcs:ignore WordPress.Security.EscapeOutput
	},
	35
);
add_filter(
	'woocommerce_product_tabs',
	function ( $tabs ) {
		if ( isset( $tabs['additional_information'] ) ) {
			$tabs['additional_information']['title'] = 'Specifications';
		}
		return $tabs;
	}
);

// Home page: a hero, store perks, categories, then product rows. Storefront's own page-content
// section, popular products, best sellers and brand logos (none are uploaded) are left out.
add_action(
	'init',
	function () {
		remove_action( 'homepage', 'storefront_homepage_content', 10 );
		remove_action( 'homepage', 'storefront_popular_products', 50 );
		remove_action( 'homepage', 'storefront_best_selling_products', 70 );
		remove_action( 'homepage', 'storefront_woocommerce_brands_homepage_section', 80 );
		remove_action( 'homepage', 'storefront_recent_products', 30 );
		remove_action( 'homepage', 'storefront_featured_products', 40 );
		remove_action( 'homepage', 'storefront_on_sale_products', 60 );
		add_action( 'homepage', 'storefront_featured_products', 25 );
		add_action( 'homepage', 'storefront_on_sale_products', 30 );
		add_action( 'homepage', 'storefront_recent_products', 35 );
	}
);
add_filter( 'storefront_product_categories_args', fn( $args ) => array_merge( $args, array( 'limit' => 6, 'columns' => 3, 'title' => 'Shop by category' ) ) );
add_filter( 'storefront_featured_products_args', fn( $args ) => array_merge( $args, array( 'limit' => 4, 'columns' => 4, 'title' => 'Featured laptops' ) ) );
add_filter( 'storefront_on_sale_products_args', fn( $args ) => array_merge( $args, array( 'limit' => 4, 'columns' => 4, 'title' => 'Deals of the week' ) ) );
add_filter( 'storefront_recent_products_args', fn( $args ) => array_merge( $args, array( 'limit' => 4, 'columns' => 4, 'title' => 'New arrivals' ) ) );

add_action(
	'homepage',
	function () {
		$shop   = wc_get_page_permalink( 'shop' );
		$gaming = get_term_link( 'gaming', 'product_cat' );
		?>
		<section class="ah-hero">
			<div class="ah-hero__inner">
				<p class="ah-hero__eyebrow">New season deals &middot; up to 12% off</p>
				<h1 class="ah-hero__title">The right laptop for how you work and play</h1>
				<p class="ah-hero__text">Ultrabooks, gaming machines and creator workstations from Apple, Dell, Alienware, Lenovo, HP, ASUS, Acer and Microsoft. Pay when it arrives.</p>
				<p class="ah-hero__actions">
					<a class="button ah-button" href="<?php echo esc_url( $shop ); ?>">Shop all laptops</a>
					<?php if ( ! is_wp_error( $gaming ) ) : ?>
						<a class="button ah-button ah-button--ghost" href="<?php echo esc_url( $gaming ); ?>">Explore gaming</a>
					<?php endif; ?>
				</p>
			</div>
		</section>
		<section class="ah-perks">
			<div><?php echo ahjin_icon( 'truck' ); // phpcs:ignore ?><strong>Free delivery</strong><span>Anywhere in India, in 3–5 days</span></div>
			<div><?php echo ahjin_icon( 'cash' ); // phpcs:ignore ?><strong>Cash on delivery</strong><span>Pay when your laptop arrives</span></div>
			<div><?php echo ahjin_icon( 'shield' ); // phpcs:ignore ?><strong>1-year warranty</strong><span>On every laptop we sell</span></div>
			<div><?php echo ahjin_icon( 'swap' ); // phpcs:ignore ?><strong>7-day replacement</strong><span>If it arrives damaged</span></div>
		</section>
		<?php
	},
	5
);

add_action(
	'homepage',
	function () {
		$brands = taxonomy_exists( 'product_brand' ) ? get_terms( array( 'taxonomy' => 'product_brand', 'hide_empty' => true ) ) : array();
		if ( ! $brands || is_wp_error( $brands ) ) {
			return;
		}
		echo '<section class="ah-brands"><h2 class="section-title">Brands we carry</h2><ul>';
		foreach ( $brands as $brand ) {
			echo '<li><a href="' . esc_url( get_term_link( $brand ) ) . '">' . esc_html( $brand->name ) . '</a></li>';
		}
		echo '</ul></section>';
	},
	60
);

// Footer: shop links and store information instead of Storefront's credit line.
add_filter( 'storefront_credit_link', '__return_false' );
add_filter( 'storefront_copyright_text', fn() => '© ' . gmdate( 'Y' ) . ' Ahjin. A demo store: products and prices are sample data.' );
add_action(
	'storefront_footer',
	function () {
		$links = '';
		foreach ( ahjin_categories() as $term ) {
			$links .= '<li><a href="' . esc_url( get_term_link( $term ) ) . '">' . esc_html( $term->name ) . '</a></li>';
		}
		?>
		<div class="ah-footer">
			<div>
				<p class="ah-footer__brand">Ahjin</p>
				<p>Laptops for work, play and everything in between. 1 MG Road, Bengaluru 560001.</p>
			</div>
			<div><h3>Shop</h3><ul><?php echo $links; // phpcs:ignore ?></ul></div>
			<div><h3>Help</h3><ul><li>Cash on delivery</li><li>Free delivery across India</li><li>1-year warranty</li><li>7-day replacement</li></ul></div>
			<div><h3>Account</h3><ul>
				<li><a href="<?php echo esc_url( wc_get_page_permalink( 'myaccount' ) ); ?>">My account</a></li>
				<li><a href="<?php echo esc_url( wc_get_cart_url() ); ?>">Cart</a></li>
				<li><a href="<?php echo esc_url( wc_get_checkout_url() ); ?>">Checkout</a></li>
			</ul></div>
		</div>
		<?php
	},
	5
);
