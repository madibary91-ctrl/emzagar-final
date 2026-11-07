<?php
/**
 * Plugin Name:       امضاگیر – قرارداد و امضای آنلاین (Emzagar Contracts)
 * Plugin URI:        https://github.com/madibary91-ctrl/emzagar-final
 * Description:       امضای آنلاین قرارداد برای وردپرس و ووکامرس؛ نسخه‌ی سازمانی: کلید روشن/خاموش مستقل برای هر ماژول با سپر ایمنی خودکار، خروجی/ورود کامل داده (JSON/CSV/ZIP)، صفحه‌ی «وضعیت سیستم» با چراغ سبز/قرمز، ویزارد خوش‌آمدگویی، محدودیت نرخ و قفل اضطراری ضد اسپم، به‌روزرسانی خودکار و لایسنس. مرکز فرماندهی کامل داخل پیشخوان: «میز کار قراردادها» (کانبان، جزئیات، صدور، دانلود PDF)، پالت فرمان Ctrl+K، اعلان زنده‌ی امضا، اتوماسیون «اگر … آنگاه»، اتصال فرم‌ها به قرارداد و WP-CLI؛ همراه با «مرکز فرماندهی کسب‌وکار»، دروازه‌ی قرارداد روی محتوا و محصول، نقش خودکار پس از امضا، گزارش هفتگی و نشان اعتماد. نصب، فعال‌سازی، کار می‌کند — بدون کلید API و بدون تنظیمات. داشبورد قراردادها (شورت‌کد و المنتور)، صدور خودکار قرارداد پس از خرید، همگام‌سازی دوطرفه و لحظه‌ای سفارش‌ها/مشتریان/وضعیت امضا با ابر، اتوماسیون وضعیت سفارش و نمایش وضعیت امضا به مشتری و مدیر.
 * Version:           2.3.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Emzagar
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       emzagar
 * Domain Path:       /languages
 * WC requires at least: 6.0
 * WC tested up to:   9.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // دسترسی مستقیم ممنوع
}

define( 'EMZ_VERSION', '2.3.0' );
define( 'EMZ_FILE', __FILE__ );
define( 'EMZ_DIR', plugin_dir_path( __FILE__ ) );
define( 'EMZ_URL', plugin_dir_url( __FILE__ ) );
define( 'EMZ_OPTION', 'emzagar_options' );

/**
 * آدرس پیش‌فرض ابر امضاگیر.
 * نسخه‌ی دانلودشده از پنل امضاگیر، آدرس را خودکار داخل فایل emzagar-config.php قرار می‌دهد؛
 * پس معمولاً نیازی به تغییر این مقدار نیست. برای انتشار عمومی می‌توانید اینجا آدرس رسمی را بنویسید
 * یا در wp-config.php ثابت EMZAGAR_CLOUD_URL را تعریف کنید.
 */
if ( ! defined( 'EMZ_DEFAULT_CLOUD_URL' ) ) {
	define( 'EMZ_DEFAULT_CLOUD_URL', '' );
}

