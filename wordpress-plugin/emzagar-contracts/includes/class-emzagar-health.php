<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * «وضعیت سیستم»: بررسی سلامت محلی با چراغ سبز/زرد/قرمز.
 *
 *  • اتصال به ابر (آدرس، کلید، پینگ زنده با زمان پاسخ، دسترسی REST خود سایت)
 *  • Heartbeat روزانه به ابر + WP-Cron + Heartbeat زنده‌ی وردپرس (اعلان‌ها)
 *  • اجرای اتوماسیون‌ها و فرم‌ها (نرخ موفقیت، آخرین اجرا)
 *  • صف همگام‌سازی، محدودیت نرخ و قفل اضطراری، ماژول‌های خاموش‌شده، لایسنس و به‌روزرسانی
 *  • نقطه‌ی پایش بیرونی (UptimeRobot و …):  GET /wp-json/emzagar/v1/health?token=…
 *
 * بررسی‌های سبک هنگام باز شدن صفحه اجرا می‌شوند؛ بررسی‌های شبکه‌ای (پینگ ابر، REST) با AJAX و به‌صورت زنده.
 */
class Emzagar_Health {

	const PAGE      = 'emzagar-health';
	const OPT_TOKEN = 'emzagar_health_token';

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		if ( is_admin() ) {
			add_action( 'admin_menu', array( __CLASS__, 'menu' ), 14 );
			add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
			add_action( 'wp_ajax_emzagar_health_live', array( __CLASS__, 'ajax_live' ) );
			add_action( 'wp_ajax_emzagar_health_beat', array( __CLASS__, 'ajax_beat' ) );
			add_action( 'admin_post_emzagar_health_token', array( __CLASS__, 'act_token' ) );
		}
	}

	public static function url() {
		return admin_url( 'admin.php?page=' . self::PAGE );
	}

	public static function menu() {
		// نشان قرمز تعداد مشکل‌ها؛ برای سبک ماندن همه‌ی صفحات پیشخوان، ۲ دقیقه کش می‌شود
		$bad = get_transient( 'emz_health_bad' );
		if ( false === $bad ) {
			$r   = self::report( false );
			$bad = (int) $r['counts']['bad'];
			set_transient( 'emz_health_bad', $bad, 2 * MINUTE_IN_SECONDS );
		}
		$bubble = (int) $bad > 0 ? ' <span class="awaiting-mod">' . (int) $bad . '</span>' : '';
		add_submenu_page( 'emzagar', __( 'وضعیت سیستم', 'emzagar' ), __( 'وضعیت سیستم', 'emzagar' ) . $bubble, 'manage_options', self::PAGE, array( __CLASS__, 'render' ), 20 );
	}

	public static function assets( $hook ) {
		if ( false === strpos( (string) $hook, self::PAGE ) ) {
			return;
		}
		wp_enqueue_style( 'emzagar-control', EMZ_URL . 'assets/css/control.css', array(), EMZ_VERSION );
		wp_enqueue_script( 'emzagar-health', EMZ_URL . 'assets/js/health.js', array(), EMZ_VERSION, true );
		wp_localize_script(
			'emzagar-health',
			'EmzagarHealth',
			array(
				'ajax'  => admin_url( 'admin-ajax.php' ),
				'nonce' => wp_create_nonce( 'emzagar_health' ),
				'i18n'  => array(
					'checking' => __( 'در حال بررسی…', 'emzagar' ),
					'failed'   => __( 'خطا در ارتباط با سرور وردپرس.', 'emzagar' ),
					'sent'     => __( 'ضربان ارسال شد ✓', 'emzagar' ),
				),
			)
		);
	}

	/* ───────────── جمع‌آوری ───────────── */

	private static function c( $id, $group, $label, $status, $detail = '', $link = '' ) {
		return array(
			'id'     => $id,
			'group'  => $group,
			'label'  => $label,
			'status' => $status, // ok | warn | bad | off | pending
			'detail' => $detail,
			'link'   => $link,
		);
	}

	public static function groups() {
		return array(
			'cloud'  => array( __( 'اتصال به ابر', 'emzagar' ), '☁️' ),
			'beat'   => array( __( 'Heartbeat و زمان‌بندی', 'emzagar' ), '💓' ),
			'auto'   => array( __( 'اتوماسیون‌ها و فرم‌ها', 'emzagar' ), '⚡' ),
			'safety' => array( __( 'ایمنی و محدودیت', 'emzagar' ), '🛡️' ),
			'system' => array( __( 'سیستم و نسخه', 'emzagar' ), '🖥️' ),
		);
	}

	/**
	 * گزارش کامل. اگر $live درست باشد، بررسی‌های شبکه‌ای (پینگ ابر و REST) هم انجام می‌شود.
	 *
	 * @param bool $live اجرای بررسی‌های شبکه‌ای
	 * @return array{overall:string,counts:array,checks:array,at:int}
	 */
	public static function report( $live = false ) {
		$checks = array();
		$g      = self::groups();
		$o      = emzagar_options();
		$conn   = Emzagar_API::is_configured();
		$cloud  = Emzagar_Connect::cloud_url();

		/* ── ابر ── */
		$has_url = '' !== $cloud || ! empty( $o['base_url'] );
		$checks[] = self::c( 'cloud_url', 'cloud', __( 'آدرس ابر تنظیم شده', 'emzagar' ), $has_url ? 'ok' : 'bad', $has_url ? ( '' !== $cloud ? $cloud : $o['base_url'] ) : __( 'این نسخه آدرس سرویس ندارد؛ افزونه را از پنل امضاگیر دانلود کنید.', 'emzagar' ) );
		$err = Emzagar_Connect::last_error();
		$checks[] = self::c( 'connected', 'cloud', __( 'اتصال و کلید API', 'emzagar' ), $conn ? 'ok' : 'bad', $conn ? ( ! empty( $o['workspace'] ) ? sprintf( /* translators: %s: workspace */ __( 'فضای کاری: %s', 'emzagar' ), $o['workspace'] ) : __( 'متصل', 'emzagar' ) ) : ( '' !== $err ? $err : __( 'متصل نیست؛ افزونه در پس‌زمینه تلاش می‌کند.', 'emzagar' ) ), admin_url( 'admin.php?page=emzagar' ) );
		$checks[] = self::c( 'https', 'cloud', __( 'HTTPS سایت', 'emzagar' ), is_ssl() || 0 === strpos( home_url(), 'https://' ) ? 'ok' : 'warn', is_ssl() || 0 === strpos( home_url(), 'https://' ) ? __( 'ارتباط رمزنگاری‌شده است.', 'emzagar' ) : __( 'سایت با HTTP کار می‌کند؛ برای امنیت و تایید دامنه HTTPS را فعال کنید.', 'emzagar' ) );
		if ( $live ) {
			$ping     = self::ping();
			$checks[] = self::c( 'ping', 'cloud', __( 'پاسخ‌گویی ابر (پینگ زنده)', 'emzagar' ), $ping['status'], $ping['detail'] );
			$rest     = self::rest_loopback();
			$checks[] = self::c( 'rest', 'cloud', __( 'دسترسی ابر به وردپرس (REST)', 'emzagar' ), $rest['status'], $rest['detail'] );
		} else {
			$checks[] = self::c( 'ping', 'cloud', __( 'پاسخ‌گویی ابر (پینگ زنده)', 'emzagar' ), 'pending', __( 'در حال بررسی…', 'emzagar' ) );
			$checks[] = self::c( 'rest', 'cloud', __( 'دسترسی ابر به وردپرس (REST)', 'emzagar' ), 'pending', __( 'در حال بررسی…', 'emzagar' ) );
		}

		/* ── Heartbeat و کرون ── */
		$beat = Emzagar_Connect::last_beat();
		if ( ! $conn ) {
			$checks[] = self::c( 'beat', 'beat', __( 'Heartbeat روزانه به ابر', 'emzagar' ), 'off', __( 'پس از اتصال شروع می‌شود.', 'emzagar' ) );
		} elseif ( empty( $beat['ts'] ) ) {
			$checks[] = self::c( 'beat', 'beat', __( 'Heartbeat روزانه به ابر', 'emzagar' ), 'warn', __( 'هنوز ارسال نشده؛ تا ۲۴ ساعت اول طبیعی است. می‌توانید «ارسال ضربان» را بزنید.', 'emzagar' ) );
		} else {
			$age = time() - (int) $beat['ts'];
			if ( empty( $beat['ok'] ) ) {
				$checks[] = self::c( 'beat', 'beat', __( 'Heartbeat روزانه به ابر', 'emzagar' ), 'bad', sprintf( /* translators: 1: time 2: error */ __( 'آخرین تلاش (%1$s پیش) ناموفق بود: %2$s', 'emzagar' ), human_time_diff( (int) $beat['ts'] ), (string) $beat['error'] ) );
			} elseif ( $age > 36 * HOUR_IN_SECONDS ) {
				$checks[] = self::c( 'beat', 'beat', __( 'Heartbeat روزانه به ابر', 'emzagar' ), 'bad', sprintf( /* translators: %s: time */ __( 'آخرین ضربان %s پیش بود (باید هر ۲۴ ساعت باشد). WP-Cron را بررسی کنید.', 'emzagar' ), human_time_diff( (int) $beat['ts'] ) ) );
			} else {
				$checks[] = self::c( 'beat', 'beat', __( 'Heartbeat روزانه به ابر', 'emzagar' ), 'ok', sprintf( /* translators: %s: time */ __( 'آخرین ضربان موفق: %s پیش', 'emzagar' ), human_time_diff( (int) $beat['ts'] ) ) );
			}
		}

		$next = wp_next_scheduled( Emzagar_Connect::HOOK_BEAT );
		$cron_off = defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON;
		if ( $next && $next < time() - 2 * HOUR_IN_SECONDS ) {
			$checks[] = self::c( 'cron', 'beat', __( 'WP-Cron (زمان‌بند وردپرس)', 'emzagar' ), 'bad', __( 'کارهای زمان‌بندی‌شده عقب افتاده‌اند؛ کرون اجرا نمی‌شود. (راهنما: cron سیستمی یا بازدید سایت)', 'emzagar' ) );
		} elseif ( $cron_off ) {
			$checks[] = self::c( 'cron', 'beat', __( 'WP-Cron (زمان‌بند وردپرس)', 'emzagar' ), 'warn', __( 'DISABLE_WP_CRON فعال است؛ مطمئن شوید cron سیستمی هر ۵ دقیقه wp-cron.php را اجرا می‌کند.', 'emzagar' ) );
		} else {
			$checks[] = self::c( 'cron', 'beat', __( 'WP-Cron (زمان‌بند وردپرس)', 'emzagar' ), $next ? 'ok' : 'warn', $next ? sprintf( /* translators: %s: time */ __( 'ضربان بعدی: %s دیگر', 'emzagar' ), human_time_diff( $next ) ) : __( 'ضربان زمان‌بندی نشده؛ با باز کردن پیشخوان خودکار ساخته می‌شود.', 'emzagar' ) );
		}

		if ( Emzagar_Modules::on( 'sync' ) ) {
			$sy = Emzagar_Sync::summary();
			if ( $conn && '' !== $sy['lastError'] ) {
				$checks[] = self::c( 'sync', 'beat', __( 'همگام‌سازی با ابر', 'emzagar' ), 'warn', $sy['lastError'] );
			} elseif ( $conn && (int) $sy['queue'] > 100 ) {
				$checks[] = self::c( 'sync', 'beat', __( 'همگام‌سازی با ابر', 'emzagar' ), 'warn', sprintf( /* translators: %d: count */ __( '%d مورد در صف ارسال مانده است.', 'emzagar' ), (int) $sy['queue'] ) );
			} else {
				$checks[] = self::c( 'sync', 'beat', __( 'همگام‌سازی با ابر', 'emzagar' ), $conn ? 'ok' : 'off', $conn ? sprintf( /* translators: 1: queue 2: sent 3: received */ __( 'صف: %1$d · ارسال‌شده: %2$d · دریافتی: %3$d', 'emzagar' ), (int) $sy['queue'], (int) $sy['sent'], (int) $sy['received'] ) : '' );
			}
		} else {
			$checks[] = self::c( 'sync', 'beat', __( 'همگام‌سازی با ابر', 'emzagar' ), 'off', __( 'ماژول خاموش است؛ رویدادهای امضا دریافت نمی‌شود.', 'emzagar' ), Emzagar_Settings::tab_url( 'modules' ) );
		}

		$live_on = Emzagar_Modules::on( 'inbox' ) && 'yes' === Emzagar_Hub::opts()['live'];
		$checks[] = self::c( 'wp_heartbeat', 'beat', __( 'Heartbeat زنده‌ی وردپرس (اعلان امضا)', 'emzagar' ), $live_on ? 'ok' : 'off', $live_on ? __( 'اعلان لحظه‌ای فعال است.', 'emzagar' ) : __( 'اعلان زنده خاموش است.', 'emzagar' ) );

		/* ── اتوماسیون و فرم ── */
		if ( Emzagar_Modules::on( 'automations' ) ) {
			$active = Emzagar_Automations::active_count();
			$log    = array_values(
				array_filter(
					Emzagar_Automations::log_items(),
					function ( $e ) {
						return 'test' !== ( isset( $e['kind'] ) ? $e['kind'] : '' );
					}
				)
			);
			$recent = array_slice( $log, 0, 20 );
			$fail   = 0;
			foreach ( $recent as $e ) {
				if ( empty( $e['ok'] ) ) {
					++$fail;
				}
			}
			$last5_bad = count( $recent ) >= 3 && 0 === count( array_filter( array_slice( $recent, 0, 5 ), function ( $e ) { return ! empty( $e['ok'] ); } ) ); // phpcs:ignore Generic.Formatting.MultipleStatementAlignment
			if ( 0 === $active ) {
				$checks[] = self::c( 'automations', 'auto', __( 'اجرای اتوماسیون‌ها', 'emzagar' ), 'warn', __( 'هیچ قانون فعالی نیست. از «دستورهای آماده» شروع کنید.', 'emzagar' ), Emzagar_Automations::url() );
			} elseif ( $last5_bad ) {
				$checks[] = self::c( 'automations', 'auto', __( 'اجرای اتوماسیون‌ها', 'emzagar' ), 'bad', __( 'چند اجرای اخیر پشت‌سرهم ناموفق بوده‌اند؛ «گزارش اجرا» را ببینید.', 'emzagar' ), Emzagar_Automations::url( array( 'tab' => 'log' ) ) );
			} elseif ( $fail > 0 ) {
				$checks[] = self::c( 'automations', 'auto', __( 'اجرای اتوماسیون‌ها', 'emzagar' ), 'warn', sprintf( /* translators: 1: active 2: fail 3: total */ __( '%1$d قانون فعال · %2$d خطا از %3$d اجرای اخیر', 'emzagar' ), $active, $fail, count( $recent ) ), Emzagar_Automations::url( array( 'tab' => 'log' ) ) );
			} else {
				$checks[] = self::c( 'automations', 'auto', __( 'اجرای اتوماسیون‌ها', 'emzagar' ), 'ok', sprintf( /* translators: 1: active 2: runs */ __( '%1$d قانون فعال · %2$d اجرای موفق در ۳۰ روز', 'emzagar' ), $active, Emzagar_Automations::runs30() ) );
			}
			$checks[] = self::c( 'last_run', 'auto', __( 'آخرین اجرای اتوماسیون', 'emzagar' ), empty( $log ) ? 'off' : 'ok', empty( $log ) ? __( 'هنوز اجرایی ثبت نشده.', 'emzagar' ) : sprintf( /* translators: %s: time */ __( '%s پیش', 'emzagar' ), human_time_diff( (int) $log[0]['ts'] ) ) );
		} else {
			$checks[] = self::c( 'automations', 'auto', __( 'اجرای اتوماسیون‌ها', 'emzagar' ), 'off', __( 'ماژول اتوماسیون خاموش است.', 'emzagar' ), Emzagar_Settings::tab_url( 'modules' ) );
		}

		if ( Emzagar_Modules::on( 'forms' ) ) {
			$rules = Emzagar_Forms::rules();
			$miss  = array();
			foreach ( $rules as $r ) {
				if ( ! empty( $r['on'] ) && ! Emzagar_Forms::installed( $r['provider'] ) ) {
					$miss[ $r['provider'] ] = Emzagar_Forms::providers()[ $r['provider'] ];
				}
			}
			if ( $miss ) {
				$checks[] = self::c( 'forms', 'auto', __( 'اتصال فرم‌ها', 'emzagar' ), 'warn', sprintf( /* translators: %s: names */ __( 'فرم‌ساز نصب نیست: %s', 'emzagar' ), implode( '، ', $miss ) ), Emzagar_Automations::url( array( 'tab' => 'forms' ) ) );
			} else {
				$checks[] = self::c( 'forms', 'auto', __( 'اتصال فرم‌ها', 'emzagar' ), empty( $rules ) ? 'off' : 'ok', empty( $rules ) ? __( 'هنوز فرمی وصل نشده است.', 'emzagar' ) : sprintf( /* translators: %d: count */ __( '%d اتصال فعال', 'emzagar' ), Emzagar_Forms::active_count() ) );
			}
		} else {
			$checks[] = self::c( 'forms', 'auto', __( 'اتصال فرم‌ها', 'emzagar' ), 'off', __( 'ماژول فرم‌ها خاموش است.', 'emzagar' ), Emzagar_Settings::tab_url( 'modules' ) );
		}

		/* ── ایمنی ── */
		$st = Emzagar_Limits::stats();
		if ( $st['locked'] ) {
			$checks[] = self::c( 'lockdown', 'safety', __( 'قفل اضطراری', 'emzagar' ), 'bad', __( 'فعال است؛ صدور از فرم‌ها متوقف است.', 'emzagar' ) . ( '' !== $st['lockReason'] ? ' (' . $st['lockReason'] . ')' : '' ), Emzagar_Settings::tab_url( 'limits' ) );
		} else {
			$checks[] = self::c( 'lockdown', 'safety', __( 'قفل اضطراری', 'emzagar' ), 'ok', __( 'خاموش (حالت عادی)', 'emzagar' ) );
		}
		if ( $st['dailyCap'] > 0 && $st['issuedToday'] >= $st['dailyCap'] ) {
			$checks[] = self::c( 'cap', 'safety', __( 'سقف روزانه‌ی صدور از فرم', 'emzagar' ), 'bad', sprintf( /* translators: 1: used 2: cap */ __( 'پر شده: %1$d از %2$d', 'emzagar' ), $st['issuedToday'], $st['dailyCap'] ), Emzagar_Settings::tab_url( 'limits' ) );
		} elseif ( $st['dailyCap'] > 0 && $st['issuedToday'] >= 0.8 * $st['dailyCap'] ) {
			$checks[] = self::c( 'cap', 'safety', __( 'سقف روزانه‌ی صدور از فرم', 'emzagar' ), 'warn', sprintf( /* translators: 1: used 2: cap */ __( 'نزدیک سقف: %1$d از %2$d', 'emzagar' ), $st['issuedToday'], $st['dailyCap'] ), Emzagar_Settings::tab_url( 'limits' ) );
		} else {
			$checks[] = self::c( 'cap', 'safety', __( 'سقف روزانه‌ی صدور از فرم', 'emzagar' ), 'ok', sprintf( /* translators: 1: used 2: cap 3: blocked */ __( 'امروز %1$d از %2$s · مسدودشده: %3$d', 'emzagar' ), $st['issuedToday'], $st['dailyCap'] > 0 ? (string) $st['dailyCap'] : '∞', $st['blockedToday'] ) );
		}

		$off = array();
		$bad = array();
		$reg = Emzagar_Modules::registry();
		foreach ( $reg as $id => $m ) {
			$s = Emzagar_Modules::state( $id );
			if ( 'auto' === $s ) {
				$bad[] = $m['label'];
			} elseif ( in_array( $s, array( 'off', 'locked' ), true ) ) {
				$off[] = $m['label'];
			}
		}
		if ( $bad ) {
			$checks[] = self::c( 'modules', 'safety', __( 'ماژول‌ها', 'emzagar' ), 'bad', sprintf( /* translators: %s: names */ __( 'خاموش خودکار به‌خاطر خطا: %s', 'emzagar' ), implode( '، ', $bad ) ), Emzagar_Settings::tab_url( 'modules' ) );
		} elseif ( $off ) {
			$checks[] = self::c( 'modules', 'safety', __( 'ماژول‌ها', 'emzagar' ), 'warn', sprintf( /* translators: %s: names */ __( 'خاموش: %s', 'emzagar' ), implode( '، ', $off ) ), Emzagar_Settings::tab_url( 'modules' ) );
		} else {
			$checks[] = self::c( 'modules', 'safety', __( 'ماژول‌ها', 'emzagar' ), 'ok', sprintf( /* translators: %d: count */ __( 'همه‌ی %d ماژول فعال‌اند.', 'emzagar' ), count( $reg ) ) );
		}

		/* ── سیستم ── */
		$checks[] = self::c( 'php', 'system', __( 'نسخه‌ی PHP', 'emzagar' ), version_compare( PHP_VERSION, '7.4', '>=' ) ? ( version_compare( PHP_VERSION, '8.0', '>=' ) ? 'ok' : 'warn' ) : 'bad', PHP_VERSION . ( version_compare( PHP_VERSION, '8.0', '<' ) ? ' — ' . __( 'پیشنهاد: PHP 8.1 یا بالاتر', 'emzagar' ) : '' ) );
		$mem   = wp_convert_hr_to_bytes( ini_get( 'memory_limit' ) );
		$checks[] = self::c( 'memory', 'system', __( 'حافظه‌ی PHP', 'emzagar' ), ( -1 === $mem || $mem >= 128 * MB_IN_BYTES ) ? 'ok' : 'warn', (string) ini_get( 'memory_limit' ) );
		$wc_needed = Emzagar_Modules::on( 'woocommerce' );
		$checks[]  = self::c( 'wc', 'system', __( 'ووکامرس', 'emzagar' ), class_exists( 'WooCommerce' ) ? 'ok' : ( $wc_needed ? 'off' : 'off' ), class_exists( 'WooCommerce' ) ? 'v' . ( defined( 'WC_VERSION' ) ? WC_VERSION : '' ) : __( 'نصب/فعال نیست (اختیاری).', 'emzagar' ) );

		$info = Emzagar_Updater::cached();
		$lic  = isset( $info['license'] ) && is_array( $info['license'] ) ? $info['license'] : array();
		if ( ! $conn ) {
			$checks[] = self::c( 'license', 'system', __( 'لایسنس ابر', 'emzagar' ), 'off', __( 'پس از اتصال نمایش داده می‌شود.', 'emzagar' ) );
		} elseif ( empty( $lic ) ) {
			$checks[] = self::c( 'license', 'system', __( 'لایسنس ابر', 'emzagar' ), 'off', __( 'هنوز اطلاعاتی از ابر نرسیده است.', 'emzagar' ), Emzagar_Settings::tab_url( 'license' ) );
		} else {
			$ls = isset( $lic['state'] ) ? (string) $lic['state'] : '';
			$checks[] = self::c( 'license', 'system', __( 'لایسنس ابر', 'emzagar' ), 'active' === $ls ? 'ok' : ( in_array( $ls, array( 'unlicensed', '' ), true ) ? 'warn' : 'bad' ), Emzagar_Updater::license_label( $lic ), Emzagar_Settings::tab_url( 'license' ) );
		}
		$upd = Emzagar_Updater::available( $info );
		$checks[] = self::c( 'update', 'system', __( 'به‌روزرسانی افزونه', 'emzagar' ), $upd ? 'warn' : 'ok', $upd ? sprintf( /* translators: 1: new 2: current */ __( 'نسخه‌ی %1$s آماده است (نصب‌شده: %2$s).', 'emzagar' ), $upd, EMZ_VERSION ) : sprintf( /* translators: %s: version */ __( 'آخرین نسخه نصب است (%s).', 'emzagar' ), EMZ_VERSION ), Emzagar_Settings::tab_url( 'license' ) );

		return self::finish( $checks );
	}

	private static function finish( $checks ) {
		$counts = array( 'ok' => 0, 'warn' => 0, 'bad' => 0, 'off' => 0, 'pending' => 0 );
		foreach ( $checks as $c ) {
			if ( isset( $counts[ $c['status'] ] ) ) {
				++$counts[ $c['status'] ];
			}
		}
		$overall = $counts['bad'] > 0 ? 'bad' : ( $counts['warn'] > 0 ? 'warn' : 'ok' );
		return array(
			'overall' => $overall,
			'counts'  => $counts,
			'checks'  => $checks,
			'at'      => time(),
		);
	}

	/* ───────────── بررسی‌های شبکه‌ای ───────────── */

	/** @return array{status:string,detail:string,ms:int} */
	public static function ping() {
		if ( ! Emzagar_API::is_configured() ) {
			return array( 'status' => 'bad', 'detail' => __( 'متصل نیست.', 'emzagar' ), 'ms' => 0 );
		}
		$t   = microtime( true );
		$res = Emzagar_API::request( 'GET', '/api/v1/stats' );
		$ms  = (int) round( ( microtime( true ) - $t ) * 1000 );
		if ( is_wp_error( $res ) ) {
			return array( 'status' => 'bad', 'detail' => $res->get_error_message(), 'ms' => $ms );
		}
		$status = $ms > 4000 ? 'warn' : 'ok';
		return array(
			'status' => $status,
			/* translators: %d: milliseconds */
			'detail' => sprintf( __( 'پاسخ در %d میلی‌ثانیه', 'emzagar' ), $ms ) . ( 'warn' === $status ? ' — ' . __( 'کند است', 'emzagar' ) : '' ),
			'ms'     => $ms,
		);
	}

	/** مسیر REST خود سایت (که ابر برای دست‌دادن و رویدادها صدا می‌زند) از بیرون/حلقه‌ی محلی در دسترس است؟ */
	public static function rest_loopback() {
		$url = rest_url( 'emzagar/v1/verify' );
		$res = wp_remote_get( add_query_arg( 'handshake', 'healthcheck', $url ), array( 'timeout' => 8, 'redirection' => 2, 'sslverify' => apply_filters( 'https_local_ssl_verify', false ) ) );
		if ( is_wp_error( $res ) ) {
			return array( 'status' => 'warn', 'detail' => sprintf( /* translators: %s: error */ __( 'درخواست محلی ناموفق: %s', 'emzagar' ), $res->get_error_message() ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 404 === $code && is_array( $body ) && isset( $body['code'] ) && 'emzagar_not_found' === $body['code'] ) {
			return array( 'status' => 'ok', 'detail' => __( 'مسیر REST افزونه فعال و در دسترس است.', 'emzagar' ) );
		}
		if ( in_array( $code, array( 401, 403 ), true ) ) {
			return array( 'status' => 'warn', 'detail' => sprintf( /* translators: %d: http code */ __( 'REST با کد %d بسته شده (فایروال/افزونه‌ی امنیتی). مسیر /wp-json/emzagar/ را مجاز کنید.', 'emzagar' ), $code ) );
		}
		return array( 'status' => 'warn', 'detail' => sprintf( /* translators: %d: http code */ __( 'پاسخ غیرمنتظره (HTTP %d). پیوندهای یکتا را یک‌بار ذخیره کنید.', 'emzagar' ), $code ) );
	}

	/** ارسال ضربان همین حالا */
	public static function beat_now() {
		Emzagar_Connect::heartbeat();
		return Emzagar_Connect::last_beat();
	}

	/* ───────────── AJAX ───────────── */

	private static function guard() {
		check_ajax_referer( 'emzagar_health', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'دسترسی ندارید.', 'emzagar' ) ), 403 );
		}
	}

	public static function ajax_live() {
		self::guard();
		wp_send_json_success( self::report( true ) );
	}

	public static function ajax_beat() {
		self::guard();
		$b = self::beat_now();
		wp_send_json_success( array( 'ok' => ! empty( $b['ok'] ), 'error' => isset( $b['error'] ) ? (string) $b['error'] : '', 'report' => self::report( true ) ) );
	}

	/* ───────────── پایش بیرونی ───────────── */

	public static function token() {
		$t = get_option( self::OPT_TOKEN, '' );
		if ( ! is_string( $t ) || strlen( $t ) < 24 ) {
			$t = wp_generate_password( 32, false );
			update_option( self::OPT_TOKEN, $t, false );
		}
		return $t;
	}

	public static function act_token() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( 'emzagar_health_token' );
		delete_option( self::OPT_TOKEN );
		self::token();
		wp_safe_redirect( add_query_arg( 'emz_h', 'token', self::url() ) );
		exit;
	}

	public static function monitor_url() {
		return add_query_arg( 'token', self::token(), rest_url( 'emzagar/v1/health' ) );
	}

	public static function register_routes() {
		register_rest_route(
			'emzagar/v1',
			'/health',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true', // با توکن محافظت می‌شود
				'callback'            => array( __CLASS__, 'rest_health' ),
			)
		);
	}

	public static function rest_health( $request ) {
		$given = (string) $request->get_param( 'token' );
		if ( '' === $given || ! hash_equals( self::token(), $given ) ) {
			return new WP_Error( 'emzagar_forbidden', 'Forbidden', array( 'status' => 403 ) );
		}
		$live = '1' === (string) $request->get_param( 'live' );
		$r    = self::report( $live );
		$out  = array();
		foreach ( $r['checks'] as $c ) {
			if ( 'pending' === $c['status'] ) {
				continue;
			}
			$out[] = array( 'id' => $c['id'], 'status' => $c['status'], 'detail' => $c['detail'] );
		}
		$res = rest_ensure_response(
			array(
				'ok'      => 'bad' !== $r['overall'],
				'status'  => $r['overall'],
				'version' => EMZ_VERSION,
				'counts'  => $r['counts'],
				'checks'  => $out,
				'time'    => gmdate( 'c' ),
			)
		);
		$res->set_status( 'bad' === $r['overall'] ? 503 : 200 );
		$res->header( 'Cache-Control', 'no-store' );
		return $res;
	}

	/* ───────────── نمایش ───────────── */

	public static function lamp( $status ) {
		$map = array(
			'ok'      => array( 'is-green', __( 'سالم', 'emzagar' ) ),
			'warn'    => array( 'is-amber', __( 'نیازمند توجه', 'emzagar' ) ),
			'bad'     => array( 'is-red', __( 'مشکل', 'emzagar' ) ),
			'off'     => array( 'is-grey', __( 'غیرفعال', 'emzagar' ) ),
			'pending' => array( 'is-grey is-pulse', __( 'در حال بررسی', 'emzagar' ) ),
		);
		$m   = isset( $map[ $status ] ) ? $map[ $status ] : $map['off'];
		return '<span class="emz-lamp ' . esc_attr( $m[0] ) . '" role="img" aria-label="' . esc_attr( $m[1] ) . '" title="' . esc_attr( $m[1] ) . '"></span>';
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$r      = self::report( false );
		$groups = self::groups();
		$titles = array(
			'ok'   => __( 'همه‌چیز سالم است', 'emzagar' ),
			'warn' => __( 'چند مورد نیاز به توجه دارد', 'emzagar' ),
			'bad'  => __( 'مشکل جدی وجود دارد', 'emzagar' ),
		);
		$code = isset( $_GET['emz_h'] ) ? sanitize_key( wp_unslash( $_GET['emz_h'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		?>
		<div class="wrap emz-ctl" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>" id="emz-health">
			<h1><?php esc_html_e( 'امضاگیر — وضعیت سیستم', 'emzagar' ); ?></h1>
			<?php if ( 'token' === $code ) : ?>
				<div class="notice notice-success is-dismissible"><p><?php esc_html_e( 'توکن پایش بیرونی تازه شد؛ آدرس قبلی دیگر کار نمی‌کند.', 'emzagar' ); ?></p></div>
			<?php endif; ?>

			<div class="emz-banner is-<?php echo esc_attr( $r['overall'] ); ?>" id="emz-banner">
				<?php echo self::lamp( $r['overall'] ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
				<div>
					<h2 id="emz-banner-title"><?php echo esc_html( $titles[ $r['overall'] ] ); ?></h2>
					<p id="emz-banner-sub"><?php echo esc_html( sprintf( /* translators: 1: ok 2: warn 3: bad */ __( '%1$d سالم · %2$d هشدار · %3$d مشکل', 'emzagar' ), $r['counts']['ok'], $r['counts']['warn'], $r['counts']['bad'] ) ); ?></p>
				</div>
				<div class="emz-banner-btn">
					<button type="button" class="button button-primary" id="emz-health-run"><?php esc_html_e( 'اجرای بررسی زنده', 'emzagar' ); ?></button>
					<button type="button" class="button" id="emz-health-beat"><?php esc_html_e( 'ارسال ضربان همین حالا', 'emzagar' ); ?></button>
					<span id="emz-health-msg" role="status" aria-live="polite"></span>
				</div>
			</div>

			<div class="emz-grid">
				<?php foreach ( $groups as $gid => $g ) : ?>
					<section class="emz-card">
						<h2><span aria-hidden="true"><?php echo esc_html( $g[1] ); ?></span> <?php echo esc_html( $g[0] ); ?></h2>
						<ul class="emz-checks">
							<?php foreach ( $r['checks'] as $c ) : ?>
								<?php if ( $c['group'] !== $gid ) { continue; } ?>
								<li data-id="<?php echo esc_attr( $c['id'] ); ?>" class="st-<?php echo esc_attr( $c['status'] ); ?>">
									<?php echo self::lamp( $c['status'] ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
									<div>
										<b><?php echo esc_html( $c['label'] ); ?></b>
										<small data-role="detail"><?php echo esc_html( $c['detail'] ); ?></small>
									</div>
									<?php if ( $c['link'] ) : ?>
										<a class="emz-fix" href="<?php echo esc_url( $c['link'] ); ?>"><?php esc_html_e( 'رفتن', 'emzagar' ); ?> ›</a>
									<?php endif; ?>
								</li>
							<?php endforeach; ?>
						</ul>
					</section>
				<?php endforeach; ?>
			</div>

			<section class="emz-card">
				<h2><?php esc_html_e( 'پایش بیرونی (UptimeRobot، Better Stack، Zabbix …)', 'emzagar' ); ?></h2>
				<p class="description"><?php esc_html_e( 'این آدرس وضعیت را به‌صورت JSON برمی‌گرداند: کد ۲۰۰ = سالم/هشدار و ۵۰۳ = مشکل جدی. با افزودن live=1 پینگ ابر هم بررسی می‌شود. آدرس را محرمانه نگه دارید.', 'emzagar' ); ?></p>
				<p><input type="text" class="large-text code" dir="ltr" readonly onfocus="this.select()" value="<?php echo esc_attr( self::monitor_url() ); ?>"></p>
				<p><a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_health_token' ), 'emzagar_health_token' ) ); ?>"><?php esc_html_e( 'ساخت توکن جدید', 'emzagar' ); ?></a></p>
			</section>
		</div>
		<?php
	}
}
