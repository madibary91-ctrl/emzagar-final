<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * به‌روزرسانی خودکار افزونه از «ابر» خودِ شما + نمایش وضعیت لایسنس (Turnkey).
 *
 * جریان:
 *   وردپرس ← (هر ۱۲ ساعت) ← فیلتر update_plugins ← این کلاس ← GET /api/v1/connect/update-check (با کلید API)
 *   ابر ← نسخه‌ی افزونه‌ی همراه خودش + وضعیت لایسنس (که خودش با سرور فروشنده بررسی کرده) را برمی‌گرداند.
 *
 * یعنی خریدار یک بار ابر (VPS) را به‌روز می‌کند؛ همه‌ی سایت‌های وردپرسی‌اش خودکار همان نسخه‌ی افزونه را می‌گیرند.
 *
 * ایمنی:
 *   • بسته فقط از همان میزبان ابر پذیرفته می‌شود (HTTPS) و پیش از نصب بررسی ساختار zip انجام می‌شود.
 *   • (CR-05) هیچ بسته‌ای بدون «امضای دیجیتال Ed25519 ناشر» نصب نمی‌شود: امضا با کلید پین‌شده در Emzagar_Release،
 *     SHA-256 تک‌تک فایل‌ها، فهرست دقیق فایل‌ها و ضد بازگشت نسخه، هم روی zip و هم روی پوشه‌ی استخراج‌شده (فیلتر
 *     upgrader_source_selection که از هر مسیر دانلودی عبور اجباری است). ابر فقط پخش‌کننده است، نه مرجع اعتماد.
 *   • پیش از هر به‌روزرسانی، از قوانین/فرم‌ها/تنظیمات پشتیبان گرفته می‌شود (تب «داده‌ها» ← بازگردانی).
 *   • به‌روزرسانی خودکار پیش‌فرض فقط برای نسخه‌های هم‌خانواده (مثلاً 2.x ← 2.y) است؛ نسخه‌ی major دستی است.
 *   • قطع بودن ابر یا لایسنس، هیچ‌وقت افزونه را غیرفعال نمی‌کند.
 */
class Emzagar_Updater {

	const OPT       = 'emzagar_updater';
	const TRANSIENT = 'emz_update_info';
	const SLUG      = 'emzagar-contracts';

