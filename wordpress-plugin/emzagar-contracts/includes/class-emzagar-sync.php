<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * موتور همگام‌سازی دوطرفه‌ی ووکامرس ↔ ابر امضاگیر.
 *
 * وردپرس → ابر (خروجی):
 *   - سفارش‌ها (ثبت، تغییر وضعیت، استرداد، حذف) و مشتریان در یک صف محلی دیتابیس (جدول emzagar_queue) ذخیره می‌شوند.
 *   - رویدادهای تکراری یک سفارش ادغام می‌شوند (Coalescing) و بار رویداد در لحظه‌ی ارسال از آخرین وضعیت سفارش ساخته می‌شود.
 *   - ارسال دسته‌ای، با امضای HMAC-SHA256، شناسه‌ی یکتا برای هر رویداد (ایدمپوتنت) و تلاش مجدد با backoff نمایی.
 *   - سفارش‌های قدیمی با «همگام‌سازی کامل» (Backfill) به‌صورت دسته‌ای و پس‌زمینه ارسال می‌شوند.
 *
 * ابر → وردپرس (ورودی):
 *   - Push: ابر به /wp-json/emzagar/v1/events با امضای HMAC رویداد می‌فرستد (فوری).
 *   - Pull: هر ۵ دقیقه افزونه خودش رویدادهای معلق را می‌گیرد و تایید (ACK) می‌کند (برای سایت‌های پشت فایروال/لوکال).
 *   - هم‌ترازسازی ساعتی وضعیت قراردادهای باز، برای ترمیم رویدادهای احتمالاً ازدست‌رفته.
 *   - هر رویداد با شناسه‌اش فقط یک‌بار اعمال می‌شود، حتی اگر هم Push و هم Pull برسد.
 */
class Emzagar_Sync {

	const DB_VERSION    = '2.0.0';
	const OPT_DBVER     = 'emzagar_db_version';
	const OPT_SECRET    = 'emzagar_sync_secret';
	const OPT_STATE     = 'emzagar_sync_state';
	const OPT_SEEN      = 'emzagar_sync_seen';
	const OPT_OPEN      = 'emzagar_open_contracts';
	const HOOK_FLUSH    = 'emzagar_sync_flush';
	const HOOK_TICK     = 'emzagar_sync_tick';
	const HOOK_BACKFILL = 'emzagar_sync_backfill';
	const MAX_ATTEMPTS  = 10;
	const BATCH         = 25;

	/** آیا در این درخواست رویدادی صف شده و باید ارسال زمان‌بندی شود */
	private static $dirty = false;

	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( self::HOOK_FLUSH, array( __CLASS__, 'cron_flush' ) );
		add_action( self::HOOK_TICK, array( __CLASS__, 'tick' ) );
		add_action( self::HOOK_BACKFILL, array( __CLASS__, 'backfill_cron' ) );
		add_action( 'shutdown', array( __CLASS__, 'on_shutdown' ) );
		add_action( 'admin_init', array( __CLASS__, 'maybe_upgrade' ) );
		add_action( 'wp_ajax_emzagar_sync', array( __CLASS__, 'ajax' ) );
		add_action( 'admin_init', array( __CLASS__, 'privacy_policy' ) );

		if ( ! wp_next_scheduled( self::HOOK_TICK ) ) {
			wp_schedule_event( time() + 120, 'emzagar_5min', self::HOOK_TICK );
		}

