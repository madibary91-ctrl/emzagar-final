<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * رابط مدیر فروشگاه روی سفارش‌ها (سازگار با HPOS و ذخیره‌سازی قدیمی):
 *  - کادر «قرارداد امضاگیر» در صفحه‌ی سفارش: وضعیت زنده، لینک امضا، یادآوری، به‌روزرسانی، صدور دستی
 *  - ستون «امضا» در فهرست سفارش‌ها
 *  - اقدام گروهی «صدور قرارداد امضاگیر»
 */
class Emzagar_Order_UI {

	public static function init() {
		if ( ! class_exists( 'WooCommerce' ) || ! is_admin() ) {
			return;
		}
		add_action( 'add_meta_boxes', array( __CLASS__, 'meta_box' ) );
		// ستون فهرست سفارش‌ها: HPOS و قدیمی
		add_filter( 'manage_woocommerce_page_wc-orders_columns', array( __CLASS__, 'columns' ) );
		add_action( 'manage_woocommerce_page_wc-orders_custom_column', array( __CLASS__, 'column_hpos' ), 10, 2 );
		add_filter( 'manage_edit-shop_order_columns', array( __CLASS__, 'columns' ) );
		add_action( 'manage_shop_order_posts_custom_column', array( __CLASS__, 'column_legacy' ), 10, 2 );
		// اقدام گروهی
		add_filter( 'bulk_actions-woocommerce_page_wc-orders', array( __CLASS__, 'bulk_actions' ) );
		add_filter( 'bulk_actions-edit-shop_order', array( __CLASS__, 'bulk_actions' ) );
		add_filter( 'handle_bulk_actions-woocommerce_page_wc-orders', array( __CLASS__, 'handle_bulk' ), 10, 3 );
		add_filter( 'handle_bulk_actions-edit-shop_order', array( __CLASS__, 'handle_bulk' ), 10, 3 );
		// اقدام‌های تکی
		add_action( 'admin_post_emzagar_order_issue', array( __CLASS__, 'act_issue' ) );
		add_action( 'admin_post_emzagar_order_remind', array( __CLASS__, 'act_remind' ) );
		add_action( 'admin_post_emzagar_order_refresh', array( __CLASS__, 'act_refresh' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notice' ) );
		add_action( 'admin_head', array( __CLASS__, 'styles' ) );
	}

	public static function styles() {
		echo '<style>.emz-badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;line-height:18px;font-weight:600;background:#eee;color:#444}.emz-badge-signed{background:#dcfce7;color:#166534}.emz-badge-pending{background:#fef3c7;color:#92400e}.emz-badge-rejected,.emz-badge-expired,.emz-badge-cancelled{background:#fee2e2;color:#991b1b}.emz-ct{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px;padding:8px;border:1px solid #e5e7eb;border-radius:6px}.emz-ct .emz-ct-title{flex:1 1 100%;font-weight:600}</style>';
	}

	private static function badge( $status ) {
		$labels = Emzagar_WooCommerce::status_labels();
		$st     = isset( $labels[ $status ] ) ? $status : 'pending';
		return '<span class="emz-badge emz-badge-' . esc_attr( $st ) . '">' . esc_html( $labels[ $st ] ) . '</span>';
	}

	/* ───────── کادر سفارش ───────── */

	public static function meta_box() {
		$screen = function_exists( 'wc_get_page_screen_id' ) ? wc_get_page_screen_id( 'shop-order' ) : 'shop_order';
		add_meta_box( 'emzagar_order', __( 'قرارداد امضاگیر', 'emzagar' ), array( __CLASS__, 'render_box' ), $screen, 'side', 'high' );
	}

	private static function action_url( $action, $order_id, $extra = array() ) {
		$args = array_merge(
			array(
				'action'   => $action,
				'order_id' => (int) $order_id,
			),
			$extra
		);
		return wp_nonce_url( add_query_arg( $args, admin_url( 'admin-post.php' ) ), $action . '_' . (int) $order_id );
	}

	public static function render_box( $post_or_order ) {
		$order = $post_or_order instanceof WP_Post ? wc_get_order( $post_or_order->ID ) : $post_or_order;
		if ( ! $order || ! method_exists( $order, 'get_id' ) ) {
			return;
		}
		$oid     = (int) $order->get_id();
		$entries = Emzagar_WooCommerce::entries( $order );
		if ( ! Emzagar_API::is_configured() ) {
			echo '<p>' . esc_html__( 'امضاگیر هنوز متصل نشده است.', 'emzagar' ) . '</p>';
			return;
		}
		if ( empty( $entries ) ) {
			echo '<p>' . esc_html__( 'برای این سفارش قراردادی صادر نشده است.', 'emzagar' ) . '</p>';
			echo '<p><a class="button button-primary" href="' . esc_url( self::action_url( 'emzagar_order_issue', $oid ) ) . '">' . esc_html__( 'صدور قرارداد برای این سفارش', 'emzagar' ) . '</a></p>';
			echo '<p class="description">' . esc_html__( 'قالب هر محصول از تب «عمومی» محصول (یا قالب پیش‌فرض) خوانده می‌شود.', 'emzagar' ) . '</p>';
			return;
		}
		foreach ( $entries as $e ) {
			echo '<div class="emz-ct"><span class="emz-ct-title">' . esc_html( $e['number'] ? $e['number'] : '#' . (int) $e['id'] ) . '</span>' . wp_kses_post( self::badge( $e['status'] ) );
			if ( 'pending' === $e['status'] ) {
				/* translators: %d: remaining signers */
				echo ' <span class="description">' . esc_html( sprintf( __( '%d امضای باقی‌مانده', 'emzagar' ), max( 1, (int) $e['pending'] ) ) ) . '</span>';
			}
			if ( ! empty( $e['url'] ) && 'pending' === $e['status'] ) {
				echo '<a class="button button-small" href="' . esc_url( $e['url'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html__( 'لینک امضا', 'emzagar' ) . '</a>';
				echo '<a class="button button-small" href="' . esc_url( self::action_url( 'emzagar_order_remind', $oid, array( 'contract_id' => (int) $e['id'] ) ) ) . '">' . esc_html__( 'یادآوری', 'emzagar' ) . '</a>';
			}
			if ( ! empty( $e['signed_at'] ) ) {
				echo '<span class="description">' . esc_html( wp_date( get_option( 'date_format' ) . ' H:i', (int) $e['signed_at'] ) ) . '</span>';
			}
			echo '</div>';
		}
		echo '<p><a class="button" href="' . esc_url( self::action_url( 'emzagar_order_refresh', $oid ) ) . '">' . esc_html__( 'به‌روزرسانی وضعیت', 'emzagar' ) . '</a> ';
		echo '<a class="button" href="' . esc_url( self::action_url( 'emzagar_order_issue', $oid ) ) . '">' . esc_html__( 'صدور اقلام جاافتاده', 'emzagar' ) . '</a></p>';
		if ( Emzagar_WooCommerce::has_unsigned( $order ) && $order->get_meta( Emzagar_WooCommerce::HELD ) ) {
			echo '<p class="description">' . esc_html__( 'این سفارش تا امضای قرارداد در انتظار نگه داشته شده است.', 'emzagar' ) . '</p>';
		}
	}

	/* ───────── ستون فهرست ───────── */

	public static function columns( $cols ) {
		$new = array();
		foreach ( $cols as $k => $v ) {
			$new[ $k ] = $v;
			if ( 'order_status' === $k ) {
				$new['emzagar'] = __( 'امضا', 'emzagar' );
			}
		}
		if ( ! isset( $new['emzagar'] ) ) {
			$new['emzagar'] = __( 'امضا', 'emzagar' );
		}
		return $new;
	}

	private static function column_for( $order ) {
		$entries = $order ? Emzagar_WooCommerce::entries( $order ) : array();
		if ( empty( $entries ) ) {
			echo '<span aria-hidden="true">—</span>';
			return;
		}
		$counts = array();
		foreach ( $entries as $e ) {
			$counts[ $e['status'] ] = isset( $counts[ $e['status'] ] ) ? $counts[ $e['status'] ] + 1 : 1;
		}
		foreach ( $counts as $st => $n ) {
			echo wp_kses_post( self::badge( $st ) ) . ( $n > 1 ? ' ×' . (int) $n : '' ) . ' ';
		}
	}

	public static function column_hpos( $column, $order ) {
		if ( 'emzagar' === $column ) {
			self::column_for( $order );
		}
	}

	public static function column_legacy( $column, $post_id ) {
		if ( 'emzagar' === $column ) {
			self::column_for( wc_get_order( $post_id ) );
		}
	}

	/* ───────── اقدام گروهی ───────── */

	public static function bulk_actions( $actions ) {
		$actions['emzagar_issue'] = __( 'صدور قرارداد امضاگیر', 'emzagar' );
		return $actions;
	}

	public static function handle_bulk( $redirect, $action, $ids ) {
		if ( 'emzagar_issue' !== $action || ! current_user_can( 'edit_shop_orders' ) ) {
			return $redirect;
		}
		$issued = 0;
		$errors = 0;
		foreach ( (array) $ids as $id ) {
			$r       = Emzagar_WooCommerce::maybe_issue( (int) $id, true );
			$issued += (int) $r['issued'];
			$errors += count( $r['errors'] );
		}
		return add_query_arg(
			array(
				'emz_issued' => $issued,
				'emz_errors' => $errors,
			),
			$redirect
		);
	}

	/* ───────── اقدام‌های تکی ───────── */

	private static function guard( $action ) {
		$order_id = isset( $_GET['order_id'] ) ? absint( wp_unslash( $_GET['order_id'] ) ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		check_admin_referer( $action . '_' . $order_id );
		if ( ! $order_id || ! current_user_can( 'edit_shop_orders' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		$order = wc_get_order( $order_id );
		if ( ! $order ) {
			wp_die( esc_html__( 'سفارش یافت نشد.', 'emzagar' ) );
		}
		return $order;
	}

	private static function back( $order, $msg ) {
		wp_safe_redirect( add_query_arg( 'emz_msg', $msg, $order->get_edit_order_url() ) );
		exit;
	}

	public static function act_issue() {
		$order = self::guard( 'emzagar_order_issue' );
		$r     = Emzagar_WooCommerce::maybe_issue( $order->get_id(), true );
		self::back( $order, $r['issued'] ? 'issued' : ( empty( $r['errors'] ) ? 'none' : 'error' ) );
	}

	public static function act_remind() {
		$order = self::guard( 'emzagar_order_remind' );
		$cid   = isset( $_GET['contract_id'] ) ? absint( wp_unslash( $_GET['contract_id'] ) ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$known = false;
		foreach ( Emzagar_WooCommerce::entries( $order ) as $e ) {
			if ( (int) $e['id'] === $cid ) {
				$known = true;
			}
		}
		if ( ! $known ) {
			self::back( $order, 'error' );
		}
		$res = Emzagar_API::request( 'POST', '/api/v1/contracts/' . $cid . '/remind', array(), array() );
		self::back( $order, is_wp_error( $res ) ? 'error' : 'reminded' );
	}

	public static function act_refresh() {
		$order = self::guard( 'emzagar_order_refresh' );
		$ids   = array();
		foreach ( Emzagar_WooCommerce::entries( $order ) as $e ) {
			$ids[] = (int) $e['id'];
		}
		if ( $ids ) {
			$res = Emzagar_API::request( 'GET', '/api/v1/contracts', array( 'ids' => implode( ',', $ids ) ) );
			if ( ! is_wp_error( $res ) && ! empty( $res['items'] ) && is_array( $res['items'] ) ) {
				foreach ( $res['items'] as $item ) {
					if ( is_array( $item ) ) {
						$item['wcOrderId'] = (int) $order->get_id();
						Emzagar_WooCommerce::apply_contract_event( 'contract.snapshot', $item );
					}
				}
				self::back( $order, 'refreshed' );
			}
		}
		self::back( $order, 'error' );
	}

	public static function notice() {
		$msg = isset( $_GET['emz_msg'] ) ? sanitize_key( wp_unslash( $_GET['emz_msg'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( '' !== $msg ) {
			$map = array(
				'issued'    => array( 'success', __( 'قرارداد صادر شد.', 'emzagar' ) ),
				'none'      => array( 'info', __( 'قرارداد جدیدی برای صدور وجود نداشت (محصولی با قالب پیدا نشد یا قبلاً صادر شده).', 'emzagar' ) ),
				'reminded'  => array( 'success', __( 'یادآوری امضا ارسال شد.', 'emzagar' ) ),
				'refreshed' => array( 'success', __( 'وضعیت قراردادها به‌روز شد.', 'emzagar' ) ),
				'error'     => array( 'error', __( 'عملیات انجام نشد؛ یادداشت‌های سفارش را ببینید.', 'emzagar' ) ),
			);
			if ( isset( $map[ $msg ] ) ) {
				printf( '<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>', esc_attr( $map[ $msg ][0] ), esc_html( $map[ $msg ][1] ) );
			}
		}
		if ( isset( $_GET['emz_issued'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			/* translators: 1: issued count, 2: error count */
			$text = sprintf( __( 'امضاگیر: %1$d قرارداد صادر شد، %2$d مورد ناموفق/نیازمند بررسی.', 'emzagar' ), absint( wp_unslash( $_GET['emz_issued'] ) ), isset( $_GET['emz_errors'] ) ? absint( wp_unslash( $_GET['emz_errors'] ) ) : 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			printf( '<div class="notice notice-info is-dismissible"><p>%s</p></div>', esc_html( $text ) );
		}
	}
}