	public static function init() {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'inject' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_info' ), 20, 3 );
		add_filter( 'upgrader_pre_download', array( __CLASS__, 'pre_download' ), 10, 3 );
		add_filter( 'upgrader_source_selection', array( __CLASS__, 'source_selection' ), 5, 4 );
		add_filter( 'upgrader_pre_install', array( __CLASS__, 'pre_install' ), 10, 2 );
		add_filter( 'auto_update_plugin', array( __CLASS__, 'auto_update' ), 20, 2 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'after_upgrade' ), 10, 2 );
		if ( is_admin() ) {
			add_action( 'admin_post_emzagar_update_check', array( __CLASS__, 'act_check' ) );
			add_action( 'admin_post_emzagar_update_save', array( __CLASS__, 'act_save' ) );
		}
	}

	private static function basename() {
		return plugin_basename( EMZ_FILE );
	}

	/* ───────────── تنظیمات ───────────── */

	public static function opts() {
		$s = get_option( self::OPT, array() );
		return wp_parse_args( is_array( $s ) ? $s : array(), array( 'auto' => 'minor' ) ); // off | minor | all
	}

	/* ───────────── اطلاعات از ابر ───────────── */

	/** فقط از کش می‌خواند (هرگز درخواست شبکه نمی‌زند؛ برای صفحه‌هایی که نباید کند شوند) */
	public static function cached() {
		$c = get_option( self::TRANSIENT, array() );
		return is_array( $c ) ? $c : array();
	}

	/**
	 * اطلاعات به‌روزرسانی (کش‌شده ۶ ساعته).
	 *
	 * @param bool $force نادیده‌گرفتن کش
	 * @return array
	 */
	public static function info( $force = false ) {
		$cached = get_option( self::TRANSIENT, array() );
		$cached = is_array( $cached ) ? $cached : array();
		if ( ! $force && ! empty( $cached['checked'] ) && ( time() - (int) $cached['checked'] ) < 6 * HOUR_IN_SECONDS ) {
			return $cached;
		}
		if ( ! $force && ! Emzagar_API::is_configured() ) {
			return $cached;
		}
		// جلوگیری از کوبیدن ابر هنگام خطا: حداکثر هر ۵ دقیقه یک تلاش
		if ( ! $force && ! empty( $cached['tried'] ) && ( time() - (int) $cached['tried'] ) < 5 * MINUTE_IN_SECONDS ) {
			return $cached;
		}
		$cached['tried'] = time();
		update_option( self::TRANSIENT, $cached, false );

		$res = Emzagar_API::request( 'GET', '/api/v1/connect/update-check', array( 'v' => EMZ_VERSION ) );
		if ( is_wp_error( $res ) ) {
			$cached['error'] = $res->get_error_message();
			update_option( self::TRANSIENT, $cached, false );
			return $cached;
		}
		$p    = isset( $res['plugin'] ) && is_array( $res['plugin'] ) ? $res['plugin'] : array();
		$info = array(
			'checked'   => time(),
			'tried'     => time(),
			'error'     => '',
			'version'   => isset( $p['version'] ) ? (string) $p['version'] : '',
			'package'   => isset( $p['package'] ) ? (string) $p['package'] : '',
			'changelog' => isset( $p['changelog'] ) ? (string) $p['changelog'] : '',
			'requires'  => isset( $p['requires'] ) ? (string) $p['requires'] : '',
			'php'       => isset( $p['requiresPhp'] ) ? (string) $p['requiresPhp'] : '',
			'blocked'   => isset( $p['blocked'] ) ? (string) $p['blocked'] : '',
			'cloud'     => isset( $res['cloudVersion'] ) ? (string) $res['cloudVersion'] : '',
			'license'   => isset( $res['license'] ) && is_array( $res['license'] ) ? $res['license'] : array(),
		);
		update_option( self::TRANSIENT, $info, false );
		return $info;
	}

	/** نسخه‌ی جدیدتر موجود (و مجاز) یا رشته‌ی خالی */
	public static function available( $info = null ) {
		$info = null === $info ? self::info( false ) : $info;
		if ( empty( $info['version'] ) || empty( $info['package'] ) ) {
			return '';
		}
		return version_compare( $info['version'], EMZ_VERSION, '>' ) ? (string) $info['version'] : '';
	}

	/** بسته فقط از میزبان ابر و با HTTPS (یا محلی) */
	private static function package_ok( $url ) {
		$base = emzagar_options()['base_url'];
		$base = '' !== $base ? $base : Emzagar_Connect::cloud_url();
		$h1   = wp_parse_url( (string) $url, PHP_URL_HOST );
		$h2   = wp_parse_url( (string) $base, PHP_URL_HOST );
		if ( ! $h1 || ! $h2 || strtolower( $h1 ) !== strtolower( $h2 ) ) {
			return false;
		}
		return 0 === strpos( (string) $url, 'https://' ) || Emzagar_Connect::is_acceptable_cloud( (string) $base );
	}

	public static function license_label( $lic ) {
		$states = array(
			'active'        => __( 'فعال', 'emzagar' ),
			'unlicensed'    => __( 'بدون لایسنس', 'emzagar' ),
			'grace_expired' => __( 'مهلت آفلاین تمام شده (ابر به سرور لایسنس وصل نشده)', 'emzagar' ),
			'expired'       => __( 'منقضی شده', 'emzagar' ),
			'revoked'       => __( 'باطل شده', 'emzagar' ),
			'suspended'     => __( 'معلق', 'emzagar' ),
			'invalid'       => __( 'نامعتبر', 'emzagar' ),
			'domain_limit'  => __( 'ظرفیت دامنه پر است', 'emzagar' ),
		);
		$s   = isset( $lic['state'] ) ? (string) $lic['state'] : '';
		$out = isset( $states[ $s ] ) ? $states[ $s ] : __( 'نامشخص', 'emzagar' );
		if ( 'unlicensed' === $s && isset( $lic['required'] ) && ! $lic['required'] ) {
			$out = __( 'بدون لایسنس (نسخه‌ی آزاد، همه‌چیز فعال است)', 'emzagar' );
		}
		if ( ! empty( $lic['plan'] ) ) {
			$out .= ' · ' . $lic['plan'];
		}
		return $out;
	}

	/* ───────────── قلاب‌های وردپرس ───────────── */

	public static function inject( $transient ) {
		if ( ! is_object( $transient ) || empty( $transient->checked ) ) {
			return $transient;
		}
		$info = self::info( false );
		$ver  = self::available( $info );
		$bn   = self::basename();
		$item = (object) array(
			'id'            => 'emzagar-cloud/' . self::SLUG,
			'slug'          => self::SLUG,
			'plugin'        => $bn,
			'new_version'   => '' !== $ver ? $ver : EMZ_VERSION,
			'url'           => Emzagar_Connect::cloud_url(),
			'package'       => '',
			'icons'         => array(),
			'banners'       => array(),
			'tested'        => ! empty( $info['tested'] ) ? $info['tested'] : '',
			'requires'      => ! empty( $info['requires'] ) ? $info['requires'] : '',
			'requires_php'  => ! empty( $info['php'] ) ? $info['php'] : '',
		);
		if ( '' !== $ver && self::package_ok( $info['package'] ) ) {
			$item->package = $info['package'];
			if ( ! isset( $transient->response ) || ! is_array( $transient->response ) ) {
				$transient->response = array();
			}
			$transient->response[ $bn ] = $item;
			if ( isset( $transient->no_update[ $bn ] ) ) {
				unset( $transient->no_update[ $bn ] );
			}
		} else {
			if ( ! isset( $transient->no_update ) || ! is_array( $transient->no_update ) ) {
				$transient->no_update = array();
			}
			$transient->no_update[ $bn ] = $item;
		}
		return $transient;
	}

	public static function plugin_info( $res, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || self::SLUG !== $args->slug ) {
			return $res;
		}
		$info = self::info( false );
		$ver  = ! empty( $info['version'] ) ? $info['version'] : EMZ_VERSION;
		return (object) array(
			'name'          => 'امضاگیر — قرارداد و امضای آنلاین',
			'slug'          => self::SLUG,
			'version'       => $ver,
			'author'        => '<a href="https://github.com/madibary91-ctrl/emzagar-final">Emzagar</a>',
			'homepage'      => Emzagar_Connect::cloud_url(),
			'requires'      => ! empty( $info['requires'] ) ? $info['requires'] : '5.8',
			'requires_php'  => ! empty( $info['php'] ) ? $info['php'] : '7.4',
			'last_updated'  => ! empty( $info['checked'] ) ? gmdate( 'Y-m-d H:i:s', (int) $info['checked'] ) : '',
			'sections'      => array(
				'description' => esc_html__( 'امضای آنلاین قرارداد برای وردپرس و ووکامرس با مرکز فرماندهی، اتوماسیون و اتصال فرم‌ها.', 'emzagar' ),
				'changelog'   => '<pre style="white-space:pre-wrap">' . esc_html( ! empty( $info['changelog'] ) ? $info['changelog'] : '' ) . '</pre>',
			),
			'download_link' => ! empty( $info['package'] ) ? $info['package'] : '',
		);
	}

	/** آدرس‌های ابرِ شناخته‌شده‌ی خود افزونه (برای تطبیق دقیق emzagar-config.php بسته) */
	private static function trusted_origins() {
		$out  = array();
		$base = emzagar_options()['base_url'];
		foreach ( array( Emzagar_Connect::cloud_url(), $base ) as $u ) {
			$u = is_string( $u ) && '' !== $u ? Emzagar_API::clean_base_url( $u ) : '';
			if ( '' !== $u ) {
				$out[] = $u;
			}
		}
		return array_values( array_unique( $out ) );
	}

	/** نسخه‌ی اعلام‌شده‌ی ابر (از کش؛ هرگز درخواست شبکه نمی‌زند) */
	private static function advertised_version() {
		$c = self::cached();
		return ! empty( $c['version'] ) ? (string) $c['version'] : '';
	}

	/** آیا این بسته همان بسته‌ی به‌روزرسانی افزونه است؟ */
	private static function is_our_package( $package ) {
		if ( ! is_string( $package ) || '' === $package ) {
			return false;
		}
		$c = self::cached();
		return false !== strpos( $package, '/api/wordpress/plugin' ) || ( ! empty( $c['package'] ) && $package === $c['package'] );
	}

	/** دانلود امن بسته: بررسی میزبان، ساختار zip و امضای دیجیتال ناشر */
	public static function pre_download( $reply, $package, $upgrader ) {
		unset( $upgrader );
		if ( false !== $reply || ! self::is_our_package( $package ) ) {
			return $reply;
		}
		if ( ! self::package_ok( $package ) ) {
			return new WP_Error( 'emzagar_pkg_host', __( 'آدرس بسته‌ی به‌روزرسانی با ابر شما یکی نیست؛ برای امنیت رد شد.', 'emzagar' ) );
		}
		if ( ! function_exists( 'download_url' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		$tmp = download_url( $package, 120 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}
		$fh  = fopen( $tmp, 'rb' ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		$sig = $fh ? fread( $fh, 2 ) : ''; // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( $fh ) {
			fclose( $fh ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		}
		$ok = ( 'PK' === $sig && filesize( $tmp ) > 20000 );
		if ( ! $ok ) {
			wp_delete_file( $tmp );
			return new WP_Error( 'emzagar_pkg_bad', __( 'فایل به‌روزرسانی معتبر نیست؛ نسخه‌ی فعلی دست‌نخورده ماند.', 'emzagar' ) );
		}
		if ( class_exists( 'ZipArchive' ) ) {
			$v = Emzagar_Release::verify_zip( $tmp, self::advertised_version(), EMZ_VERSION, self::trusted_origins() );
			if ( is_wp_error( $v ) ) {
				wp_delete_file( $tmp );
				return $v;
			}
		}
		// بدون ZipArchive، بررسی کامل را source_selection روی فایل‌های استخراج‌شده انجام می‌دهد (اجباری).
		return $tmp;
	}

	/**
	 * خط دفاعی نهایی (CR-05): فایل‌هایی که «واقعاً» قرار است جایگزین افزونه شوند با امضای ناشر سنجیده می‌شوند.
	 * این فیلتر مستقل از آدرس دانلود اجرا می‌شود؛ پس حتی بسته‌ی جعلی با آدرس دلخواه هم از آن عبور نمی‌کند.
	 *
	 * @param string|WP_Error $source        پوشه‌ی استخراج‌شده
	 * @param string          $remote_source پوشه‌ی موقت
	 * @param object          $upgrader      ارتقادهنده
	 * @param array           $hook_extra    اطلاعات افزونه
	 */
	public static function source_selection( $source, $remote_source = '', $upgrader = null, $hook_extra = array() ) {
		unset( $remote_source, $upgrader );
		if ( is_wp_error( $source ) || ! is_array( $hook_extra ) || empty( $hook_extra['plugin'] ) || self::basename() !== $hook_extra['plugin'] ) {
			return $source;
		}
		$v = Emzagar_Release::verify_dir( (string) $source, self::advertised_version(), EMZ_VERSION, self::trusted_origins() );
		return is_wp_error( $v ) ? $v : $source;
	}

	/** پیش از جایگزینی فایل‌ها: پشتیبان از قوانین/فرم‌ها/تنظیمات */
	public static function pre_install( $response, $hook_extra ) {
		if ( isset( $hook_extra['plugin'] ) && self::basename() === $hook_extra['plugin'] ) {
			try {
				Emzagar_Export::take_snapshot( 'before-update' );
			} catch ( \Throwable $e ) { // phpcs:ignore PHPCompatibility.Keywords.NewKeywords.t_throwableFound
				unset( $e ); // پشتیبان‌گیری نباید مانع به‌روزرسانی شود
			}
		}
		return $response;
	}

	public static function auto_update( $update, $item ) {
		if ( ! is_object( $item ) || empty( $item->plugin ) || self::basename() !== $item->plugin ) {
			return $update;
		}
		$mode = self::opts()['auto'];
		if ( 'all' === $mode ) {
			return true;
		}
		if ( 'minor' === $mode ) {
			$new = isset( $item->new_version ) ? (string) $item->new_version : '';
			return (int) $new === (int) EMZ_VERSION && version_compare( $new, EMZ_VERSION, '>' ) ? true : false;
		}
		return false;
	}

	public static function after_upgrade( $upgrader, $extra ) {
		unset( $upgrader );
		if ( isset( $extra['type'], $extra['action'] ) && 'plugin' === $extra['type'] && 'update' === $extra['action'] ) {
			delete_option( self::TRANSIENT );
			Emzagar_API::flush_cache();
		}
	}

	/** پس از ضربان روزانه: اطلاعات لایسنس و نسخه تازه می‌شود */
	public static function refresh() {
		return self::info( true );
	}

	/* ───────────── مدیریت ───────────── */

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	public static function act_check() {
		self::guard( 'emzagar_update_check' );
		$info = self::info( true );
		delete_site_transient( 'update_plugins' ); // وردپرس فهرست را دوباره بسازد
		wp_safe_redirect( add_query_arg( 'emz_u', empty( $info['error'] ) ? ( self::available( $info ) ? 'new' : 'latest' ) : 'err', Emzagar_Settings::tab_url( 'license' ) ) );
		exit;
	}

	public static function act_save() {
		self::guard( 'emzagar_update_save' );
		$m = isset( $_POST['auto'] ) ? sanitize_key( wp_unslash( $_POST['auto'] ) ) : 'minor'; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		update_option( self::OPT, array( 'auto' => in_array( $m, array( 'off', 'minor', 'all' ), true ) ? $m : 'minor' ), false );
		wp_safe_redirect( add_query_arg( 'emz_u', 'saved', Emzagar_Settings::tab_url( 'license' ) ) );
		exit;
	}

	public static function update_link() {
		$bn = self::basename();
		return wp_nonce_url( self_admin_url( 'update.php?action=upgrade-plugin&plugin=' . rawurlencode( $bn ) ), 'upgrade-plugin_' . $bn );
	}

	public static function render_tab() {
		$info = self::info( false );
		$ver  = self::available( $info );
		$lic  = isset( $info['license'] ) && is_array( $info['license'] ) ? $info['license'] : array();
		$o    = self::opts();
		$code = isset( $_GET['emz_u'] ) ? sanitize_key( wp_unslash( $_GET['emz_u'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$msgs = array(
			'new'    => array( 'success', __( 'نسخه‌ی جدید پیدا شد.', 'emzagar' ) ),
			'latest' => array( 'success', __( 'شما آخرین نسخه را دارید ✓', 'emzagar' ) ),
			'err'    => array( 'error', __( 'بررسی به‌روزرسانی ناموفق بود (جزئیات پایین).', 'emzagar' ) ),
			'saved'  => array( 'success', __( 'تنظیمات به‌روزرسانی ذخیره شد.', 'emzagar' ) ),
		);
		if ( isset( $msgs[ $code ] ) ) {
			printf( '<div class="notice notice-%s is-dismissible"><p>%s</p></div>', esc_attr( $msgs[ $code ][0] ), esc_html( $msgs[ $code ][1] ) );
		}
		$ls     = isset( $lic['state'] ) ? (string) $lic['state'] : '';
		$status = empty( $lic ) ? 'off' : ( 'active' === $ls ? 'ok' : ( 'unlicensed' === $ls ? 'warn' : 'bad' ) );
		$cloud  = Emzagar_Connect::cloud_url();
		?>
		<section class="emz-card">
			<h2>🚀 <?php esc_html_e( 'به‌روزرسانی خودکار', 'emzagar' ); ?></h2>
			<div class="emz-versions">
				<div><span><?php esc_html_e( 'نسخه‌ی نصب‌شده', 'emzagar' ); ?></span><b dir="ltr"><?php echo esc_html( EMZ_VERSION ); ?></b></div>
				<div><span><?php esc_html_e( 'آخرین نسخه‌ی ابر شما', 'emzagar' ); ?></span><b dir="ltr"><?php echo esc_html( ! empty( $info['version'] ) ? $info['version'] : '—' ); ?></b></div>
				<div><span><?php esc_html_e( 'آخرین بررسی', 'emzagar' ); ?></span><b><?php echo ! empty( $info['checked'] ) ? esc_html( sprintf( /* translators: %s: time */ __( '%s پیش', 'emzagar' ), human_time_diff( (int) $info['checked'] ) ) ) : '—'; ?></b></div>
			</div>
			<?php if ( ! empty( $info['error'] ) ) : ?>
				<p class="emz-err" role="alert"><?php echo esc_html( $info['error'] ); ?></p>
			<?php endif; ?>
			<?php if ( ! empty( $info['blocked'] ) ) : ?>
				<p class="emz-err" role="alert"><?php echo esc_html( $info['blocked'] ); ?></p>
			<?php endif; ?>
			<p class="emz-actions">
				<?php if ( $ver ) : ?>
					<a class="button button-primary button-hero" href="<?php echo esc_url( self::update_link() ); ?>"><?php echo esc_html( sprintf( /* translators: %s: version */ __( 'به‌روزرسانی به %s', 'emzagar' ), $ver ) ); ?></a>
				<?php else : ?>
					<span class="emz-pill emz-pill-ok"><?php esc_html_e( 'به‌روز است', 'emzagar' ); ?></span>
				<?php endif; ?>
				<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_update_check' ), 'emzagar_update_check' ) ); ?>"><?php esc_html_e( 'بررسی همین حالا', 'emzagar' ); ?></a>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="emz-inline-form">
				<input type="hidden" name="action" value="emzagar_update_save">
				<?php wp_nonce_field( 'emzagar_update_save' ); ?>
				<label for="emz-auto"><?php esc_html_e( 'به‌روزرسانی خودکار:', 'emzagar' ); ?></label>
				<select id="emz-auto" name="auto">
					<option value="minor" <?php selected( 'minor', $o['auto'] ); ?>><?php esc_html_e( 'فقط نسخه‌های هم‌خانواده (توصیه‌شده)', 'emzagar' ); ?></option>
					<option value="all" <?php selected( 'all', $o['auto'] ); ?>><?php esc_html_e( 'همه‌ی نسخه‌ها', 'emzagar' ); ?></option>
					<option value="off" <?php selected( 'off', $o['auto'] ); ?>><?php esc_html_e( 'خاموش (فقط دستی)', 'emzagar' ); ?></option>
				</select>
				<?php submit_button( __( 'ذخیره', 'emzagar' ), 'secondary', 'submit', false ); ?>
			</form>
			<p class="description"><?php esc_html_e( 'پیش از هر به‌روزرسانی، از قوانین، فرم‌ها و تنظیمات پشتیبان گرفته می‌شود (تب «داده‌ها»).', 'emzagar' ); ?></p>
			<?php if ( ! empty( $info['changelog'] ) ) : ?>
				<details><summary><?php esc_html_e( 'تغییرات نسخه‌ی جدید', 'emzagar' ); ?></summary><pre class="emz-code"><?php echo esc_html( $info['changelog'] ); ?></pre></details>
			<?php endif; ?>
		</section>

		<section class="emz-card">
			<h2>🔑 <?php esc_html_e( 'لایسنس', 'emzagar' ); ?></h2>
			<?php if ( empty( $lic ) ) : ?>
				<p class="description"><?php esc_html_e( 'اطلاعات لایسنس پس از اتصال و اولین بررسی از ابر می‌رسد.', 'emzagar' ); ?></p>
			<?php else : ?>
				<p><?php echo Emzagar_Health::lamp( $status ); // phpcs:ignore WordPress.Security.EscapeOutput ?> <b><?php echo esc_html( self::license_label( $lic ) ); ?></b></p>
				<table class="widefat striped emz-kv"><tbody>
					<?php if ( ! empty( $lic['customer'] ) ) : ?><tr><th><?php esc_html_e( 'خریدار', 'emzagar' ); ?></th><td><?php echo esc_html( $lic['customer'] ); ?></td></tr><?php endif; ?>
					<?php if ( ! empty( $lic['domain'] ) ) : ?><tr><th><?php esc_html_e( 'دامنه‌ی ابر', 'emzagar' ); ?></th><td dir="ltr"><?php echo esc_html( $lic['domain'] ); ?></td></tr><?php endif; ?>
					<?php if ( ! empty( $lic['expiresAt'] ) ) : ?><tr><th><?php esc_html_e( 'پایان لایسنس', 'emzagar' ); ?></th><td><?php echo esc_html( wp_date( get_option( 'date_format' ), strtotime( $lic['expiresAt'] ) ) ); ?></td></tr><?php endif; ?>
					<?php if ( ! empty( $lic['updatesUntil'] ) ) : ?><tr><th><?php esc_html_e( 'دسترسی به آپدیت تا', 'emzagar' ); ?></th><td><?php echo esc_html( wp_date( get_option( 'date_format' ), strtotime( $lic['updatesUntil'] ) ) ); ?></td></tr><?php endif; ?>
					<?php if ( ! empty( $lic['maxDomains'] ) ) : ?><tr><th><?php esc_html_e( 'دامنه‌های فعال', 'emzagar' ); ?></th><td><?php echo (int) ( isset( $lic['usedDomains'] ) ? $lic['usedDomains'] : 0 ); ?> / <?php echo (int) $lic['maxDomains']; ?></td></tr><?php endif; ?>
				</tbody></table>
			<?php endif; ?>
			<p class="description"><?php esc_html_e( 'لایسنس روی ابر (سرور شما) فعال می‌شود و یک‌بار برای همه‌ی سایت‌های وردپرسی متصل کافی است. با قطع شدن ارتباط با سرور لایسنس، تا ۱۴ روز همه‌چیز عادی کار می‌کند.', 'emzagar' ); ?></p>
			<?php if ( '' !== $cloud ) : ?>
				<p><a class="button" target="_blank" rel="noopener" href="<?php echo esc_url( $cloud . '/platform/license' ); ?>"><?php esc_html_e( 'مدیریت لایسنس در پنل ابر', 'emzagar' ); ?></a></p>
			<?php endif; ?>
		</section>
		<?php
	}
}
