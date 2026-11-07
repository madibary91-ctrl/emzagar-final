<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * «مرکز فرماندهی کسب‌وکار» داخل وردپرس.
 *
 *  • ویجت پیشخوان + نشان زنده‌ی «قرارداد منتظر امضا» روی نوار مدیریت (در همه‌ی صفحه‌ها)
 *  • صفحه‌ی فرماندهی: شاخص‌ها، صف اقدام (یادآوری با یک کلیک)، ارزش‌آفرینی، عمق یکپارچگی
 *  • گزارش هفتگی کسب‌وکار به ایمیل مدیر
 *  • نشان اعتماد برای سایت ([emzagar_trust] یا خودکار در فوتر)
 *  • سلامت‌سنجی در «سلامت سایت» وردپرس
 */
class Emzagar_Hub {

	const OPT          = 'emzagar_hub';
	const OPT_PULSE    = 'emzagar_hub_pulse';
	const HOOK_REFRESH = 'emzagar_hub_refresh';
	const HOOK_DIGEST  = 'emzagar_hub_digest';
	const PAGE         = 'emzagar-hub';

	public static function init() {
		add_filter( 'cron_schedules', array( __CLASS__, 'cron_schedules' ) ); // phpcs:ignore WordPress.WP.CronInterval.CronSchedulesInterval
		add_action( self::HOOK_REFRESH, array( __CLASS__, 'cron_refresh' ) );
		add_action( self::HOOK_DIGEST, array( __CLASS__, 'send_digest' ) );
		add_action( 'emzagar_contract_event', array( __CLASS__, 'invalidate' ) );
		add_action( 'init', array( __CLASS__, 'schedule' ) );
		add_shortcode( 'emzagar_trust', array( __CLASS__, 'shortcode_trust' ) );
		add_action( 'wp_footer', array( __CLASS__, 'footer_badge' ) );
		add_filter( 'site_status_tests', array( __CLASS__, 'site_health' ) );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 90 );
		add_action( 'wp_head', array( __CLASS__, 'bar_style' ) );
		add_action( 'admin_head', array( __CLASS__, 'bar_style' ) );

