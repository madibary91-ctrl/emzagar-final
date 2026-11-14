<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * اتصال خودکار و بی‌صدا به ابر امضاگیر (Install → Activate → Works).
 *
 * جریان:
 *  1) افزونه اطلاعات سایت را به ابر می‌فرستد (register) و یک «چالش» می‌گیرد.
 *  2) چالش روی مسیر REST همین سایت (/wp-json/emzagar/v1/verify) در دسترس قرار می‌گیرد.
 *  3) ابر آن مسیر را از بیرون می‌خواند تا مالکیت دامنه ثابت شود و کلید API را برمی‌گرداند (complete).
 *  4) کلید فقط در دیتابیس همین وردپرس ذخیره می‌شود؛ هرگز به مرورگر بازدیدکننده‌ها نمی‌رسد.
 *
 * اگر کلید باطل شود یا اتصال قطع شود، افزونه خودش دوباره وصل می‌شود (خودترمیم).
 */
class Emzagar_Connect {

	const OPT_INSTALL   = 'emzagar_install_id';
	const OPT_HANDSHAKE = 'emzagar_handshake';
	const OPT_NEXT      = 'emzagar_next_attempt';
	const OPT_FAILS     = 'emzagar_fail_count';
	const OPT_ERROR     = 'emzagar_last_error';
	const HOOK_RETRY    = 'emzagar_connect_retry';
	const HOOK_BEAT     = 'emzagar_heartbeat';
	const OPT_BEAT      = 'emzagar_last_beat';

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'admin_init', array( __CLASS__, 'maybe_connect' ) );
		add_action( self::HOOK_RETRY, array( __CLASS__, 'cron_connect' ) );
		add_action( self::HOOK_BEAT, array( __CLASS__, 'heartbeat' ) );
		add_action( 'admin_post_emzagar_open_panel', array( __CLASS__, 'open_panel' ) );
		add_action( 'admin_post_emzagar_reconnect', array( __CLASS__, 'handle_reconnect' ) );
		if ( ! wp_next_scheduled( self::HOOK_BEAT ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', self::HOOK_BEAT );
		}
	}

	/* ───────────── پیکربندی ───────────── */

	/** آدرس ابر: ثابت wp-config ← بسته‌ی دانلودی ← آدرس پیش‌فرض ← مقدار واردشده در تنظیمات */
	public static function cloud_url() {
		$url = '';
		if ( defined( 'EMZAGAR_CLOUD_URL' ) && EMZAGAR_CLOUD_URL ) {
			$url = EMZAGAR_CLOUD_URL;
		} else {
			$cfg = emzagar_packaged_config();
			if ( ! empty( $cfg['cloud_url'] ) ) {
				$url = $cfg['cloud_url'];
			} elseif ( defined( 'EMZ_DEFAULT_CLOUD_URL' ) && EMZ_DEFAULT_CLOUD_URL ) {
				$url = EMZ_DEFAULT_CLOUD_URL;
			} else {
				$o   = emzagar_options();
				$url = $o['cloud_url'];
			}
		}
		$url = apply_filters( 'emzagar_cloud_url', $url );
		$url = Emzagar_API::clean_base_url( $url );
		return self::is_acceptable_cloud( $url ) ? $url : '';
	}

	/** فقط HTTPS (یا محیط توسعه‌ی محلی) */
	public static function is_acceptable_cloud( $url ) {
		if ( '' === $url ) {
			return false;
		}
		if ( 0 === strpos( $url, 'https://' ) ) {
			return true;
		}
		$host = wp_parse_url( $url, PHP_URL_HOST );
		return in_array( $host, array( 'localhost', '127.0.0.1' ), true ) || ( defined( 'WP_DEBUG' ) && WP_DEBUG );
	}

	/** شناسه‌ی یکتای این نصب (۳۲ نویسه‌ی هگز) */
	public static function install_id() {
		$id = get_option( self::OPT_INSTALL, '' );
		if ( ! is_string( $id ) || ! preg_match( '/^[a-f0-9]{32}$/', $id ) ) {
			$id = str_replace( '-', '', wp_generate_uuid4() );
			update_option( self::OPT_INSTALL, $id, false );
		}
		return $id;
	}

	private static function admin_user() {
		$user = wp_get_current_user();
		if ( $user && $user->exists() && user_can( $user, 'manage_options' ) ) {
			return $user;
		}
		$admins = get_users(
			array(
				'role'    => 'administrator',
				'number'  => 1,
				'orderby' => 'ID',
				'order'   => 'ASC',
			)
		);
		return ! empty( $admins ) ? $admins[0] : null;
	}

	/* ───────────── اتصال ───────────── */

	/** فراخوانی در لحظه‌ی فعال‌سازی */
	public static function on_activate() {
		self::install_id();
		set_transient( 'emzagar_just_activated', 1, 10 * MINUTE_IN_SECONDS );
		if ( Emzagar_API::is_configured() ) {
			return; // نصب مجدد با تنظیمات قبلی
		}
		$res = self::connect( true );
		if ( is_wp_error( $res ) ) {
			self::schedule_retry( 90 );
		}
	}

	/** هنگام ورود مدیر به پیشخوان: اگر وصل نیست، تلاش در پس‌زمینه (بدون کند کردن صفحه) */
	public static function maybe_connect() {
		if ( wp_doing_ajax() || wp_doing_cron() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		if ( Emzagar_API::is_configured() || '' === self::cloud_url() ) {
			return;
		}
		if ( time() < (int) get_option( self::OPT_NEXT, 0 ) ) {
			return;
		}
		self::schedule_retry( 5 );
	}

	public static function schedule_retry( $delay = 60 ) {
		if ( ! wp_next_scheduled( self::HOOK_RETRY ) ) {
			wp_schedule_single_event( time() + max( 1, (int) $delay ), self::HOOK_RETRY );
		}
	}

	public static function unschedule() {
		wp_clear_scheduled_hook( self::HOOK_RETRY );
		wp_clear_scheduled_hook( self::HOOK_BEAT );
	}

	public static function cron_connect() {
		if ( Emzagar_API::is_configured() ) {
			return;
		}
		$res = self::connect( false );
		if ( is_wp_error( $res ) && 'emzagar_busy' !== $res->get_error_code() ) {
			// تلاش مجدد با فاصله‌ی افزایشی: ۲ دقیقه … حداکثر ۶ ساعت
			$fails = (int) get_option( self::OPT_FAILS, 0 );
			self::schedule_retry( min( 6 * HOUR_IN_SECONDS, 120 * pow( 2, min( $fails, 8 ) ) ) );
		}
	}

	private static function fail( $err ) {
		$fails = (int) get_option( self::OPT_FAILS, 0 ) + 1;
		update_option( self::OPT_FAILS, $fails, false );
		update_option( self::OPT_ERROR, $err->get_error_message(), false );
		update_option( self::OPT_NEXT, time() + min( 6 * HOUR_IN_SECONDS, 120 * pow( 2, min( $fails, 8 ) ) ), false );
		return $err;
	}

	/**
	 * اجرای کامل دست‌دادن. @return true|WP_Error
	 *
	 * @param bool $force نادیده‌گرفتن فاصله‌ی تلاش مجدد (دکمه‌ی «اتصال دوباره»)
	 */
	public static function connect( $force = false ) {
		$cloud = self::cloud_url();
		if ( '' === $cloud ) {
			return new WP_Error( 'emzagar_no_cloud', __( 'آدرس سرویس امضاگیر مشخص نیست. افزونه را از پنل امضاگیر دانلود کنید.', 'emzagar' ) );
		}
		if ( ! $force && time() < (int) get_option( self::OPT_NEXT, 0 ) ) {
			return new WP_Error( 'emzagar_busy', __( 'تلاش بعدی به‌زودی انجام می‌شود.', 'emzagar' ) );
		}
		if ( get_transient( 'emzagar_connect_lock' ) ) {
			return new WP_Error( 'emzagar_busy', __( 'اتصال در حال انجام است.', 'emzagar' ) );
		}
		set_transient( 'emzagar_connect_lock', 1, 90 );

		$user = self::admin_user();
		$mail = $user ? $user->user_email : get_option( 'admin_email' );
		$cfg  = emzagar_packaged_config();
		$o    = emzagar_options();

		$payload = array(
			'installId'     => self::install_id(),
			'siteUrl'       => untrailingslashit( home_url() ),
			'siteName'      => wp_strip_all_tags( get_bloginfo( 'name' ) ),
			'adminEmail'    => $mail,
			'adminName'     => $user ? $user->display_name : '',
			'pluginVersion' => EMZ_VERSION,
			'wpVersion'     => get_bloginfo( 'version' ),
			'wcActive'      => class_exists( 'WooCommerce' ),
			'locale'        => get_locale(),
		);
		if ( ! empty( $cfg['pairing'] ) && $cfg['pairing'] !== $o['pairing_used'] ) {
			$payload['pairing'] = $cfg['pairing'];
		}

		$reg = self::post( $cloud . '/api/v1/connect/register', $payload, 10 );
		if ( is_wp_error( $reg ) ) {
			delete_transient( 'emzagar_connect_lock' );
			return self::fail( $reg );
		}
		if ( empty( $reg['handshakeId'] ) || empty( $reg['challenge'] ) ) {
			delete_transient( 'emzagar_connect_lock' );
			return self::fail( new WP_Error( 'emzagar_bad_response', __( 'پاسخ نامعتبر از سرویس امضاگیر.', 'emzagar' ) ) );
		}

		// چالش را برای تایید مالکیت دامنه در دسترس قرار می‌دهیم
		update_option(
			self::OPT_HANDSHAKE,
			array(
				'id'        => (string) $reg['handshakeId'],
				'challenge' => (string) $reg['challenge'],
				'expires'   => time() + 15 * MINUTE_IN_SECONDS,
			),
			false
		);

		$done = self::post( $cloud . '/api/v1/connect/complete', array( 'handshakeId' => $reg['handshakeId'] ), 25 );
		delete_option( self::OPT_HANDSHAKE );
		delete_transient( 'emzagar_connect_lock' );
		if ( is_wp_error( $done ) ) {
			return self::fail( $done );
		}
		if ( empty( $done['apiKey'] ) || ! preg_match( '/^emz_[a-f0-9]{48}$/', (string) $done['apiKey'] ) ) {
			return self::fail( new WP_Error( 'emzagar_bad_response', __( 'پاسخ نامعتبر از سرویس امضاگیر.', 'emzagar' ) ) );
		}

		$new                 = emzagar_options();
		$new['base_url']     = $cloud;
		$new['api_key']      = (string) $done['apiKey'];
		$new['connection']   = 'auto';
		$new['workspace']    = isset( $done['workspaceName'] ) ? sanitize_text_field( $done['workspaceName'] ) : '';
		$new['verified']     = ! empty( $done['verified'] ) ? 'yes' : 'no';
		$new['sso']          = ! empty( $done['sso'] ) ? 'yes' : 'no';
		$new['connected_at'] = time();
		if ( ! empty( $payload['pairing'] ) ) {
			$new['pairing_used'] = $payload['pairing'];
		}
		if ( empty( $new['default_template'] ) && ! empty( $done['defaultTemplateId'] ) ) {
			$new['default_template'] = (int) $done['defaultTemplateId'];
		}
		update_option( EMZ_OPTION, $new );

		delete_option( self::OPT_ERROR );
		delete_option( self::OPT_FAILS );
		delete_option( self::OPT_NEXT );
		Emzagar_API::flush_cache();
		self::ensure_page();
		// همگام‌سازی دوطرفه: راز امضا را می‌گیریم و سفارش‌های موجود را در پس‌زمینه می‌فرستیم (بدون هیچ اقدام کاربر)
		if ( true === Emzagar_Sync::handshake() ) {
			Emzagar_Sync::start_backfill();
		}
		return true;
	}

	/** کلید باطل شد: کلید محلی پاک می‌شود و اتصال دوباره در پس‌زمینه انجام می‌شود (خودترمیم) */
	public static function mark_broken() {
		$o = emzagar_options();
		if ( 'auto' !== $o['connection'] ) {
			return; // اتصال دستی: دخالت نمی‌کنیم
		}
		$o['api_key'] = '';
		update_option( EMZ_OPTION, $o );
		delete_option( self::OPT_NEXT );
		self::schedule_retry( 3 );
	}

	/** صفحه‌ی «قراردادهای من» با شورت‌کد داشبورد (برای سایت‌های بدون ووکامرس) */
	private static function ensure_page() {
		$o = emzagar_options();
		if ( class_exists( 'WooCommerce' ) ) {
			return; // در ووکامرس، تب «قراردادها» در حساب کاربری وجود دارد
		}
		$id = (int) $o['page_id'];
		if ( $id && 'publish' === get_post_status( $id ) ) {
			return;
		}
		$new_id = wp_insert_post(
			array(
				'post_title'   => __( 'قراردادهای من', 'emzagar' ),
				'post_name'    => 'my-contracts',
				'post_content' => '[emzagar_dashboard]',
				'post_status'  => 'publish',
				'post_type'    => 'page',
			)
		);
		if ( $new_id && ! is_wp_error( $new_id ) ) {
			$o['page_id'] = (int) $new_id;
			update_option( EMZ_OPTION, $o );
		}
	}

	/* ───────────── ضربان (روزانه) ───────────── */

	public static function heartbeat() {
		if ( ! Emzagar_API::is_configured() ) {
			return;
		}
		$res = Emzagar_API::request(
			'POST',
			'/api/v1/connect/status',
			array(),
			array(
				'pluginVersion' => EMZ_VERSION,
				'wpVersion'     => get_bloginfo( 'version' ),
				'wcActive'      => class_exists( 'WooCommerce' ),
				'locale'        => get_locale(),
				'siteName'      => wp_strip_all_tags( get_bloginfo( 'name' ) ),
				'modules'       => Emzagar_Modules::active_ids(),
			)
		);
		// نتیجه برای صفحه‌ی «وضعیت سیستم» ثبت می‌شود
		update_option(
			self::OPT_BEAT,
			array(
				'ts'    => time(),
				'ok'    => ! is_wp_error( $res ),
				'error' => is_wp_error( $res ) ? $res->get_error_message() : '',
			),
			false
		);
		if ( ! is_wp_error( $res ) ) {
			Emzagar_Updater::refresh(); // لایسنس و نسخه‌ی جدید
		}
	}

	/** آخرین ضربان: ts, ok, error */
	public static function last_beat() {
		$b = get_option( self::OPT_BEAT, array() );
		return wp_parse_args( is_array( $b ) ? $b : array(), array( 'ts' => 0, 'ok' => false, 'error' => '' ) );
	}

	/* ───────────── REST: پاسخ به چالش ابر ───────────── */

	public static function register_routes() {
		register_rest_route(
			'emzagar/v1',
			'/verify',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true', // عمومی است اما فقط در طول دست‌دادن و با شناسه‌ی درست پاسخ می‌دهد
				'callback'            => array( __CLASS__, 'rest_verify' ),
			)
		);
	}

	public static function rest_verify( $request ) {
		$hs = get_option( self::OPT_HANDSHAKE );
		$id = (string) $request->get_param( 'handshake' );
		if ( ! is_array( $hs ) || empty( $hs['id'] ) || (int) $hs['expires'] < time() || ! hash_equals( (string) $hs['id'], $id ) ) {
			return new WP_Error( 'emzagar_not_found', 'Not found', array( 'status' => 404 ) );
		}
		$res = rest_ensure_response( array( 'challenge' => (string) $hs['challenge'] ) );
		$res->header( 'Cache-Control', 'no-store' );
		return $res;
	}

	/* ───────────── HTTP ───────────── */

	private static function post( $url, $body, $timeout ) {
		$res = wp_remote_post(
			$url,
			array(
				'timeout'     => $timeout,
				'redirection' => 0,
				'headers'     => array(
					'Content-Type' => 'application/json',
					'Accept'       => 'application/json',
					'User-Agent'   => 'EmzagarWP/' . EMZ_VERSION . '; ' . home_url(),
				),
				'body'        => wp_json_encode( $body ),
			)
		);
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'emzagar_http', __( 'ارتباط با سرویس امضاگیر برقرار نشد. اتصال اینترنت سرور را بررسی کنید.', 'emzagar' ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$json = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( $code < 200 || $code >= 300 || ! is_array( $json ) || empty( $json['ok'] ) ) {
			return new WP_Error( 'emzagar_api', Emzagar_API::explain( $code, $json ) );
		}
		return $json;
	}

	/* ───────────── کنش‌های مدیر ───────────── */

	/** «باز کردن پنل امضاگیر»: ورود یک‌کلیکی (SSO) با توکن ۹۰ ثانیه‌ای */
	public static function open_panel() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( 'emzagar_open_panel' );
		$to     = isset( $_GET['to'] ) ? sanitize_key( wp_unslash( $_GET['to'] ) ) : 'admin'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- nonce بالا بررسی شده است
		$to     = in_array( $to, array( 'admin', 'templates', 'contracts', 'settings', 'new' ), true ) ? $to : 'admin';
		$o      = emzagar_options();
		$result = Emzagar_API::request( 'POST', '/api/v1/connect/sso', array(), array( 'target' => $to ) );
		$base   = $o['base_url'] ? $o['base_url'] : self::cloud_url();
		if ( is_wp_error( $result ) || empty( $result['url'] ) ) {
			$url = $base ? $base . '/login' : '';
		} else {
			$url = (string) $result['url'];
		}
		// فقط به همان میزبان ابر هدایت می‌شود
		$ok = $url && wp_parse_url( $url, PHP_URL_HOST ) === wp_parse_url( $base, PHP_URL_HOST );
		if ( ! $ok ) {
			wp_die( esc_html__( 'باز کردن پنل ممکن نشد. چند لحظه بعد دوباره امتحان کنید.', 'emzagar' ), '', array( 'back_link' => true ) );
		}
		wp_redirect( $url ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect -- مقصد خارجی عمداً به میزبان ابر محدود شده است
		exit;
	}

	/** «اتصال دوباره» */
	public static function handle_reconnect() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( 'emzagar_reconnect' );
		delete_transient( 'emzagar_connect_lock' );
		$res = self::connect( true );
		if ( is_wp_error( $res ) ) {
			self::schedule_retry( 120 );
		}
		wp_safe_redirect( add_query_arg( 'emz_connect', is_wp_error( $res ) ? 'fail' : 'ok', admin_url( 'admin.php?page=emzagar' ) ) );
		exit;
	}

	public static function last_error() {
		$e = get_option( self::OPT_ERROR, '' );
		return is_string( $e ) ? $e : '';
	}

	/** آدرس امن «باز کردن پنل» با nonce */
	public static function panel_link( $to = 'admin' ) {
		return wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_open_panel&to=' . rawurlencode( $to ) ), 'emzagar_open_panel' );
	}

	public static function reconnect_link() {
		return wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_reconnect' ), 'emzagar_reconnect' );
	}
}