		if ( class_exists( 'WooCommerce' ) ) {
			// سفارش‌ها
			add_action( 'woocommerce_new_order', array( __CLASS__, 'on_order' ), 30, 2 );
			add_action( 'woocommerce_update_order', array( __CLASS__, 'on_order' ), 30, 2 );
			add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_order' ), 30, 1 );
			add_action( 'woocommerce_order_refunded', array( __CLASS__, 'on_order' ), 30, 1 );
			add_action( 'woocommerce_trash_order', array( __CLASS__, 'on_order_removed' ), 30, 1 );
			add_action( 'woocommerce_delete_order', array( __CLASS__, 'on_order_removed' ), 30, 1 );
			// مشتریان
			add_action( 'woocommerce_created_customer', array( __CLASS__, 'on_customer' ), 30, 1 );
			add_action( 'woocommerce_update_customer', array( __CLASS__, 'on_customer' ), 30, 1 );
			add_action( 'profile_update', array( __CLASS__, 'on_customer' ), 30, 1 );
		}
	}

	public static function cron_schedules( $schedules ) {
		$schedules['emzagar_5min'] = array(
			'interval' => 5 * MINUTE_IN_SECONDS,
			'display'  => __( 'هر ۵ دقیقه (امضاگیر)', 'emzagar' ),
		);
		return $schedules;
	}

	/* ───────────── وضعیت و ابزارها ───────────── */

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . 'emzagar_queue';
	}

	public static function secret() {
		$s = get_option( self::OPT_SECRET, '' );
		return is_string( $s ) ? $s : '';
	}

	public static function state() {
		$saved = get_option( self::OPT_STATE, array() );
		return wp_parse_args(
			is_array( $saved ) ? $saved : array(),
			array(
				'last_flush'     => 0,
				'last_flush_ok'  => 0,
				'last_pull'      => 0,
				'last_error'     => '',
				'sent'           => 0,
				'received'       => 0,
				'cloud_pending'  => 0,
				'secret_at'      => 0,
				'next_handshake' => 0,
				'last_ping'      => 0,
				'last_reconcile' => 0,
				'ack'            => array(),
				'log'            => array(),
				'backfill'       => array(
					'running'  => false,
					'page'     => 1,
					'total'    => 0,
					'done'     => 0,
					'started'  => 0,
					'finished' => 0,
				),
			)
		);
	}

	private static function patch( $changes ) {
		$s = self::state();
		foreach ( $changes as $k => $v ) {
			$s[ $k ] = $v;
		}
		update_option( self::OPT_STATE, $s, false );
		return $s;
	}

	public static function log( $msg, $level = 'info' ) {
		$s = self::state();
		array_unshift(
			$s['log'],
			array(
				't' => time(),
				'l' => $level,
				'm' => mb_substr( (string) $msg, 0, 240 ),
			)
		);
		$s['log'] = array_slice( $s['log'], 0, 30 );
		update_option( self::OPT_STATE, $s, false );
	}

	public static function queue_size() {
		global $wpdb;
		$t = self::table();
		return (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t}" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	private static function new_id() {
		return 'evt_' . bin2hex( random_bytes( 12 ) );
	}

	/* ───────────── نصب و ارتقا ───────────── */

	public static function install_table() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$t       = self::table();
		$charset = $wpdb->get_charset_collate();
		dbDelta(
			"CREATE TABLE {$t} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  event_id varchar(64) NOT NULL,
  type varchar(40) NOT NULL,
  ref_id bigint(20) unsigned NOT NULL DEFAULT 0,
  snapshot longtext NULL,
  attempts smallint(5) unsigned NOT NULL DEFAULT 0,
  next_at bigint(20) unsigned NOT NULL DEFAULT 0,
  created_at bigint(20) unsigned NOT NULL DEFAULT 0,
  PRIMARY KEY  (id),
  UNIQUE KEY event_id (event_id),
  KEY due (next_at),
  KEY ref (type,ref_id)
) {$charset};"
		);
		update_option( self::OPT_DBVER, self::DB_VERSION, false );
	}

	/** ارتقای بی‌صدا از نسخه‌های قبل: ساخت جدول صف، دریافت راز همگام‌سازی و همگام‌سازی اولیه */
	public static function maybe_upgrade() {
		if ( self::DB_VERSION !== get_option( self::OPT_DBVER ) ) {
			self::install_table();
			if ( Emzagar_API::is_configured() && class_exists( 'WooCommerce' ) ) {
				self::start_backfill();
			}
		}
		if ( Emzagar_API::is_configured() && '' === self::secret() ) {
			$s = self::state();
			if ( time() >= (int) $s['next_handshake'] && ! wp_doing_ajax() && ! wp_doing_cron() ) {
				self::patch( array( 'next_handshake' => time() + 600 ) );
				self::handshake();
			}
		}
	}

	public static function privacy_policy() {
		if ( function_exists( 'wp_add_privacy_policy_content' ) ) {
			wp_add_privacy_policy_content(
				'امضاگیر',
				wp_kses_post( '<p>' . __( 'برای صدور و پیگیری قرارداد، افزونه‌ی امضاگیر نام، ایمیل، موبایل و جزئیات سفارش مشتری را به سرویس امضاگیر (ابر) ارسال می‌کند. ارسال سفارش‌ها و مشتریان از «امضاگیر ← همگام‌سازی» قابل خاموش‌کردن است.', 'emzagar' ) . '</p>' )
			);
		}
	}

	/* ───────────── دست‌دادن و امضا ───────────── */

	/** گرفتن (یا چرخاندن) راز مشترک HMAC از ابر @return true|WP_Error */
	public static function handshake( $rotate = false ) {
		if ( ! Emzagar_API::is_configured() ) {
			return new WP_Error( 'emzagar_not_configured', __( 'امضاگیر هنوز به سایت شما متصل نشده است.', 'emzagar' ) );
		}
		$res = Emzagar_API::request(
			'POST',
			'/api/v1/sync/handshake',
			array(),
			array(
				'rotate'       => (bool) $rotate,
				'capabilities' => 'push,pull,orders,customers',
			)
		);
		if ( is_wp_error( $res ) ) {
			self::patch(
				array(
					'next_handshake' => time() + 600,
					'last_error'     => $res->get_error_message(),
				)
			);
			return $res;
		}
		if ( empty( $res['secret'] ) || ! preg_match( '/^[a-f0-9]{64}$/', (string) $res['secret'] ) ) {
			return new WP_Error( 'emzagar_bad_response', __( 'پاسخ نامعتبر از سرویس امضاگیر.', 'emzagar' ) );
		}
		update_option( self::OPT_SECRET, (string) $res['secret'], false );
		self::patch(
			array(
				'secret_at'      => isset( $res['secretAt'] ) ? (int) $res['secretAt'] : time(),
				'next_handshake' => 0,
				'last_error'     => '',
			)
		);
		self::log( $rotate ? __( 'راز همگام‌سازی چرخانده شد.', 'emzagar' ) : __( 'دست‌دادن همگام‌سازی انجام شد.', 'emzagar' ) );
		return true;
	}

	/* ───────────── جمع‌آوری رویدادها (وردپرس → ابر) ───────────── */

	private static function sync_orders_enabled() {
		$o = emzagar_options();
		return 'yes' === $o['sync_orders'];
	}

	public static function enqueue( $type, $ref_id ) {
		global $wpdb;
		$ref_id = (int) $ref_id;
		if ( $ref_id <= 0 || ! Emzagar_API::is_configured() ) {
			return;
		}
		$t        = self::table();
		$existing = $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$t} WHERE type = %s AND ref_id = %d AND snapshot IS NULL LIMIT 1", $type, $ref_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( ! $existing ) {
			$now = time();
			$wpdb->insert( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				$t,
				array(
					'event_id'   => self::new_id(),
					'type'       => $type,
					'ref_id'     => $ref_id,
					'attempts'   => 0,
					'next_at'    => $now,
					'created_at' => $now,
				),
				array( '%s', '%s', '%d', '%d', '%d', '%d' )
			);
		}
		self::$dirty = true;
	}

	public static function on_order( $order_id, $order = null ) {
		if ( ! self::sync_orders_enabled() ) {
			return;
		}
		if ( is_object( $order ) && method_exists( $order, 'get_type' ) && 'shop_order' !== $order->get_type() ) {
			return;
		}
		self::enqueue( 'order.upserted', (int) $order_id );
	}

	public static function on_order_removed( $order_id ) {
		global $wpdb;
		if ( ! self::sync_orders_enabled() ) {
			return;
		}
		$t = self::table();
		$wpdb->query( $wpdb->prepare( "DELETE FROM {$t} WHERE type = %s AND ref_id = %d AND snapshot IS NULL", 'order.upserted', (int) $order_id ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		self::enqueue( 'order.deleted', (int) $order_id );
	}

	public static function on_customer( $user_id ) {
		$o = emzagar_options();
		if ( 'yes' !== $o['sync_customers'] ) {
			return;
		}
		self::enqueue( 'customer.upserted', (int) $user_id );
	}

	/** پس از پایان درخواست، ارسال را در پس‌زمینه زمان‌بندی می‌کند (کند شدن پرداخت/تسویه ممنوع) */
	public static function on_shutdown() {
		if ( ! self::$dirty ) {
			return;
		}
		self::$dirty = false;
		if ( ! wp_next_scheduled( self::HOOK_FLUSH ) ) {
			wp_schedule_single_event( time() + 2, self::HOOK_FLUSH );
			if ( ! wp_doing_cron() && function_exists( 'spawn_cron' ) ) {
				spawn_cron();
			}
		}
	}

	/* ───────────── ساخت بار رویدادها ───────────── */

	private static function items_payload( $order ) {
		$items = array();
		foreach ( $order->get_items() as $item ) {
			$product = is_callable( array( $item, 'get_product' ) ) ? $item->get_product() : null;
			$pid     = $product ? ( $product->get_parent_id() ? $product->get_parent_id() : $product->get_id() ) : 0;
			$parent  = $pid ? wc_get_product( $pid ) : null;
			$items[] = array(
				'productId'  => (int) $pid,
				'name'       => wp_strip_all_tags( $item->get_name() ),
				'qty'        => (int) $item->get_quantity(),
				'total'      => (string) $item->get_total(),
				'templateId' => $parent ? (int) $parent->get_meta( '_emzagar_template_id' ) : 0,
			);
		}
		return array_slice( $items, 0, 50 );
	}

	public static function order_payload( $order ) {
		$created  = $order->get_date_created();
		$modified = $order->get_date_modified();
		$phone    = Emzagar_API::normalize_mobile( $order->get_billing_phone() );
		return array(
			'orderId'       => (int) $order->get_id(),
			'number'        => (string) $order->get_order_number(),
			'status'        => (string) $order->get_status(),
			'currency'      => (string) $order->get_currency(),
			'total'         => (string) $order->get_total(),
			'refunded'      => (string) $order->get_total_refunded(),
			'email'         => strtolower( (string) $order->get_billing_email() ),
			'name'          => trim( (string) $order->get_formatted_billing_full_name() ),
			'phone'         => $phone ? $phone : (string) $order->get_billing_phone(),
			'customerId'    => (int) $order->get_customer_id(),
			'paymentMethod' => (string) $order->get_payment_method(),
			'items'         => self::items_payload( $order ),
			'createdAt'     => $created ? (int) $created->getTimestamp() : 0,
			'updatedAt'     => $modified ? (int) $modified->getTimestamp() : time(),
		);
	}

	private static function customer_payload( $user_id ) {
		$u = get_userdata( (int) $user_id );
		if ( ! $u || ! in_array( 'customer', (array) $u->roles, true ) ) {
			return null;
		}
		$email = get_user_meta( $u->ID, 'billing_email', true );
		$name  = trim( get_user_meta( $u->ID, 'billing_first_name', true ) . ' ' . get_user_meta( $u->ID, 'billing_last_name', true ) );
		$phone = Emzagar_API::normalize_mobile( get_user_meta( $u->ID, 'billing_phone', true ) );
		return array(
			'customerId' => (int) $u->ID,
			'email'      => strtolower( $email ? $email : $u->user_email ),
			'name'       => $name ? $name : $u->display_name,
			'phone'      => $phone,
		);
	}

	/** تبدیل ردیف صف به رویداد؛ null یعنی ردیف بی‌اثر است و حذف می‌شود */
	private static function event_from_row( $r ) {
		global $wpdb;
		if ( ! empty( $r->snapshot ) ) {
			$d = json_decode( $r->snapshot, true );
			if ( is_array( $d ) ) {
				return array(
					'id'   => $r->event_id,
					'type' => $r->type,
					'at'   => (int) $r->created_at,
					'data' => $d,
				);
			}
		}
		$data = null;
		if ( 'order.upserted' === $r->type ) {
			if ( ! function_exists( 'wc_get_order' ) ) {
				return null;
			}
			$order = wc_get_order( (int) $r->ref_id );
			if ( ! $order || 'shop_order' !== $order->get_type() || in_array( $order->get_status(), array( 'auto-draft', 'checkout-draft', 'draft' ), true ) ) {
				return null;
			}
			$data = self::order_payload( $order );
		} elseif ( 'order.deleted' === $r->type ) {
			$data = array(
				'orderId'   => (int) $r->ref_id,
				'updatedAt' => time(),
			);
		} elseif ( 'customer.upserted' === $r->type ) {
			$data = self::customer_payload( (int) $r->ref_id );
		}
		if ( ! is_array( $data ) ) {
			return null;
		}
		// عکس‌برداری: ارسال مجدد همین رویداد (با همان شناسه) همان داده را می‌فرستد و تغییرهای بعدی ردیف تازه می‌سازند
		$wpdb->update( self::table(), array( 'snapshot' => wp_json_encode( $data ) ), array( 'id' => (int) $r->id ), array( '%s' ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		return array(
			'id'   => $r->event_id,
			'type' => $r->type,
			'at'   => (int) $r->created_at,
			'data' => $data,
		);
	}

	/* ───────────── ارسال ───────────── */

	private static function post_events( $events ) {
		$res = Emzagar_API::request( 'POST', '/api/v1/sync/events', array(), array( 'events' => $events ), false, true );
		if ( is_wp_error( $res ) ) {
			$data = $res->get_error_data();
			$code = is_array( $data ) && isset( $data['error'] ) ? $data['error'] : $res->get_error_code();
			if ( in_array( $code, array( 'bad_signature', 'handshake_required' ), true ) || 'emzagar_no_secret' === $res->get_error_code() ) {
				// راز چرخیده یا هنوز گرفته نشده: یک‌بار دوباره دست می‌دهیم و تلاش می‌کنیم
				if ( true === self::handshake() ) {
					$res = Emzagar_API::request( 'POST', '/api/v1/sync/events', array(), array( 'events' => $events ), false, true );
				}
			}
		}
		return $res;
	}

	private static function fail_row( $r ) {
		global $wpdb;
		$attempts = (int) $r->attempts + 1;
		if ( $attempts >= self::MAX_ATTEMPTS ) {
			$wpdb->delete( self::table(), array( 'id' => (int) $r->id ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			/* translators: 1: event type, 2: reference id */
			self::log( sprintf( __( 'رویداد %1$s (#%2$d) پس از چند تلاش حذف شد.', 'emzagar' ), $r->type, (int) $r->ref_id ), 'error' );
			return;
		}
		$wpdb->update( // phpcs:ignore WordPress.DB.DirectDatabaseQuery
			self::table(),
			array(
				'attempts' => $attempts,
				'next_at'  => time() + (int) min( 6 * HOUR_IN_SECONDS, 30 * pow( 2, $attempts ) ),
			),
			array( 'id' => (int) $r->id ),
			array( '%d', '%d' ),
			array( '%d' )
		);
	}

	public static function cron_flush() {
		self::flush( 4 );
	}

	/** ارسال رویدادهای سررسیدشده. @return int تعداد رویداد تحویل‌شده */
	public static function flush( $max_batches = 4 ) {
		global $wpdb;
		if ( ! Emzagar_API::is_configured() || get_transient( 'emzagar_flush_lock' ) ) {
			return 0;
		}
		set_transient( 'emzagar_flush_lock', 1, 60 );
		$t     = self::table();
		$sent  = 0;
		$error = '';
		$more  = false;
		for ( $i = 0; $i < $max_batches; $i++ ) {
			$rows = $wpdb->get_results( $wpdb->prepare( "SELECT * FROM {$t} WHERE next_at <= %d ORDER BY id ASC LIMIT %d", time(), self::BATCH ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			if ( empty( $rows ) ) {
				break;
			}
			$events = array();
			$map    = array();
			foreach ( $rows as $r ) {
				$ev = self::event_from_row( $r );
				if ( null === $ev ) {
					$wpdb->delete( $t, array( 'id' => (int) $r->id ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
					continue;
				}
				$events[]          = $ev;
				$map[ $ev['id'] ] = $r;
			}
			if ( empty( $events ) ) {
				continue;
			}
			$res = self::post_events( $events );
			if ( is_wp_error( $res ) ) {
				$error = $res->get_error_message();
				foreach ( $map as $r ) {
					self::fail_row( $r );
				}
				break;
			}
			$status = array();
			if ( isset( $res['results'] ) && is_array( $res['results'] ) ) {
				foreach ( $res['results'] as $x ) {
					if ( is_array( $x ) && isset( $x['id'] ) ) {
						$status[ (string) $x['id'] ] = isset( $x['status'] ) ? (string) $x['status'] : 'error';
					}
				}
			}
			foreach ( $map as $id => $r ) {
				$st = isset( $status[ $id ] ) ? $status[ $id ] : 'error';
				if ( in_array( $st, array( 'ok', 'duplicate', 'ignored' ), true ) ) {
					$wpdb->delete( $t, array( 'id' => (int) $r->id ), array( '%d' ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
					++$sent;
				} else {
					self::fail_row( $r );
				}
			}
			$more = count( $rows ) >= self::BATCH;
		}
		delete_transient( 'emzagar_flush_lock' );
		$s                  = self::state();
		$changes            = array(
			'last_flush' => time(),
			'sent'       => (int) $s['sent'] + $sent,
		);
		if ( '' === $error ) {
			$changes['last_flush_ok'] = time();
			$changes['last_error']    = '';
		} else {
			$changes['last_error'] = $error;
			self::log( $error, 'error' );
		}
		self::patch( $changes );
		if ( $more && '' === $error && ! wp_next_scheduled( self::HOOK_FLUSH ) ) {
			wp_schedule_single_event( time() + 10, self::HOOK_FLUSH );
		}
		return $sent;
	}

	/* ───────────── ورودی: Push از ابر ───────────── */

	public static function register_routes() {
		register_rest_route(
			'emzagar/v1',
			'/events',
			array(
				'methods'             => 'POST',
				'permission_callback' => array( __CLASS__, 'verify_request' ),
				'callback'            => array( __CLASS__, 'rest_events' ),
			)
		);
	}

	/** احراز هویت Push: امضای HMAC بدنه + برچسب زمان (ضد بازپخش) */
	public static function verify_request( $request ) {
		$secret = self::secret();
		if ( '' === $secret ) {
			return new WP_Error( 'emzagar_no_secret', __( 'همگام‌سازی هنوز راه‌اندازی نشده است.', 'emzagar' ), array( 'status' => 403 ) );
		}
		$ts  = (string) $request->get_header( 'x_emzagar_timestamp' );
		$sig = (string) $request->get_header( 'x_emzagar_signature' );
		if ( '' === $ts || '' === $sig || ! ctype_digit( $ts ) || abs( time() - (int) $ts ) > 300 ) {
			return new WP_Error( 'emzagar_stale', __( 'درخواست منقضی یا ناقص است.', 'emzagar' ), array( 'status' => 401 ) );
		}
		$expected = 'sha256=' . hash_hmac( 'sha256', $ts . '.' . $request->get_body(), $secret );
		if ( ! hash_equals( $expected, $sig ) ) {
			return new WP_Error( 'emzagar_bad_signature', __( 'امضا نامعتبر است.', 'emzagar' ), array( 'status' => 401 ) );
		}
		return true;
	}

	public static function rest_events( $request ) {
		$json   = json_decode( $request->get_body(), true );
		$events = is_array( $json ) && isset( $json['events'] ) && is_array( $json['events'] ) ? array_slice( $json['events'], 0, 50 ) : array();
		return rest_ensure_response(
			array(
				'ok'      => true,
				'results' => self::apply_events( $events ),
			)
		);
	}

	/** اعمال رویدادهای ابر (Push یا Pull) با حذف تکراری‌ها. @return array[] [{id,status}] */
	public static function apply_events( $events ) {
		$seen    = get_option( self::OPT_SEEN, array() );
		$seen    = is_array( $seen ) ? $seen : array();
		$results = array();
		$applied = 0;
		foreach ( $events as $ev ) {
			$id   = is_array( $ev ) && isset( $ev['id'] ) ? sanitize_text_field( (string) $ev['id'] ) : '';
			$type = is_array( $ev ) && isset( $ev['type'] ) ? sanitize_text_field( (string) $ev['type'] ) : '';
			if ( '' === $id || '' === $type ) {
				continue;
			}
			if ( isset( $seen[ $id ] ) ) {
				$results[] = array(
					'id'     => $id,
					'status' => 'duplicate',
				);
				continue;
			}
			$data = isset( $ev['data'] ) && is_array( $ev['data'] ) ? $ev['data'] : array();
			try {
				$st = self::apply_one( $type, $data );
			} catch ( \Throwable $e ) { // phpcs:ignore PHPCompatibility.Keywords.NewKeywords.t_throwableFound
				$st = 'error';
				self::log( $type . ': ' . $e->getMessage(), 'error' );
			}
			if ( 'error' !== $st ) {
				$seen[ $id ] = time();
				++$applied;
			}
			$results[] = array(
				'id'     => $id,
				'status' => $st,
			);
		}
		if ( count( $seen ) > 300 ) {
			asort( $seen );
			$seen = array_slice( $seen, -300, null, true );
		}
		update_option( self::OPT_SEEN, $seen, false );
		if ( $applied ) {
			$s = self::state();
			self::patch( array( 'received' => (int) $s['received'] + $applied ) );
			Emzagar_API::flush_cache();
		}
		return $results;
	}

	private static function apply_one( $type, $data ) {
		if ( 'sync.ping' === $type ) {
			self::patch( array( 'last_ping' => time() ) );
			self::log( __( 'آزمایش اتصال از ابر دریافت شد ✓', 'emzagar' ) );
			return 'ok';
		}
		if ( 'sync.resync' === $type ) {
			self::start_backfill();
			self::log( __( 'ابر هم‌ترازسازی کامل سفارش‌ها را درخواست کرد.', 'emzagar' ) );
			return 'ok';
		}
		if ( 0 === strpos( $type, 'contract.' ) ) {
			// ۱) شاخص محلی امضاها + نقش خودکار + دروازه‌ها (برای همه‌ی قراردادها، حتی بدون ووکامرس)
			$indexed = class_exists( 'Emzagar_Access' ) ? Emzagar_Access::on_event( $type, $data ) : false;
			// ۲) اتوماسیون سفارش ووکامرس
			$applied = class_exists( 'Emzagar_WooCommerce' ) ? Emzagar_WooCommerce::apply_contract_event( $type, $data ) : false;
			do_action( 'emzagar_contract_event', $type, $data );
			return ( $indexed || $applied ) ? 'ok' : 'ignored';
		}
		return 'ignored';
	}

	/* ───────────── ورودی: Pull از ابر ───────────── */

	public static function pull() {
		if ( ! Emzagar_API::is_configured() ) {
			return;
		}
		$s   = self::state();
		$ack = is_array( $s['ack'] ) ? $s['ack'] : array();
		for ( $i = 0; $i < 4; $i++ ) {
			$res = Emzagar_API::request(
				'POST',
				'/api/v1/sync/pull',
				array(),
				array(
					'ack'   => $ack,
					'limit' => self::BATCH,
				)
			);
			if ( is_wp_error( $res ) ) {
				self::patch( array( 'last_error' => $res->get_error_message() ) );
				return;
			}
			$ack    = array();
			$events = isset( $res['events'] ) && is_array( $res['events'] ) ? $res['events'] : array();
			foreach ( self::apply_events( $events ) as $r ) {
				if ( in_array( $r['status'], array( 'ok', 'duplicate', 'ignored' ), true ) ) {
					$ack[] = $r['id'];
				}
			}
			self::patch(
				array(
					'last_pull'     => time(),
					'cloud_pending' => isset( $res['pending'] ) ? max( 0, (int) $res['pending'] - count( $ack ) ) : 0,
				)
			);
			if ( ! empty( $res['secretAt'] ) && (int) $res['secretAt'] > (int) $s['secret_at'] ) {
				self::handshake(); // راز در پنل چرخانده شده است
			}
			if ( count( $events ) < self::BATCH ) {
				break;
			}
		}
		self::patch( array( 'ack' => array_slice( $ack, 0, 200 ) ) );
	}

	/** ترمیم: وضعیت قراردادهای بازِ ۴۵ روز اخیر از ابر پرسیده می‌شود تا رویداد ازدست‌رفته جبران شود */
	public static function reconcile() {
		$open = get_option( self::OPT_OPEN, array() );
		if ( ! is_array( $open ) || empty( $open ) ) {
			return;
		}
		$cut = time() - 45 * DAY_IN_SECONDS;
		foreach ( $open as $cid => $row ) {
			if ( ! is_array( $row ) || (int) $row['t'] < $cut ) {
				unset( $open[ $cid ] );
			}
		}
		update_option( self::OPT_OPEN, $open, false );
		$ids = array_slice( array_map( 'intval', array_keys( $open ) ), 0, 50 );
		if ( empty( $ids ) ) {
			return;
		}
		$res = Emzagar_API::request( 'GET', '/api/v1/contracts', array( 'ids' => implode( ',', $ids ) ) );
		if ( is_wp_error( $res ) || empty( $res['items'] ) || ! is_array( $res['items'] ) ) {
			return;
		}
		foreach ( $res['items'] as $item ) {
			if ( is_array( $item ) && class_exists( 'Emzagar_WooCommerce' ) ) {
				Emzagar_WooCommerce::apply_contract_event( 'contract.snapshot', $item );
			}
		}
	}

	public static function track_open( $contract_id, $order_id ) {
		$open = get_option( self::OPT_OPEN, array() );
		$open = is_array( $open ) ? $open : array();
		$open[ (int) $contract_id ] = array(
			'o' => (int) $order_id,
			't' => time(),
		);
		update_option( self::OPT_OPEN, $open, false );
	}

	public static function untrack( $contract_id ) {
		$open = get_option( self::OPT_OPEN, array() );
		if ( is_array( $open ) && isset( $open[ (int) $contract_id ] ) ) {
			unset( $open[ (int) $contract_id ] );
			update_option( self::OPT_OPEN, $open, false );
		}
	}

	/* ───────────── ضربان همگام‌سازی (هر ۵ دقیقه) ───────────── */

	public static function tick() {
		if ( ! Emzagar_API::is_configured() ) {
			return;
		}
		if ( '' === self::secret() ) {
			self::handshake();
		}
		self::flush( 4 );
		self::pull();
		$s = self::state();
		if ( time() - (int) $s['last_reconcile'] > HOUR_IN_SECONDS ) {
			self::patch( array( 'last_reconcile' => time() ) );
			self::reconcile();
		}
		if ( ! empty( $s['backfill']['running'] ) && ! wp_next_scheduled( self::HOOK_BACKFILL ) ) {
			wp_schedule_single_event( time() + 5, self::HOOK_BACKFILL );
		}
	}

	/* ───────────── همگام‌سازی کامل (Backfill) ───────────── */

	public static function start_backfill() {
		if ( ! class_exists( 'WooCommerce' ) || ! Emzagar_API::is_configured() ) {
			return false;
		}
		self::patch(
			array(
				'backfill' => array(
					'running'  => true,
					'page'     => 1,
					'total'    => 0,
					'done'     => 0,
					'started'  => time(),
					'finished' => 0,
				),
			)
		);
		if ( ! wp_next_scheduled( self::HOOK_BACKFILL ) ) {
			wp_schedule_single_event( time() + 5, self::HOOK_BACKFILL );
		}
		return true;
	}

	/** یک گام: سفارش‌های یک صفحه صف می‌شوند و ارسال شروع می‌شود. @return array وضعیت بک‌فیل */
	public static function backfill_step( $per_page = 25 ) {
		$s = self::state();
		$b = $s['backfill'];
		if ( empty( $b['running'] ) || ! function_exists( 'wc_get_orders' ) ) {
			return $b;
		}
		$q = wc_get_orders(
			array(
				'type'     => 'shop_order',
				'limit'    => (int) $per_page,
				'paged'    => max( 1, (int) $b['page'] ),
				'paginate' => true,
				'orderby'  => 'ID',
				'order'    => 'ASC',
				'return'   => 'ids',
			)
		);
		$ids        = is_object( $q ) && isset( $q->orders ) ? (array) $q->orders : array();
		$b['total'] = is_object( $q ) && isset( $q->total ) ? (int) $q->total : 0;
		foreach ( $ids as $id ) {
			self::enqueue( 'order.upserted', (int) $id );
		}
		$b['done'] += count( $ids );
		$b['page']  = (int) $b['page'] + 1;
		$max        = is_object( $q ) && isset( $q->max_num_pages ) ? (int) $q->max_num_pages : 0;
		if ( empty( $ids ) || $b['page'] > $max ) {
			$b['running']  = false;
			$b['finished'] = time();
			if ( 'yes' === emzagar_options()['sync_customers'] ) {
				$users = get_users(
					array(
						'role'   => 'customer',
						'number' => 1000,
						'fields' => 'ID',
					)
				);
				foreach ( $users as $uid ) {
					self::enqueue( 'customer.upserted', (int) $uid );
				}
			}
			self::log( sprintf( /* translators: %d: orders count */ __( 'همگام‌سازی کامل پایان یافت (%d سفارش).', 'emzagar' ), (int) $b['done'] ) );
		}
		self::patch( array( 'backfill' => $b ) );
		self::flush( 2 );
		return $b;
	}

	/** اجرای پس‌زمینه‌ی Backfill (۲۰ ثانیه در هر نوبت؛ در صورت ادامه، نوبت بعدی زمان‌بندی می‌شود) */
	public static function backfill_cron() {
		$start = time();
		do {
			$b = self::backfill_step( 50 );
			self::flush( 4 );
		} while ( ! empty( $b['running'] ) && time() - $start < 20 );
		if ( ! empty( $b['running'] ) && ! wp_next_scheduled( self::HOOK_BACKFILL ) ) {
			wp_schedule_single_event( time() + 10, self::HOOK_BACKFILL );
		}
	}

	/* ───────────── AJAX پیشخوان ───────────── */

	public static function summary() {
		$s = self::state();
		$b = $s['backfill'];
		return array(
			'queue'        => self::queue_size(),
			'cloudPending' => (int) $s['cloud_pending'],
			'lastFlush'    => (int) $s['last_flush_ok'] ? human_time_diff( (int) $s['last_flush_ok'] ) : '',
			'lastPull'     => (int) $s['last_pull'] ? human_time_diff( (int) $s['last_pull'] ) : '',
			'lastError'    => (string) $s['last_error'],
			'sent'         => (int) $s['sent'],
			'received'     => (int) $s['received'],
			'secret'       => '' !== self::secret(),
			'running'      => ! empty( $b['running'] ),
			'done'         => (int) $b['done'],
			'total'        => (int) $b['total'],
			'percent'      => (int) $b['total'] > 0 ? min( 100, (int) round( 100 * (int) $b['done'] / (int) $b['total'] ) ) : ( empty( $b['running'] ) && (int) $b['finished'] ? 100 : 0 ),
		);
	}

	public static function ajax() {
		check_ajax_referer( 'emzagar_sync', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'دسترسی ندارید.', 'emzagar' ) ), 403 );
		}
		$op = isset( $_POST['op'] ) ? sanitize_key( wp_unslash( $_POST['op'] ) ) : 'status';
		switch ( $op ) {
			case 'backfill_start':
				if ( ! self::start_backfill() ) {
					wp_send_json_error( array( 'message' => __( 'ووکامرس فعال نیست یا اتصال برقرار نشده است.', 'emzagar' ) ) );
				}
				if ( '' === self::secret() ) {
					self::handshake();
				}
				self::backfill_step( 25 );
				break;
			case 'backfill_step':
				self::backfill_step( 25 );
				break;
			case 'now':
				delete_transient( 'emzagar_flush_lock' );
				if ( '' === self::secret() ) {
					self::handshake();
				}
				self::flush( 4 );
				self::pull();
				break;
			case 'rotate':
				$r = self::handshake( true );
				if ( is_wp_error( $r ) ) {
					wp_send_json_error( array( 'message' => $r->get_error_message() ) );
				}
				break;
		}
		wp_send_json_success( self::summary() );
	}
}
