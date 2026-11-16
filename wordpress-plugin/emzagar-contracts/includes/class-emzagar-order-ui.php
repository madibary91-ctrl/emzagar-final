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

	/** فرم‌های صدور که باید در پای صفحه چاپ شوند: id فرم ← شناسه‌ی سفارش */
	private static $forms = array();

	public static function init() {
		if ( is_admin() ) {
			// پیام‌های یک‌بارمصرف امضاگیر نباید در نشانی صفحه بمانند؛ وگرنه با «به‌روزرسانی سفارش» (که به همان نشانی برمی‌گردد)
			// خطای قدیمیِ «موبایل نامعتبر» بعد از اصلاح شماره هم دوباره نمایش داده می‌شد.
			add_filter( 'removable_query_args', array( __CLASS__, 'removable_args' ) );
		}
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
		add_action( 'admin_footer', array( __CLASS__, 'footer_forms' ) );
	}

	/** پارامترهای پیام‌های امضاگیر که وردپرس باید از نشانی (و از referer ذخیره‌ی فرم) حذف کند */
	public static function removable_args( $args ) {
		return array_merge( (array) $args, array( 'emz_msg', 'emz_seen', 'emz_issued', 'emz_errors', 'emz_bulk_ok', 'emz_bulk_fail' ) );
	}

	public static function styles() {
		echo '<style>.emz-badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;line-height:18px;font-weight:600;background:#eee;color:#444}.emz-badge-signed{background:#dcfce7;color:#166534}.emz-badge-pending{background:#fef3c7;color:#92400e}.emz-badge-rejected,.emz-badge-expired,.emz-badge-cancelled{background:#fee2e2;color:#991b1b}.emz-ct{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px;padding:8px;border:1px solid #e5e7eb;border-radius:6px}.emz-ct .emz-ct-title{flex:1 1 100%;font-weight:600}</style>';
	}

	private static function badge( $status ) {
		$labels = Emzagar_WooCommerce::status_labels();
		$st     = isset( $labels[ $status ] ) ? $status : 'pending';
		return '<span class="emz-badge emz-badge-' . esc_attr( $st ) . '">' . esc_html( $labels[ $st ] ) . '</span>';
	}

	/**
	 * کنترل‌های «صدور»: یک فرم GET مستقل که بیرون از فرم سفارش چاپ می‌شود (فرم تودرتو در HTML ممنوع است) و
	 * فیلد/دکمه‌ی داخل کادر با خصوصیت form="..." به آن وصل می‌شوند. بدون هیچ جاوااسکریپتی کار می‌کند؛ پس
	 * سیاست CSP سایت (مثلاً مسدودبودن eval یا اسکریپت درون‌خطی) هرگز مانع دکمه نمی‌شود.
	 */
	private static function issue_controls( $oid, $label, $primary ) {
		$fid = 'emz-issue-form-' . (int) $oid;
		echo '<p class="emz-issue">';
		$tpls = class_exists( 'Emzagar_Settings' ) ? Emzagar_Settings::templates() : array();
		if ( ! empty( $tpls ) ) {
			$opts    = emzagar_options();
			$default = (int) $opts['default_template'];
			echo '<label class="screen-reader-text" for="emz-tpl-' . (int) $oid . '">' . esc_html__( 'قالب قرارداد', 'emzagar' ) . '</label>';
			echo '<select id="emz-tpl-' . (int) $oid . '" name="template_id" form="' . esc_attr( $fid ) . '" style="max-width:100%;margin-bottom:6px">';
			echo '<option value="0">' . esc_html__( '— قالب محصول / پیش‌فرض —', 'emzagar' ) . '</option>';
			foreach ( $tpls as $t ) {
				echo '<option value="' . (int) $t['id'] . '"' . selected( $default, (int) $t['id'], false ) . '>' . esc_html( $t['title'] ) . '</option>';
			}
			echo '</select><br>';
		}
		echo '<label class="screen-reader-text" for="emz-mob-' . (int) $oid . '">' . esc_html__( 'موبایل مشتری (اختیاری)', 'emzagar' ) . '</label>';
		echo '<input type="tel" id="emz-mob-' . (int) $oid . '" name="mobile" form="' . esc_attr( $fid ) . '" dir="ltr" inputmode="tel" autocomplete="off" placeholder="' . esc_attr__( 'موبایل مشتری (اختیاری) 09123456789', 'emzagar' ) . '" style="max-width:100%;margin-bottom:6px;width:100%">';
		echo '<button type="submit" form="' . esc_attr( $fid ) . '" class="button ' . ( $primary ? 'button-primary' : '' ) . '">' . $label . '</button>'; // phpcs:ignore WordPress.Security.EscapeOutput -- $label از esc_html__ آمده است
		echo '</p>';
		self::$forms[ $fid ] = (int) $oid;
	}

	/** فرم‌های GET مستقل (بیرون از فرم سفارش) */
	public static function footer_forms() {
		foreach ( self::$forms as $fid => $oid ) {
			echo '<form id="' . esc_attr( $fid ) . '" method="get" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="display:none">';
			echo '<input type="hidden" name="action" value="emzagar_order_issue">';
			echo '<input type="hidden" name="order_id" value="' . (int) $oid . '">';
			echo '<input type="hidden" name="_wpnonce" value="' . esc_attr( wp_create_nonce( 'emzagar_order_issue_' . (int) $oid ) ) . '">';
			echo '</form>';
		}
		self::$forms = array();
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
			self::issue_controls( $oid, esc_html__( 'صدور قرارداد برای این سفارش', 'emzagar' ), true );
			echo '<p class="description">' . esc_html__( 'قالب هر محصول از تب «عمومی» محصول خوانده می‌شود؛ اگر محصول قالب نداشته باشد، قالبی که اینجا انتخاب می‌کنید (یا قالب پیش‌فرض) به کار می‌رود.', 'emzagar' ) . '</p>';
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
		echo '</p>';
		self::issue_controls( $oid, esc_html__( 'صدور اقلام جاافتاده', 'emzagar' ), false );
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

	private static function back( $order, $msg, $extra = array() ) {
		wp_safe_redirect( add_query_arg( array_merge( array( 'emz_msg' => $msg ), $extra ), $order->get_edit_order_url() ) );
		exit;
	}

	public static function act_issue() {
		$order = self::guard( 'emzagar_order_issue' );
		$tpl   = isset( $_GET['template_id'] ) ? absint( wp_unslash( $_GET['template_id'] ) ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- در guard بررسی شده
		$mob   = isset( $_GET['mobile'] ) ? sanitize_text_field( wp_unslash( $_GET['mobile'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- در guard بررسی شده
		$r     = Emzagar_WooCommerce::maybe_issue( $order->get_id(), true, $tpl, $mob );
		if ( $r['issued'] ) {
			$code = 'issued';
		} elseif ( in_array( 'no_phone', $r['reasons'], true ) ) {
			$code = 'no_phone';
			self::back( $order, $code, isset( $r['seen'] ) ? array( 'emz_seen' => $r['seen'] ) : array() );
		} elseif ( in_array( 'no_email', $r['reasons'], true ) ) {
			$code = 'no_email';
		} elseif ( in_array( 'no_template', $r['reasons'], true ) && ! in_array( 'api_error', $r['reasons'], true ) ) {
			$code = 'no_template';
		} elseif ( empty( $r['errors'] ) ) {
			$code = 'none';
		} else {
			$code = 'error';
		}
		self::back( $order, $code );
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
				'none'        => array( 'info', __( 'قرارداد جدیدی برای صدور وجود نداشت (همه‌ی اقلام قبلاً صادر شده‌اند).', 'emzagar' ) ),
				'no_template' => array( 'warning', __( 'صدور انجام نشد: برای محصولات این سفارش قالب قرارداد تعیین نشده است. در کادر «قرارداد امضاگیر» یک قالب انتخاب کنید، یا در تب «عمومی» محصول قالب بگذارید، یا «قالب پیش‌فرض» را در تنظیمات امضاگیر تعیین کنید.', 'emzagar' ) ),
				'no_phone'    => array( 'error', __( 'صدور انجام نشد: شماره‌ی موبایل صورتحساب معتبر نیست (قالب 09123456789). شماره را در «صورتحساب» سفارش اصلاح و سفارش را «به‌روزرسانی» کنید، سپس دوباره صدور بزنید.', 'emzagar' ) ),
				'no_email'    => array( 'error', __( 'صدور انجام نشد: ایمیل صورتحساب سفارش خالی است.', 'emzagar' ) ),
				'reminded'  => array( 'success', __( 'یادآوری امضا ارسال شد.', 'emzagar' ) ),
				'refreshed' => array( 'success', __( 'وضعیت قراردادها به‌روز شد.', 'emzagar' ) ),
				'error'     => array( 'error', __( 'عملیات انجام نشد؛ یادداشت‌های سفارش را ببینید.', 'emzagar' ) ),
			);
			if ( isset( $map[ $msg ] ) ) {
				$text = $map[ $msg ][1];
				if ( 'no_phone' === $msg ) {
					$seen = isset( $_GET['emz_seen'] ) ? mb_substr( preg_replace( '/[^\p{L}\p{N}+\-() .]/u', '', sanitize_text_field( wp_unslash( $_GET['emz_seen'] ) ) ), 0, 40 ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
					$text .= '' !== $seen
						/* translators: %s: raw phone value read from the order */
						? ' ' . sprintf( __( 'مقدار خوانده‌شده از سفارش: «%s»', 'emzagar' ), $seen )
						: ' ' . __( 'در سفارش هیچ شماره‌ای ثبت نشده است؛ می‌توانید موبایل را در کادر بالای دکمه‌ی صدور وارد کنید.', 'emzagar' );
				}
				printf( '<div class="notice notice-%1$s is-dismissible"><p>%2$s</p></div>', esc_attr( $map[ $msg ][0] ), esc_html( $text ) );
			}
		}
		if ( isset( $_GET['emz_issued'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			/* translators: 1: issued count, 2: error count */
			$text = sprintf( __( 'امضاگیر: %1$d قرارداد صادر شد، %2$d مورد ناموفق/نیازمند بررسی.', 'emzagar' ), absint( wp_unslash( $_GET['emz_issued'] ) ), isset( $_GET['emz_errors'] ) ? absint( wp_unslash( $_GET['emz_errors'] ) ) : 0 ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			printf( '<div class="notice notice-info is-dismissible"><p>%s</p></div>', esc_html( $text ) );
		}
	}
}