require_once EMZ_DIR . 'includes/class-emzagar-api.php';
require_once EMZ_DIR . 'includes/class-emzagar-sync.php';
require_once EMZ_DIR . 'includes/class-emzagar-connect.php';
require_once EMZ_DIR . 'includes/class-emzagar-settings.php';
require_once EMZ_DIR . 'includes/class-emzagar-access.php';
require_once EMZ_DIR . 'includes/class-emzagar-hub.php';
require_once EMZ_DIR . 'includes/class-emzagar-inbox.php';
require_once EMZ_DIR . 'includes/class-emzagar-workspace.php';
require_once EMZ_DIR . 'includes/class-emzagar-palette.php';
require_once EMZ_DIR . 'includes/class-emzagar-automations.php';
require_once EMZ_DIR . 'includes/class-emzagar-forms.php';
require_once EMZ_DIR . 'includes/class-emzagar-shortcodes.php';
require_once EMZ_DIR . 'includes/class-emzagar-woocommerce.php';
require_once EMZ_DIR . 'includes/class-emzagar-order-ui.php';
require_once EMZ_DIR . 'includes/class-emzagar-elementor.php';
require_once EMZ_DIR . 'includes/class-emzagar-modules.php';
require_once EMZ_DIR . 'includes/class-emzagar-limits.php';
require_once EMZ_DIR . 'includes/class-emzagar-export.php';
require_once EMZ_DIR . 'includes/class-emzagar-release.php';
require_once EMZ_DIR . 'includes/class-emzagar-updater.php';
require_once EMZ_DIR . 'includes/class-emzagar-health.php';
require_once EMZ_DIR . 'includes/class-emzagar-onboarding.php';
if ( defined( 'WP_CLI' ) && WP_CLI ) {
	require_once EMZ_DIR . 'includes/class-emzagar-cli.php';
}

/** پیکربندی بسته‌بندی‌شده توسط ابر (emzagar-config.php): cloud_url و کد جفت‌سازی یک‌بارمصرف */
function emzagar_packaged_config() {
	static $cfg = null;
	if ( null === $cfg ) {
		$cfg  = array();
		$file = EMZ_DIR . 'emzagar-config.php';
		if ( is_readable( $file ) ) {
			$loaded = include $file;
			$cfg    = is_array( $loaded ) ? $loaded : array();
		}
	}
	return $cfg;
}

/** تنظیمات ذخیره‌شده با مقادیر پیش‌فرض */
function emzagar_options() {
	$defaults = array(
		'base_url'         => '',
		'api_key'          => '',
		'connection'       => '',           // auto (اتصال خودکار) | manual (کلید دستی)
		'cloud_url'        => '',           // آدرس ابر، فقط وقتی بسته‌بندی نشده باشد
		'workspace'        => '',
		'verified'         => 'no',
		'sso'              => 'no',
		'page_id'          => 0,
		'connected_at'     => 0,
		'pairing_used'     => '',
		'cache_minutes'    => 2,
		'default_template' => 0,
		'wc_enabled'       => 'yes',
		'wc_trigger'       => 'processing', // processing | completed
		'wc_all_orders'    => 'no',         // صدور برای همه‌ی سفارش‌ها با قالب پیش‌فرض
		'wc_expiry_days'   => 14,
		// همگام‌سازی دوطرفه و اتوماسیون سفارش (نسخه‌ی ۲)
		'sync_orders'         => 'yes',        // ارسال سفارش‌ها به ابر
		'sync_customers'      => 'yes',        // ارسال مشتریان به ابر
		'wc_hold_until_signed' => 'no',        // سفارش پرداخت‌شده تا امضای قرارداد «در انتظار بررسی» بماند
		'wc_on_signed'        => 'none',       // پس از امضای همه: none | processing | completed
		'wc_on_reject'        => 'none',       // پس از رد/انقضا/لغو: none | on-hold | cancelled
		'wc_gate_downloads'   => 'no',         // دانلود محصول مجازی فقط پس از امضا
		'accent'           => '#0f766e',
	);
	$saved = get_option( EMZ_OPTION, array() );
	return wp_parse_args( is_array( $saved ) ? $saved : array(), $defaults );
}

/**
 * راه‌اندازی افزونه.
 * هسته (اتصال، تنظیمات، سلامت، خروجی داده، محدودیت نرخ، به‌روزرسانی، ویزارد) همیشه فعال است؛
 * بقیه‌ی قابلیت‌ها «ماژول» هستند و هر کدام کلید روشن/خاموش و سپر ایمنی مستقل دارند (Emzagar_Modules).
 */
