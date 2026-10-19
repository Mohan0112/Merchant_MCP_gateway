<?php
/**
 * Seeds the laptop catalogue from products.json (run by the store bootstrap through `wp eval-file`):
 * categories with images, brands, and products with specs, stock and photos.
 *
 * Idempotent. A product is matched by SKU and created only when missing, so prices or stock an
 * admin changes in wp-admin survive later runs; images are attached only when a product or a
 * category has none.
 */

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$dir     = __DIR__;
$catalog = json_decode( file_get_contents( "$dir/products.json" ), true );
if ( ! $catalog ) {
	WP_CLI::error( 'catalog/products.json is not valid JSON' );
}

/** Imports an image once; later calls with the same file return the existing attachment. */
function ahjin_image( string $path, string $title, int $parent = 0 ): int {
	$file     = basename( $path );
	$existing = get_posts(
		array(
			'post_type'   => 'attachment',
			'post_status' => 'inherit',
			'meta_key'    => '_ahjin_source',
			'meta_value'  => $file,
			'fields'      => 'ids',
			'numberposts' => 1,
		)
	);
	if ( $existing ) {
		return (int) $existing[0];
	}
	$tmp = wp_tempnam( $file );
	copy( $path, $tmp );
	$id = media_handle_sideload( array( 'name' => $file, 'tmp_name' => $tmp ), $parent, $title );
	if ( is_wp_error( $id ) ) {
		@unlink( $tmp );
		WP_CLI::warning( "image $file: " . $id->get_error_message() );
		return 0;
	}
	update_post_meta( $id, '_ahjin_source', $file );
	update_post_meta( $id, '_wp_attachment_image_alt', $title );
	return (int) $id;
}

// 1. Categories, in display order.
$categories = array();
foreach ( $catalog['categories'] as $position => $category ) {
	$term = term_exists( $category['slug'], 'product_cat' );
	if ( ! $term ) {
		$term = wp_insert_term( $category['name'], 'product_cat', array( 'slug' => $category['slug'], 'description' => $category['description'] ) );
	}
	$categories[ $category['slug'] ] = (int) $term['term_id'];
	update_term_meta( (int) $term['term_id'], 'order', $position );
}

// 2. Products.
$created = 0;
foreach ( $catalog['products'] as $item ) {
	$id = wc_get_product_id_by_sku( $item['sku'] );
	if ( ! $id ) {
		$product = new WC_Product_Simple();
		$product->set_sku( $item['sku'] );
		$product->set_name( $item['name'] );
		$product->set_status( 'publish' );
		$product->set_regular_price( $item['regular'] );
		if ( ! empty( $item['sale'] ) ) {
			$product->set_sale_price( $item['sale'] );
		}
		$product->set_short_description( $item['short'] );
		$product->set_description( $item['description'] );
		$product->set_category_ids( array( $categories[ $item['category'] ] ) );
		$product->set_featured( ! empty( $item['featured'] ) );
		$product->set_manage_stock( true );
		$product->set_stock_quantity( $item['stock'] );
		$attributes = array();
		foreach ( $item['specs'] as $name => $value ) {
			$attribute = new WC_Product_Attribute();
			$attribute->set_name( $name );
			$attribute->set_options( array( $value ) );
			$attribute->set_visible( true );
			$attribute->set_variation( false );
			$attributes[] = $attribute;
		}
		$product->set_attributes( $attributes );
		$id = $product->save();
		++$created;
	}
	$product = wc_get_product( $id );

	// Brands are built into WooCommerce since 9.6 (taxonomy product_brand).
	if ( taxonomy_exists( 'product_brand' ) ) {
		if ( ! term_exists( $item['brand'], 'product_brand' ) ) {
			wp_insert_term( $item['brand'], 'product_brand' );
		}
		wp_set_object_terms( $id, $item['brand'], 'product_brand' );
	}

	if ( ! $product->get_image_id() ) {
		$images = array_map( fn( $file ) => ahjin_image( "$dir/images/$file", $item['name'], $id ), $item['images'] );
		$product->set_image_id( array_shift( $images ) );
		$product->set_gallery_image_ids( array_filter( $images ) );
		$product->save();
	}
}

// 3. Category tiles on the home page use these images.
foreach ( $catalog['categories'] as $category ) {
	$term_id = $categories[ $category['slug'] ];
	if ( ! get_term_meta( $term_id, 'thumbnail_id', true ) ) {
		update_term_meta( $term_id, 'thumbnail_id', ahjin_image( "$dir/images/{$category['image']}", $category['name'] ) );
	}
}

// 4. WooCommerce's placeholder, shown for products without a photo. Bootstrap runs from before the
//    uploads volume was mounted into the Job left an attachment whose file no longer exists.
$placeholder = (int) get_option( 'woocommerce_placeholder_image', 0 );
$source      = current( array_filter( array_map( fn( $ext ) => WC()->plugin_path() . "/assets/images/placeholder-attachment.$ext", array( 'webp', 'png' ) ), 'file_exists' ) );
if ( ( ! $placeholder || ! file_exists( (string) get_attached_file( $placeholder ) ) ) && $source ) {
	update_option( 'woocommerce_placeholder_image', ahjin_image( $source, 'Placeholder' ) );
	WP_CLI::log( 'placeholder image restored' );
}
// Delete placeholder attachments whose file is gone, so `wp media regenerate` doesn't trip on them.
$current = (int) get_option( 'woocommerce_placeholder_image', 0 );
foreach ( get_posts( array( 'post_type' => 'attachment', 'post_status' => 'inherit', 'name' => 'woocommerce-placeholder', 'fields' => 'ids', 'numberposts' => -1 ) ) as $orphan ) {
	if ( $orphan !== $current && ! file_exists( (string) get_attached_file( $orphan ) ) ) {
		wp_delete_attachment( $orphan, true );
		WP_CLI::log( "removed broken placeholder attachment $orphan" );
	}
}

WP_CLI::log( sprintf( 'catalogue: %d products (%d created), %d categories', count( $catalog['products'] ), $created, count( $categories ) ) );