		if ( is_admin() ) {
			add_action( 'admin_menu', array( __CLASS__, 'menu' ), 11 );
			add_action( 'admin_init', array( __CLASS__, 'register' ) );
			add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
			add_action( 'wp_dashboard_setup', array( __CLASS__, 'dashboard_widget' ) );
			add_action( 'wp_ajax_emzagar_hub_widget', array( __CLASS__, 'ajax_widget' ) );
			add_action( 'admin_post_emzagar_hub_remind', array( __CLASS__, 'act_remind' ) );
			add_action( 'admin_post_emzagar_hub_remind_all', array( __CLASS__, 'act_remind_all' ) );
			add_action( 'admin_post_emzagar_hub_refresh', array( __CLASS__, 'act_refresh' ) );
			add_action( 'admin_post_emzagar_hub_digest_test', array( __CLASS__, 'act_digest_test' ) );
			add_action( 'update_option_' . self::OPT, array( __CLASS__, 'on_settings_saved' ) );
		}
	}

	/* ───────────── تنظیمات ───────────── */

	public static function defaults() {
		return array(
			'adminbar'     => 'yes',
			'widget'       => 'yes',
			'digest'       => 'yes',
			'digest_email' => '',
			'grant_role'   => '',
			'badge'        => 'no', // no | footer | shortcode
			'live'         => 'yes', // اعلان زنده (Heartbeat) و زنگ فعالیت
			'palette'      => 'yes', // پالت فرمان Ctrl+K
		);
	}

	public static function opts() {
		$saved = get_option( self::OPT, array() );
		return wp_parse_args( is_array( $saved ) ? $saved : array(), self::defaults() );
	}

	public static function register() {
		register_setting(
			'emzagar_hub_group',
			self::OPT,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
			)
		);
	}

	public static function sanitize( $in ) {
		$in    = is_array( $in ) ? $in : array();
		$yn    = function ( $k ) use ( $in ) {
			return ( isset( $in[ $k ] ) && 'yes' === $in[ $k ] ) ? 'yes' : 'no';
		};
		$role  = isset( $in['grant_role'] ) ? sanitize_key( $in['grant_role'] ) : '';
		$role  = ( '' !== $role && 'administrator' !== $role && get_role( $role ) ) ? $role : '';
		$badge = isset( $in['badge'] ) ? sanitize_key( $in['badge'] ) : 'no';
		$mail  = isset( $in['digest_email'] ) ? sanitize_email( $in['digest_email'] ) : '';
		return array(
			'adminbar'     => $yn( 'adminbar' ),
			'widget'       => $yn( 'widget' ),
			'digest'       => $yn( 'digest' ),
			'digest_email' => is_email( $mail ) ? $mail : '',
			'grant_role'   => $role,
			'badge'        => in_array( $badge, array( 'footer', 'shortcode' ), true ) ? $badge : 'no',
			'live'         => $yn( 'live' ),
			'palette'      => $yn( 'palette' ),
		);
	}

	public static function on_settings_saved() {
		wp_clear_scheduled_hook( self::HOOK_DIGEST );
		self::schedule();
		self::invalidate();
		wp_schedule_single_event( time() + 3, self::HOOK_REFRESH ); // میزان ادغام جدید را به ابر گزارش می‌دهد
	}

	/* ───────────── زمان‌بندی ───────────── */

	public static function cron_schedules( $s ) {
		if ( ! isset( $s['emz_weekly'] ) ) {
			$s['emz_weekly'] = array(
				'interval' => WEEK_IN_SECONDS,
				'display'  => __( 'هفتگی (امضاگیر)', 'emzagar' ),
			);
		}
		return $s;
	}

	public static function schedule() {
		if ( ! Emzagar_API::is_configured() ) {
			return;
		}
		if ( ! wp_next_scheduled( self::HOOK_REFRESH ) ) {
			wp_schedule_event( time() + 120, 'hourly', self::HOOK_REFRESH );
		}
		$h = self::opts();
		if ( 'yes' === $h['digest'] && ! wp_next_scheduled( self::HOOK_DIGEST ) ) {
			// یکشنبه‌ی بعدی ساعت ۸ صبح به وقت سایت (شنبه برای ایران روز کاری است؛ گزارش پایان هفته برای شروع هفته)
			$next = strtotime( 'next sunday 08:00', current_time( 'timestamp' ) ); // phpcs:ignore WordPress.DateTime.CurrentTimeTimestamp.Requested
			$ts   = $next ? $next - (int) ( get_option( 'gmt_offset' ) * HOUR_IN_SECONDS ) : time() + DAY_IN_SECONDS;
			wp_schedule_event( max( time() + 300, $ts ), 'emz_weekly', self::HOOK_DIGEST );
		}
		if ( 'no' === $h['digest'] && wp_next_scheduled( self::HOOK_DIGEST ) ) {
			wp_clear_scheduled_hook( self::HOOK_DIGEST );
		}
	}

	public static function unschedule() {
		wp_clear_scheduled_hook( self::HOOK_REFRESH );
		wp_clear_scheduled_hook( self::HOOK_DIGEST );
	}

	/* ───────────── نبض ───────────── */

	/** میزان ادغام این سایت (به ابر گزارش می‌شود تا «عمق یکپارچگی» محاسبه شود) */
	public static function features() {
		global $wpdb;
		$o  = emzagar_options();
		$h  = self::opts();
		$st = Emzagar_Access::stats();
		$g  = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = %s AND meta_value <> ''", Emzagar_Access::META_GATE ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$p  = (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_emzagar_template_id' AND meta_value <> '' AND meta_value <> '0'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$wc = class_exists( 'WooCommerce' );
		return array(
			'gates'            => $g,
			'productContracts' => $p,
			'orderAutomation'  => $wc && ( 'yes' === $o['wc_hold_until_signed'] || 'none' !== $o['wc_on_signed'] || 'none' !== $o['wc_on_reject'] || 'yes' === $o['wc_gate_downloads'] ),
			'roles'            => '' !== $h['grant_role'],
			'badge'            => 'no' !== $h['badge'],
			'digest'           => 'yes' === $h['digest'],
			'adminBar'         => 'yes' === $h['adminbar'],
			'widget'           => 'yes' === $h['widget'],
			'portal'           => $wc || (int) $o['page_id'] > 0,
			'syncOrders'       => 'yes' === $o['sync_orders'],
			'wcActive'         => $wc,
			'gateChecks'       => $st['checks'],
			'gateAllowed'      => $st['allowed'],
			'automations'      => Emzagar_Modules::on( 'automations' ) ? Emzagar_Automations::active_count() : 0,
			'automationRuns'   => Emzagar_Automations::runs30(),
			'forms'            => Emzagar_Modules::on( 'forms' ) ? Emzagar_Forms::active_count() : 0,
			'workspaceUsed'    => (bool) get_option( 'emzagar_ws_used', 0 ),
			'live'             => 'yes' === $h['live'] || 'yes' === $h['palette'],
			'actions'          => (int) get_option( 'emzagar_actions', 0 ),
		);
	}

	public static function cached() {
		$c = get_option( self::OPT_PULSE );
		return ( is_array( $c ) && isset( $c['data'] ) && is_array( $c['data'] ) ) ? $c : null;
	}

	/** رویداد جدید رسید یا تنظیمات عوض شد → نبض کهنه می‌شود (داده‌ی قبلی تا رسیدن داده‌ی تازه نگه داشته می‌شود) */
	public static function invalidate() {
		$c = self::cached();
		if ( $c ) {
			$c['at'] = 0;
			update_option( self::OPT_PULSE, $c, false );
		}
	}

	/** @return array|WP_Error */
	public static function pulse( $max_age = 300 ) {
		if ( ! Emzagar_API::is_configured() ) {
			return new WP_Error( 'emzagar_not_configured', __( 'امضاگیر هنوز متصل نشده است.', 'emzagar' ) );
		}
		$c = self::cached();
		if ( $c && ( time() - (int) $c['at'] ) < $max_age ) {
			return $c['data'];
		}
		$res = Emzagar_API::request( 'POST', '/api/v1/hub/pulse', array(), array( 'features' => self::features() ) );
		if ( is_wp_error( $res ) ) {
			return $c ? $c['data'] : $res;
		}
		update_option( self::OPT_PULSE, array( 'at' => time(), 'data' => $res ), false );
		return $res;
	}

	public static function cron_refresh() {
		self::pulse( 0 );
	}

	public static function customer_card( $email ) {
		$email = strtolower( trim( (string) $email ) );
		$key   = 'emz_cust_' . md5( $email );
		$hit   = get_transient( $key );
		if ( false !== $hit ) {
			return $hit;
		}
		$res = Emzagar_API::request( 'GET', '/api/v1/hub/customer', array( 'email' => $email ) );
		if ( ! is_wp_error( $res ) ) {
			set_transient( $key, $res, 5 * MINUTE_IN_SECONDS );
		}
		return $res;
	}

	/* ───────────── قالب‌بندی ───────────── */

	private static function n( $v ) {
		return number_format_i18n( (float) $v );
	}

	private static function money( $v ) {
		return self::n( $v ) . ' ' . __( 'تومان', 'emzagar' );
	}

	private static function kind_label( $k ) {
		$m = array(
			'stale'    => __( 'بی‌پاسخ', 'emzagar' ),
			'expiring' => __( 'در آستانه‌ی انقضا', 'emzagar' ),
			'renewal'  => __( 'تمدید', 'emzagar' ),
			'rejected' => __( 'ردشده', 'emzagar' ),
		);
		return isset( $m[ $k ] ) ? $m[ $k ] : $k;
	}

	private static function pending_count() {
		$c = self::cached();
		return $c && isset( $c['data']['kpi']['pending'] ) ? (int) $c['data']['kpi']['pending'] : 0;
	}

	private static function attention_count() {
		$c = self::cached();
		return $c && isset( $c['data']['kpi']['attention'] ) ? (int) $c['data']['kpi']['attention'] : 0;
	}

	public static function hub_url() {
		return admin_url( 'admin.php?page=' . self::PAGE );
	}

	/* ───────────── نوار مدیریت ───────────── */

	public static function bar_style() {
		if ( ! is_admin_bar_showing() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		echo '<style>#wp-admin-bar-emzagar-hub .emz-pill{display:inline-block;min-width:18px;padding:0 6px;margin-inline-start:6px;border-radius:99px;background:#d97706;color:#fff;font-size:11px;line-height:18px;text-align:center}#wp-admin-bar-emzagar-hub .emz-pill.is-zero{background:#16a34a}</style>';
	}

	public static function admin_bar( $bar ) {
		$h = self::opts();
		if ( 'yes' !== $h['adminbar'] || ! current_user_can( 'manage_options' ) || ! Emzagar_API::is_configured() ) {
			return;
		}
		$c = self::cached();
		if ( ! $c || ( time() - (int) $c['at'] ) > 900 ) {
			if ( ! get_transient( 'emz_hub_refresh_lock' ) ) {
				set_transient( 'emz_hub_refresh_lock', 1, 5 * MINUTE_IN_SECONDS );
				wp_schedule_single_event( time() + 5, self::HOOK_REFRESH );
			}
		}
		$pending = self::pending_count();
		$att     = self::attention_count();
		$pill    = '<span class="emz-pill' . ( 0 === $pending ? ' is-zero' : '' ) . '">' . esc_html( self::n( $pending ) ) . '</span>';
		$bar->add_node(
			array(
				'id'    => 'emzagar-hub',
				'title' => '<span class="ab-icon dashicons dashicons-edit-page" style="margin-top:2px"></span><span class="ab-label">' . esc_html__( 'امضاگیر', 'emzagar' ) . '</span>' . $pill,
				'href'  => self::hub_url(),
				'meta'  => array( 'title' => esc_attr__( 'قراردادهای منتظر امضا', 'emzagar' ) ),
			)
		);
		$items = array(
			array( 'emzagar-hub-open', $att ? sprintf( /* translators: %s: count */ __( 'نیازمند اقدام: %s', 'emzagar' ), self::n( $att ) ) : __( 'مرکز فرماندهی', 'emzagar' ), self::hub_url() ),
			array( 'emzagar-hub-ws', __( 'میز کار قراردادها', 'emzagar' ), Emzagar_Workspace::url() ),
			array( 'emzagar-hub-new', __( 'صدور قرارداد جدید', 'emzagar' ), Emzagar_Workspace::url( array( 'tab' => 'new' ) ) ),
			array( 'emzagar-hub-auto', __( 'اتوماسیون‌ها', 'emzagar' ), Emzagar_Automations::url() ),
			array( 'emzagar-hub-panel', __( 'باز کردن پنل امضاگیر', 'emzagar' ), Emzagar_Connect::panel_link( 'admin' ) ),
		);
		foreach ( $items as $it ) {
			$bar->add_node(
				array(
					'parent' => 'emzagar-hub',
					'id'     => $it[0],
					'title'  => esc_html( $it[1] ),
					'href'   => $it[2],
				)
			);
		}
	}

	/* ───────────── منو و دارایی‌ها ───────────── */

	public static function menu() {
		add_submenu_page( 'emzagar', __( 'مرکز فرماندهی', 'emzagar' ), __( 'مرکز فرماندهی', 'emzagar' ) . self::menu_bubble(), 'manage_options', self::PAGE, array( __CLASS__, 'render_page' ), 0 );
	}

	private static function menu_bubble() {
		$a = self::attention_count();
		return $a > 0 ? ' <span class="awaiting-mod">' . esc_html( self::n( $a ) ) . '</span>' : '';
	}

	public static function assets( $hook ) {
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( 'index.php' === $hook || 'users.php' === $hook || 'user-edit.php' === $hook || self::PAGE === $page ) {
			wp_enqueue_style( 'emzagar-hub', EMZ_URL . 'assets/css/hub.css', array(), EMZ_VERSION );
		}
	}

	/* ───────────── ویجت پیشخوان ───────────── */

	public static function dashboard_widget() {
		$h = self::opts();
		if ( 'yes' !== $h['widget'] || ! current_user_can( 'manage_options' ) || ! Emzagar_API::is_configured() ) {
			return;
		}
		wp_add_dashboard_widget( 'emzagar_hub_widget', __( 'امضاگیر — نبض کسب‌وکار', 'emzagar' ), array( __CLASS__, 'render_widget' ) );
	}

	public static function render_widget() {
		$c    = self::cached();
		$data = $c ? $c['data'] : null;
		echo '<div id="emz-widget" data-nonce="' . esc_attr( wp_create_nonce( 'emzagar_hub_widget' ) ) . '" data-url="' . esc_url( admin_url( 'admin-ajax.php' ) ) . '">';
		echo $data ? self::widget_body( $data ) : '<p>' . esc_html__( 'در حال دریافت وضعیت…', 'emzagar' ) . '</p>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- خروجی widget_body خودش escape شده است
		echo '</div>';
		?>
		<script>
		(function(){var w=document.getElementById('emz-widget');if(!w||!window.fetch){return;}
		fetch(w.dataset.url+'?action=emzagar_hub_widget&_wpnonce='+encodeURIComponent(w.dataset.nonce),{credentials:'same-origin'})
		.then(function(r){return r.ok?r.text():'';}).then(function(h){if(h){w.innerHTML=h;}}).catch(function(){});})();
		</script>
		<?php
	}

	public static function ajax_widget() {
		check_ajax_referer( 'emzagar_hub_widget' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( '', '', array( 'response' => 403 ) );
		}
		$p = self::pulse( 120 );
		if ( is_wp_error( $p ) ) {
			echo '<p>' . esc_html( $p->get_error_message() ) . '</p>';
		} else {
			echo self::widget_body( $p ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escape شده
		}
		wp_die();
	}

	private static function widget_body( $p ) {
		$k  = isset( $p['kpi'] ) ? $p['kpi'] : array();
		$o  = '<div class="emz-w-grid">';
		$o .= '<div><b>' . esc_html( self::n( isset( $k['pending'] ) ? $k['pending'] : 0 ) ) . '</b><span>' . esc_html__( 'منتظر امضا', 'emzagar' ) . '</span></div>';
		$o .= '<div><b>' . esc_html( self::n( isset( $k['signed30'] ) ? $k['signed30'] : 0 ) ) . '</b><span>' . esc_html__( 'امضا در ۳۰ روز', 'emzagar' ) . '</span></div>';
		$o .= '<div><b>' . esc_html( self::n( isset( $k['attention'] ) ? $k['attention'] : 0 ) ) . '</b><span>' . esc_html__( 'نیازمند اقدام', 'emzagar' ) . '</span></div>';
		$o .= '</div>';
		if ( ! empty( $k['pendingValue'] ) ) {
			/* translators: %s: amount */
			$o .= '<p class="emz-w-note">' . esc_html( sprintf( __( 'ارزش سفارش‌های منتظر امضا: %s', 'emzagar' ), self::money( $k['pendingValue'] ) ) ) . '</p>';
		}
		if ( ! empty( $p['attention'] ) ) {
			$o .= '<ul class="emz-w-list">';
			foreach ( array_slice( $p['attention'], 0, 4 ) as $a ) {
				$o .= '<li><span class="emz-chip-k emz-k-' . esc_attr( $a['kind'] ) . '">' . esc_html( self::kind_label( $a['kind'] ) ) . '</span> ' . esc_html( $a['title'] ) . ( ! empty( $a['customer'] ) ? ' — ' . esc_html( $a['customer'] ) : '' ) . '</li>';
			}
			$o .= '</ul>';
		} else {
			$o .= '<p class="emz-w-note">' . esc_html__( 'همه‌چیز مرتب است؛ موردی نیازمند اقدام نیست ✓', 'emzagar' ) . '</p>';
		}
		if ( isset( $p['depth']['score'] ) ) {
			$o .= '<p class="emz-w-note">' . esc_html( sprintf( /* translators: 1: score, 2: level */ __( 'عمق یکپارچگی: %1$s٪ (%2$s)', 'emzagar' ), self::n( $p['depth']['score'] ), $p['depth']['level'] ) ) . '</p>';
		}
		$o .= '<p><a class="button button-primary" href="' . esc_url( self::hub_url() ) . '">' . esc_html__( 'مرکز فرماندهی', 'emzagar' ) . '</a> <a class="button" href="' . esc_url( Emzagar_Connect::panel_link( 'admin' ) ) . '">' . esc_html__( 'پنل امضاگیر', 'emzagar' ) . '</a></p>';
		return $o;
	}

	/* ───────────── کنش‌ها ───────────── */

	private static function guard( $action ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $action );
	}

	private static function back( $msg ) {
		wp_safe_redirect( add_query_arg( 'emz_hub', $msg, self::hub_url() ) );
		exit;
	}

	public static function act_remind() {
		self::guard( 'emzagar_hub_remind' );
		$id  = isset( $_GET['id'] ) ? absint( $_GET['id'] ) : 0;
		$res = $id ? Emzagar_API::request( 'POST', '/api/v1/contracts/' . $id . '/remind' ) : new WP_Error( 'x', 'x' );
		if ( ! is_wp_error( $res ) ) {
			Emzagar_Workspace::bump();
		}
		self::back( is_wp_error( $res ) ? 'remind_fail' : 'reminded' );
	}

	public static function act_remind_all() {
		self::guard( 'emzagar_hub_remind_all' );
		$p  = self::pulse( 0 );
		$ok = 0;
		if ( ! is_wp_error( $p ) && ! empty( $p['attention'] ) ) {
			foreach ( $p['attention'] as $a ) {
				if ( $ok >= 10 ) {
					break;
				}
				if ( ! empty( $a['canRemind'] ) && ! is_wp_error( Emzagar_API::request( 'POST', '/api/v1/contracts/' . (int) $a['id'] . '/remind' ) ) ) {
					++$ok;
				}
			}
		}
		self::back( $ok ? 'reminded_' . $ok : 'remind_fail' );
	}

	public static function act_refresh() {
		self::guard( 'emzagar_hub_refresh' );
		self::pulse( 0 );
		self::back( 'refreshed' );
	}

	public static function act_digest_test() {
		self::guard( 'emzagar_hub_digest_test' );
		self::back( self::send_digest( true ) ? 'digest_sent' : 'digest_fail' );
	}

	/* ───────────── گزارش هفتگی ───────────── */

	public static function digest_html( $p ) {
		$k      = $p['kpi'];
		$r      = $p['roi'];
		$accent = esc_attr( emzagar_options()['accent'] );
		$row    = function ( $label, $val ) {
			return '<tr><td style="padding:8px 0;color:#555">' . esc_html( $label ) . '</td><td style="padding:8px 0;text-align:left;font-weight:700">' . esc_html( $val ) . '</td></tr>';
		};
		$h  = '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:560px;margin:auto;color:#111">';
		$h .= '<h2 style="margin:0 0 4px;color:' . $accent . '">' . esc_html( sprintf( /* translators: %s: site name */ __( 'گزارش هفتگی قراردادهای %s', 'emzagar' ), wp_strip_all_tags( get_bloginfo( 'name' ) ) ) ) . '</h2>';
		$h .= '<p style="margin:0 0 16px;color:#666">' . esc_html__( 'خلاصه‌ی نبض کسب‌وکار شما در امضاگیر', 'emzagar' ) . '</p>';
		$h .= '<table style="width:100%;border-collapse:collapse;border-top:1px solid #eee">';
		$h .= $row( __( 'قرارداد امضاشده در ۳۰ روز اخیر', 'emzagar' ), self::n( $k['signed30'] ) );
		$h .= $row( __( 'منتظر امضا', 'emzagar' ), self::n( $k['pending'] ) );
		$h .= $row( __( 'ارزش سفارش‌های منتظر امضا', 'emzagar' ), self::money( $k['pendingValue'] ) );
		$h .= $row( __( 'ارزش قراردادهای امضاشده (۳۰ روز)', 'emzagar' ), self::money( $r['valueUnlocked'] ) );
		if ( null !== $k['medianHours'] ) {
			$h .= $row( __( 'میانه‌ی زمان امضا (ساعت)', 'emzagar' ), self::n( $k['medianHours'] ) );
		}
		$h .= $row( __( 'کار دستی حذف‌شده (برآورد، ساعت)', 'emzagar' ), self::n( $r['hoursSaved'] ) );
		$h .= '</table>';
		if ( ! empty( $p['attention'] ) ) {
			$h .= '<h3 style="margin:20px 0 6px">' . esc_html__( 'نیازمند اقدام شما', 'emzagar' ) . '</h3><ul style="padding-inline-start:18px;margin:0">';
			foreach ( array_slice( $p['attention'], 0, 6 ) as $a ) {
				$h .= '<li style="margin:4px 0">' . esc_html( self::kind_label( $a['kind'] ) . ': ' . $a['title'] . ' — ' . $a['hint'] ) . '</li>';
			}
			$h .= '</ul>';
		}
		if ( ! empty( $p['depth']['next'] ) ) {
			$h .= '<p style="background:#f0fdf4;border-radius:8px;padding:10px 12px;margin:20px 0">' . esc_html( sprintf( /* translators: 1: label */ __( 'پیشنهاد این هفته: %s', 'emzagar' ), $p['depth']['next']['label'] ) ) . '</p>';
		}
		$h .= '<p><a href="' . esc_url( self::hub_url() ) . '" style="display:inline-block;background:' . $accent . ';color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">' . esc_html__( 'باز کردن مرکز فرماندهی', 'emzagar' ) . '</a></p></div>';
		return $h;
	}

	public static function send_digest( $force = false ) {
		$h = self::opts();
		if ( ! $force && 'yes' !== $h['digest'] ) {
			return false;
		}
		$p = self::pulse( 0 );
		if ( is_wp_error( $p ) ) {
			return false;
		}
		// هفته‌ی بی‌فعالیت مطلق: مزاحم نمی‌شویم
		if ( ! $force && empty( $p['kpi']['pending'] ) && empty( $p['kpi']['signed30'] ) && empty( $p['attention'] ) ) {
			return false;
		}
		$to = is_email( $h['digest_email'] ) ? $h['digest_email'] : get_option( 'admin_email' );
		return (bool) wp_mail(
			$to,
			sprintf( /* translators: %s: site name */ __( '[%s] گزارش هفتگی قراردادها', 'emzagar' ), wp_strip_all_tags( get_bloginfo( 'name' ) ) ),
			self::digest_html( $p ),
			array( 'Content-Type: text/html; charset=UTF-8' )
		);
	}

	/* ───────────── نشان اعتماد ───────────── */

	public static function badge_html() {
		$c = self::cached();
		if ( ! $c || empty( $c['data']['trust']['url'] ) ) {
			return '';
		}
		$t      = $c['data']['trust'];
		$accent = esc_attr( emzagar_options()['accent'] );
		$count  = ! empty( $t['signedTotal'] ) ? '<small>' . esc_html( sprintf( /* translators: %s: count */ __( '%s قرارداد امضاشده و مستند', 'emzagar' ), self::n( $t['signedTotal'] ) ) ) . '</small>' : '';
		return '<a class="emz-trust" href="' . esc_url( $t['url'] ) . '" target="_blank" rel="noopener" style="--emz-accent:' . $accent . '"><span class="emz-trust-ico" aria-hidden="true">🛡️</span><span><strong>' . esc_html__( 'قراردادهای این کسب‌وکار با امضاگیر مستند می‌شود', 'emzagar' ) . '</strong>' . $count . '</span></a>';
	}

	private static function badge_css() {
		return '<style>.emz-trust{display:inline-flex;align-items:center;gap:10px;padding:8px 14px;border:1px solid #e5e7eb;border-radius:14px;background:#fff;color:#111;text-decoration:none;font-size:13px;line-height:1.6;box-shadow:0 2px 10px rgba(0,0,0,.06)}.emz-trust:hover{border-color:var(--emz-accent)}.emz-trust small{display:block;color:#6b7280;font-size:11px}.emz-trust-ico{font-size:22px}.emz-trust-float{position:fixed;inset-block-end:14px;inset-inline-start:14px;z-index:9990}</style>';
	}

	public static function shortcode_trust() {
		$h = self::html_or_empty();
		return $h;
	}

	private static function html_or_empty() {
		$h = self::opts();
		if ( 'no' === $h['badge'] ) {
			return current_user_can( 'manage_options' ) ? '<em>' . esc_html__( '[emzagar_trust] غیرفعال است؛ در مرکز فرماندهی «نشان اعتماد» را فعال کنید.', 'emzagar' ) . '</em>' : '';
		}
		$b = self::badge_html();
		return '' === $b ? '' : self::badge_css() . $b;
	}

	public static function footer_badge() {
		$h = self::opts();
		if ( 'footer' !== $h['badge'] || is_admin() ) {
			return;
		}
		$b = self::badge_html();
		if ( '' !== $b ) {
			echo self::badge_css() . '<div class="emz-trust-float">' . $b . '</div>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escape شده
		}
	}

	/* ───────────── سلامت سایت ───────────── */

	public static function site_health( $tests ) {
		$tests['direct']['emzagar_connection'] = array(
			'label' => __( 'اتصال امضاگیر', 'emzagar' ),
			'test'  => array( __CLASS__, 'health_test' ),
		);
		return $tests;
	}

	public static function health_test() {
		$r = array(
			'label'       => __( 'امضاگیر متصل و سالم است', 'emzagar' ),
			'status'      => 'good',
			'badge'       => array( 'label' => __( 'قرارداد', 'emzagar' ), 'color' => 'green' ),
			'description' => '<p>' . esc_html__( 'قراردادها، دروازه‌های دسترسی و همگام‌سازی سفارش‌ها فعال‌اند.', 'emzagar' ) . '</p>',
			'actions'     => '',
			'test'        => 'emzagar_connection',
		);
		if ( ! Emzagar_API::is_configured() ) {
			$r['label']       = __( 'امضاگیر متصل نیست', 'emzagar' );
			$r['status']      = 'critical';
			$r['badge']['color'] = 'red';
			$r['description'] = '<p>' . esc_html__( 'تا اتصال برقرار نشود، دروازه‌های قرارداد و صدور خودکار کار نمی‌کنند. صفحه‌ی امضاگیر را باز کنید تا اتصال خودکار تکرار شود.', 'emzagar' ) . '</p>';
			$r['actions']     = '<p><a href="' . esc_url( admin_url( 'admin.php?page=emzagar' ) ) . '">' . esc_html__( 'بررسی اتصال', 'emzagar' ) . '</a></p>';
			return $r;
		}
		$queue = Emzagar_Sync::queue_size();
		if ( $queue > 50 ) {
			$r['label']       = __( 'صف همگام‌سازی امضاگیر انباشته شده است', 'emzagar' );
			$r['status']      = 'recommended';
			$r['badge']['color'] = 'orange';
			/* translators: %s: queue size */
			$r['description'] = '<p>' . esc_html( sprintf( __( '%s رویداد در صف ارسال به ابر مانده است؛ ارتباط اینترنتی سرور و WP-Cron را بررسی کنید.', 'emzagar' ), self::n( $queue ) ) ) . '</p>';
		}
		return $r;
	}

	/* ───────────── صفحه‌ی فرماندهی ───────────── */

	private static function notice_for( $code ) {
		$m = array(
			'reminded'    => array( 'success', __( 'یادآوری امضا ارسال شد.', 'emzagar' ) ),
			'remind_fail' => array( 'error', __( 'ارسال یادآوری ممکن نشد (حداکثر ۳ بار در ساعت برای هر قرارداد).', 'emzagar' ) ),
			'refreshed'   => array( 'success', __( 'اطلاعات به‌روز شد.', 'emzagar' ) ),
			'digest_sent' => array( 'success', __( 'گزارش آزمایشی به ایمیل ارسال شد.', 'emzagar' ) ),
			'digest_fail' => array( 'error', __( 'ارسال گزارش ممکن نشد؛ تنظیمات ایمیل وردپرس را بررسی کنید.', 'emzagar' ) ),
		);
		if ( 0 === strpos( $code, 'reminded_' ) ) {
			/* translators: %s: count */
			return array( 'success', sprintf( __( 'یادآوری برای %s قرارداد ارسال شد.', 'emzagar' ), self::n( (int) substr( $code, 9 ) ) ) );
		}
		return isset( $m[ $code ] ) ? $m[ $code ] : null;
	}

	private static function sparkline( $trend ) {
		if ( empty( $trend ) ) {
			return '';
		}
		$max = 1;
		foreach ( $trend as $d ) {
			$max = max( $max, (int) $d['signed'], (int) $d['issued'] );
		}
		$o = '<div class="emz-spark" role="img" aria-label="' . esc_attr__( 'روند ۱۴ روز اخیر', 'emzagar' ) . '">';
		foreach ( $trend as $d ) {
			$hs = max( 2, (int) round( 56 * (int) $d['signed'] / $max ) );
			$hi = max( 2, (int) round( 56 * (int) $d['issued'] / $max ) );
			$o .= '<span class="emz-bar"><i class="i" style="height:' . $hi . 'px"></i><i class="s" style="height:' . $hs . 'px"></i></span>';
		}
		return $o . '</div>';
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$code   = isset( $_GET['emz_hub'] ) ? sanitize_text_field( wp_unslash( $_GET['emz_hub'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$notice = $code ? self::notice_for( $code ) : null;
		$h      = self::opts();
		$p      = self::pulse( 120 );
		?>
		<div class="wrap emz-hub" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>">
			<h1><?php esc_html_e( 'امضاگیر — مرکز فرماندهی کسب‌وکار', 'emzagar' ); ?></h1>
			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice[0] ); ?> is-dismissible"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>
			<?php if ( is_wp_error( $p ) ) : ?>
				<div class="notice notice-warning"><p><?php echo esc_html( $p->get_error_message() ); ?> <a href="<?php echo esc_url( admin_url( 'admin.php?page=emzagar' ) ); ?>"><?php esc_html_e( 'بررسی اتصال', 'emzagar' ); ?></a></p></div>
			<?php else : ?>
				<?php self::render_dashboard( $p ); ?>
			<?php endif; ?>
			<?php self::render_settings( $h, is_wp_error( $p ) ? null : $p ); ?>
		</div>
		<?php
	}

	private static function render_dashboard( $p ) {
		$k = $p['kpi'];
		$r = $p['roi'];
		$d = $p['depth'];
		$cards = array(
			array( __( 'منتظر امضا', 'emzagar' ), self::n( $k['pending'] ), '' ),
			array( __( 'ارزش سفارش‌های منتظر امضا', 'emzagar' ), self::money( $k['pendingValue'] ), '' ),
			array( __( 'امضا در ۳۰ روز', 'emzagar' ), self::n( $k['signed30'] ), '' ),
			array( __( 'میانه‌ی زمان امضا', 'emzagar' ), null === $k['medianHours'] ? '—' : self::n( $k['medianHours'] ) . ' ' . __( 'ساعت', 'emzagar' ), '' ),
			array( __( 'در آستانه‌ی انقضا', 'emzagar' ), self::n( $k['expiringSoon'] ), '' ),
			array( __( 'تمدید نزدیک', 'emzagar' ), self::n( $k['renewalsDue'] ), '' ),
		);
		?>
		<div class="emz-h-toolbar">
			<a class="button button-primary" href="<?php echo esc_url( Emzagar_Workspace::url( array( 'tab' => 'new' ) ) ); ?>"><?php esc_html_e( 'صدور قرارداد جدید', 'emzagar' ); ?></a>
			<a class="button" href="<?php echo esc_url( Emzagar_Workspace::url() ); ?>"><?php esc_html_e( 'میز کار قراردادها', 'emzagar' ); ?></a>
			<a class="button" href="<?php echo esc_url( Emzagar_Automations::url() ); ?>"><?php esc_html_e( 'اتوماسیون‌ها', 'emzagar' ); ?></a>
			<a class="button" href="<?php echo esc_url( Emzagar_Connect::panel_link( 'contracts' ) ); ?>"><?php esc_html_e( 'قراردادها در پنل', 'emzagar' ); ?></a>
			<a class="button" href="<?php echo esc_url( Emzagar_Connect::panel_link( 'templates' ) ); ?>"><?php esc_html_e( 'قالب‌ها', 'emzagar' ); ?></a>
			<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_hub_refresh' ), 'emzagar_hub_refresh' ) ); ?>"><?php esc_html_e( 'به‌روزرسانی', 'emzagar' ); ?></a>
		</div>
		<div class="emz-h-cards">
			<?php foreach ( $cards as $c ) : ?>
				<div class="emz-h-card"><span><?php echo esc_html( $c[0] ); ?></span><b><?php echo esc_html( $c[1] ); ?></b></div>
			<?php endforeach; ?>
		</div>

		<div class="emz-h-cols">
			<section class="emz-h-box">
				<h2><?php esc_html_e( 'صف اقدام', 'emzagar' ); ?></h2>
				<?php if ( empty( $p['attention'] ) ) : ?>
					<p class="emz-h-empty"><?php esc_html_e( 'همه‌چیز مرتب است؛ موردی نیازمند اقدام نیست ✓', 'emzagar' ); ?></p>
				<?php else : ?>
					<table class="widefat striped"><tbody>
					<?php foreach ( $p['attention'] as $a ) : ?>
						<tr>
							<td><span class="emz-chip-k emz-k-<?php echo esc_attr( $a['kind'] ); ?>"><?php echo esc_html( self::kind_label( $a['kind'] ) ); ?></span></td>
							<td><b><?php echo esc_html( $a['title'] ); ?></b><br><small><?php echo esc_html( $a['number'] . ( $a['customer'] ? ' • ' . $a['customer'] : '' ) . ' — ' . $a['hint'] ); ?></small></td>
							<td style="text-align:end">
								<?php if ( ! empty( $a['canRemind'] ) ) : ?>
									<a class="button button-small" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_hub_remind&id=' . (int) $a['id'] ), 'emzagar_hub_remind' ) ); ?>"><?php esc_html_e( 'یادآوری', 'emzagar' ); ?></a>
								<?php else : ?>
									<a class="button button-small" href="<?php echo esc_url( Emzagar_Workspace::url( array( 'contract' => (int) $a['id'] ) ) ); ?>"><?php esc_html_e( 'بررسی', 'emzagar' ); ?></a>
								<?php endif; ?>
							</td>
						</tr>
					<?php endforeach; ?>
					</tbody></table>
					<p><a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_hub_remind_all' ), 'emzagar_hub_remind_all' ) ); ?>"><?php esc_html_e( 'یادآوری گروهی به همه‌ی معطل‌ها', 'emzagar' ); ?></a></p>
				<?php endif; ?>
			</section>

			<section class="emz-h-box">
				<h2><?php esc_html_e( 'ارزشی که امضاگیر برای کسب‌وکار شما ساخته (۳۰ روز اخیر)', 'emzagar' ); ?></h2>
				<ul class="emz-h-roi">
					<li><b><?php echo esc_html( self::n( $r['signed30'] ) ); ?></b> <?php esc_html_e( 'قرارداد بدون چاپ، پیگیری دستی و بایگانی بسته شد', 'emzagar' ); ?></li>
					<li><b><?php echo esc_html( self::n( $r['hoursSaved'] ) ); ?></b> <?php esc_html_e( 'ساعت کار دستی حذف شد (برآورد)', 'emzagar' ); ?></li>
					<li><b><?php echo esc_html( self::money( $r['valueUnlocked'] ) ); ?></b> <?php esc_html_e( 'ارزش قراردادهای امضاشده', 'emzagar' ); ?></li>
				</ul>
				<?php echo self::sparkline( $p['trend'] ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escape شده ?>
				<small class="emz-h-legend"><i class="i"></i> <?php esc_html_e( 'صادرشده', 'emzagar' ); ?> &nbsp; <i class="s"></i> <?php esc_html_e( 'امضاشده', 'emzagar' ); ?></small>
			</section>
		</div>

		<section class="emz-h-box">
			<h2>
				<?php esc_html_e( 'عمق یکپارچگی', 'emzagar' ); ?> — <?php echo esc_html( $d['level'] ); ?>
				<span class="emz-h-score"><?php echo esc_html( self::n( $d['score'] ) ); ?>٪</span>
			</h2>
			<div class="emz-h-meter" role="progressbar" aria-valuenow="<?php echo (int) $d['score']; ?>" aria-valuemin="0" aria-valuemax="100"><i style="width:<?php echo (int) $d['score']; ?>%"></i></div>
			<?php if ( ! empty( $d['next'] ) ) : ?>
				<p class="emz-h-next"><b><?php esc_html_e( 'گام پیشنهادی:', 'emzagar' ); ?></b> <?php echo esc_html( $d['next']['label'] . ' — ' . $d['next']['hint'] ); ?></p>
			<?php endif; ?>
			<ul class="emz-h-steps">
				<?php foreach ( $d['steps'] as $s ) : ?>
					<li class="<?php echo ! empty( $s['done'] ) ? 'is-done' : ''; ?>"><span><?php echo ! empty( $s['done'] ) ? '✓' : '○'; ?></span> <b><?php echo esc_html( $s['label'] ); ?></b><small><?php echo esc_html( $s['hint'] ); ?></small></li>
				<?php endforeach; ?>
			</ul>
		</section>
		<?php
	}

	private static function render_settings( $h, $p ) {
		$roles = wp_roles()->get_names();
		unset( $roles['administrator'] );
		$gated = Emzagar_Access::gated_items( 20 );
		$st    = Emzagar_Access::stats();
		$trust = ( $p && ! empty( $p['trust']['url'] ) ) ? $p['trust']['url'] : '';
		?>
		<div class="emz-h-cols">
			<section class="emz-h-box">
				<h2><?php esc_html_e( 'خودکارسازی و نمایش', 'emzagar' ); ?></h2>
				<form method="post" action="options.php">
					<?php settings_fields( 'emzagar_hub_group' ); ?>
					<table class="form-table" role="presentation"><tbody>
						<tr><th><?php esc_html_e( 'نقش پس از امضا', 'emzagar' ); ?></th><td>
							<select name="<?php echo esc_attr( self::OPT ); ?>[grant_role]">
								<option value=""><?php esc_html_e( '— بدون تغییر نقش —', 'emzagar' ); ?></option>
								<?php foreach ( $roles as $slug => $name ) : ?>
									<option value="<?php echo esc_attr( $slug ); ?>" <?php selected( $h['grant_role'], $slug ); ?>><?php echo esc_html( translate_user_role( $name ) ); ?></option>
								<?php endforeach; ?>
							</select>
							<p class="description"><?php esc_html_e( 'کاربری که قرارداد را امضا کند این نقش را خودکار می‌گیرد و با لغو/انقضا پس گرفته می‌شود. (نقش «مشتری امضاکننده» آماده است.) مدیران هرگز تغییر نمی‌کنند.', 'emzagar' ); ?></p>
						</td></tr>
						<tr><th><?php esc_html_e( 'نشان اعتماد', 'emzagar' ); ?></th><td>
							<select name="<?php echo esc_attr( self::OPT ); ?>[badge]">
								<option value="no" <?php selected( $h['badge'], 'no' ); ?>><?php esc_html_e( 'غیرفعال', 'emzagar' ); ?></option>
								<option value="footer" <?php selected( $h['badge'], 'footer' ); ?>><?php esc_html_e( 'نمایش خودکار پایین سایت', 'emzagar' ); ?></option>
								<option value="shortcode" <?php selected( $h['badge'], 'shortcode' ); ?>><?php esc_html_e( 'فقط با شورت‌کد [emzagar_trust]', 'emzagar' ); ?></option>
							</select>
							<?php if ( $trust ) : ?><p class="description"><?php esc_html_e( 'صفحه‌ی عمومی اعتماد:', 'emzagar' ); ?> <a href="<?php echo esc_url( $trust ); ?>" target="_blank" rel="noopener"><?php echo esc_html( $trust ); ?></a></p><?php endif; ?>
						</td></tr>
						<tr><th><?php esc_html_e( 'نوار مدیریت و ویجت', 'emzagar' ); ?></th><td>
							<label><input type="checkbox" name="<?php echo esc_attr( self::OPT ); ?>[adminbar]" value="yes" <?php checked( $h['adminbar'], 'yes' ); ?>> <?php esc_html_e( 'نشان زنده‌ی قراردادهای منتظر امضا روی نوار مدیریت', 'emzagar' ); ?></label><br>
							<label><input type="checkbox" name="<?php echo esc_attr( self::OPT ); ?>[widget]" value="yes" <?php checked( $h['widget'], 'yes' ); ?>> <?php esc_html_e( 'ویجت «نبض کسب‌وکار» در پیشخوان', 'emzagar' ); ?></label><br>
							<label><input type="checkbox" name="<?php echo esc_attr( self::OPT ); ?>[live]" value="yes" <?php checked( $h['live'], 'yes' ); ?>> <?php esc_html_e( 'اعلان زنده‌ی امضا (Toast) و زنگ فعالیت در همه‌ی صفحه‌های پیشخوان', 'emzagar' ); ?></label><br>
							<label><input type="checkbox" name="<?php echo esc_attr( self::OPT ); ?>[palette]" value="yes" <?php checked( $h['palette'], 'yes' ); ?>> <?php esc_html_e( 'پالت فرمان سراسری (Ctrl+K) برای جستجو و اقدام سریع', 'emzagar' ); ?></label>
						</td></tr>
						<tr><th><?php esc_html_e( 'گزارش هفتگی', 'emzagar' ); ?></th><td>
							<label><input type="checkbox" name="<?php echo esc_attr( self::OPT ); ?>[digest]" value="yes" <?php checked( $h['digest'], 'yes' ); ?>> <?php esc_html_e( 'هر یکشنبه صبح به ایمیل ارسال شود', 'emzagar' ); ?></label><br>
							<input type="email" class="regular-text" dir="ltr" name="<?php echo esc_attr( self::OPT ); ?>[digest_email]" value="<?php echo esc_attr( $h['digest_email'] ); ?>" placeholder="<?php echo esc_attr( get_option( 'admin_email' ) ); ?>">
							<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_hub_digest_test' ), 'emzagar_hub_digest_test' ) ); ?>"><?php esc_html_e( 'ارسال گزارش آزمایشی', 'emzagar' ); ?></a>
						</td></tr>
					</tbody></table>
					<?php submit_button( __( 'ذخیره', 'emzagar' ) ); ?>
				</form>
			</section>

			<section class="emz-h-box">
				<h2><?php esc_html_e( 'دروازه‌های قرارداد', 'emzagar' ); ?></h2>
				<p class="description"><?php esc_html_e( 'در ویرایش هر صفحه، نوشته یا محصول، کادر «قفل قرارداد (امضاگیر)» را ببینید. برای بخشی از متن: [emzagar_gate template_id="12"] … [/emzagar_gate]', 'emzagar' ); ?></p>
				<?php if ( empty( $gated ) ) : ?>
					<p class="emz-h-empty"><?php esc_html_e( 'هنوز موردی قفل نشده است.', 'emzagar' ); ?></p>
				<?php else : ?>
					<ul class="emz-h-gates">
						<?php foreach ( $gated as $g ) : ?>
							<li><a href="<?php echo esc_url( get_edit_post_link( $g->ID ) ); ?>"><?php echo esc_html( get_the_title( $g ) ); ?></a> <small>(<?php echo esc_html( get_post_type_object( $g->post_type )->labels->singular_name ); ?>)</small></li>
						<?php endforeach; ?>
					</ul>
				<?php endif; ?>
				<p class="description">
					<?php
					/* translators: 1: checks 2: allowed */
					echo esc_html( sprintf( __( 'تا امروز %1$s بار دسترسی بر پایه‌ی امضا بررسی و %2$s بار به‌خاطر امضا باز شد.', 'emzagar' ), self::n( $st['checks'] ), self::n( $st['allowed'] ) ) );
					?>
				</p>
				<p class="description"><?php esc_html_e( 'برای توسعه‌دهندگان: emzagar_user_has_signed( $user_id_or_email, $template_id = 0 ) و هوک‌های emzagar_user_signed و emzagar_contract_signed_for_email.', 'emzagar' ); ?></p>
			</section>
		</div>
		<?php
	}
}