function emzagar_boot() {
	load_plugin_textdomain( 'emzagar', false, dirname( plugin_basename( EMZ_FILE ) ) . '/languages' );

	// هسته
	Emzagar_Connect::init();
	Emzagar_Settings::init();
	Emzagar_Limits::init();
	Emzagar_Export::init();
	Emzagar_Updater::init();
	Emzagar_Health::init();
	Emzagar_Onboarding::init();
	if ( is_admin() ) {
		Emzagar_Modules::init_admin();
	}

	// ماژول‌های اختیاری (هر کدام در پوسته‌ی امن)
	Emzagar_Modules::boot();

	emzagar_maybe_upgrade();
	if ( ! wp_next_scheduled( 'emzagar_daily_maintenance' ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'emzagar_daily_maintenance' );
	}
}
add_action( 'plugins_loaded', 'emzagar_boot' );

/** پس از تغییر ماژول ووکامرس، آدرس‌های حساب کاربری باید دوباره ساخته شوند */
add_action(
	'init',
	function () {
		if ( get_option( 'emzagar_flush_rewrite' ) ) {
			delete_option( 'emzagar_flush_rewrite' );
			flush_rewrite_rules();
		}
	},
	99
);

/** کارهای ارتقا: وقتی نسخه‌ی ذخیره‌شده با نسخه‌ی فایل فرق دارد (نصب تازه یا به‌روزرسانی) */
function emzagar_maybe_upgrade() {
	$stored = get_option( 'emzagar_version', '' );
	if ( EMZ_VERSION === $stored ) {
		return;
	}
	update_option( 'emzagar_version', EMZ_VERSION, false );
	delete_option( Emzagar_Updater::TRANSIENT );
	delete_transient( 'emz_health_bad' );
	if ( '' !== $stored && version_compare( $stored, '2.3.0', '<' ) ) {
		// کاربران قدیمی راهنمای شروع را اجباری نمی‌بینند؛ فقط نوار پیشنهاد در تنظیمات
		update_option( Emzagar_Onboarding::OPT, array( 'done' => false, 'step' => 0, 'completed_at' => 0 ), false );
	}
}

/** سازگاری با ذخیره‌سازی سفارش‌های ووکامرس (HPOS) */
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( '\Automattic\WooCommerce\Utilities\FeaturesUtil' ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', EMZ_FILE, true );
		}
	}
);

/**
 * فعال‌سازی = اتصال. کاربر هیچ کاری نمی‌کند؛ اگر اتصال لحظه‌ای ممکن نشد، تلاش در پس‌زمینه ادامه می‌یابد.
 */
register_activation_hook(
	__FILE__,
	function () {
		Emzagar_WooCommerce::register_endpoint();
		flush_rewrite_rules();
		Emzagar_Sync::install_table();
		if ( ! Emzagar_Onboarding::is_done() ) {
			set_transient( Emzagar_Onboarding::REDIRECT, 1, 5 * MINUTE_IN_SECONDS ); // انتقال به ویزارد خوش‌آمدگویی
		}
		try {
			Emzagar_Connect::on_activate();
		} catch ( \Throwable $e ) { // phpcs:ignore PHPCompatibility.Keywords.NewKeywords.t_throwableFound
			Emzagar_Connect::schedule_retry( 60 );
		}
	}
);
register_deactivation_hook(
	__FILE__,
	function () {
		Emzagar_Connect::unschedule();
		wp_clear_scheduled_hook( Emzagar_Sync::HOOK_TICK );
		wp_clear_scheduled_hook( Emzagar_Sync::HOOK_FLUSH );
		wp_clear_scheduled_hook( Emzagar_Sync::HOOK_BACKFILL );
		Emzagar_Hub::unschedule();
		wp_clear_scheduled_hook( 'emzagar_daily_maintenance' );
		flush_rewrite_rules();
	}
);

/** لینک «تنظیمات» در فهرست افزونه‌ها */
add_filter(
	'plugin_action_links_' . plugin_basename( __FILE__ ),
	function ( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=emzagar' ) ) . '">' . esc_html__( 'تنظیمات', 'emzagar' ) . '</a>' );
		return $links;
	}
);
