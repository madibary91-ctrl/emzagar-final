<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * محدودیت نرخ و قفل اضطراری برای صدور قرارداد از طریق فرم‌های عمومی.
 *
 * لایه‌ها (به ترتیب بررسی):
 *   ۰) قفل اضطراری (دستی یا خودکار) — همه‌ی صدورهای فرمی متوقف می‌شود.
 *   ۱) سقف ساعتی برای هر IP.
 *   ۲) سقف روزانه برای هر ایمیل.
 *   ۳) سقف روزانه‌ی کل قراردادهای صادرشده از فرم‌ها.
 *   +) تشخیص موج ناگهانی (Burst): اگر در ۱۰ دقیقه تعداد تلاش‌ها از آستانه بگذرد، قفل خودکار فعال می‌شود.
 *
 * علاوه بر جلوگیری از ارسال تکراری (همان ایمیل و قالب در ۱۰ دقیقه) که در Emzagar_Forms وجود دارد.
 * شمارنده‌ها با یک UPDATE اتمیک روی جدول options به‌روز می‌شوند (بدون وابستگی به کش شیء، سازگار با درخواست‌های هم‌زمان).
 * خرید ووکامرس (پرداخت واقعی) هرگز مسدود نمی‌شود؛ فقط فرم‌های عمومی و شورت‌کد درخواست قرارداد.
 */
class Emzagar_Limits {

	const OPT      = 'emzagar_limits';
	const OPT_LOCK = 'emzagar_lockdown';
	const PREFIX   = 'emzagar_rl_';

	public static function init() {
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 99 );
		add_action( 'admin_head', array( __CLASS__, 'bar_style' ) );
		add_action( 'wp_head', array( __CLASS__, 'bar_style' ) );
		add_action( 'emzagar_daily_maintenance', array( __CLASS__, 'cleanup' ) );
		if ( is_admin() ) {
			add_action( 'admin_post_emzagar_limits_save', array( __CLASS__, 'act_save' ) );
			add_action( 'admin_post_emzagar_lockdown', array( __CLASS__, 'act_lockdown' ) );
			add_action( 'admin_notices', array( __CLASS__, 'notice' ) );
		}
	}

	/* ───────────── تنظیمات ───────────── */

	public static function defaults() {
		return array(
			'daily_cap'       => 100, // سقف روزانه‌ی قرارداد از فرم‌ها (۰ = بی‌نهایت)
			'ip_hour'         => 10,  // تلاش در ساعت برای هر IP
			'email_day'       => 3,   // قرارداد در روز برای هر ایمیل
			'user_hour'       => 5,   // شورت‌کد درخواست قرارداد: هر کاربر در ساعت
			'burst'           => 30,  // آستانه‌ی تلاش در ۱۰ دقیقه برای قفل خودکار (۰ = خاموش)
			'lock_minutes'    => 60,  // مدت قفل خودکار
			'notify'          => 'yes',
		);
	}

	public static function opts() {
		$s = get_option( self::OPT, array() );
		return wp_parse_args( is_array( $s ) ? $s : array(), self::defaults() );
	}

	public static function sanitize( $in ) {
		$in  = is_array( $in ) ? $in : array();
		$old = self::opts();
		$n   = function ( $k, $max ) use ( $in, $old ) {
			return max( 0, min( $max, (int) ( isset( $in[ $k ] ) ? $in[ $k ] : $old[ $k ] ) ) );
		};
		return array(
			'daily_cap'    => $n( 'daily_cap', 100000 ),
			'ip_hour'      => $n( 'ip_hour', 1000 ),
			'email_day'    => $n( 'email_day', 1000 ),
			'user_hour'    => $n( 'user_hour', 1000 ),
			'burst'        => $n( 'burst', 10000 ),
			'lock_minutes' => max( 5, min( 10080, (int) ( isset( $in['lock_minutes'] ) ? $in['lock_minutes'] : $old['lock_minutes'] ) ) ),
			'notify'       => ( ! empty( $in['notify'] ) && 'no' !== $in['notify'] ) ? 'yes' : 'no',
		);
	}

	/* ───────────── ابزارها ───────────── */

	/** IP کلاینت (فقط REMOTE_ADDR؛ پشت پراکسی/CDN با فیلتر emzagar_client_ip تنظیم شود) */
	public static function client_ip() {
		$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotValidated
		$ip = (string) apply_filters( 'emzagar_client_ip', $ip );
		return filter_var( $ip, FILTER_VALIDATE_IP ) ? $ip : 'unknown';
	}

	private static function day() {
		return wp_date( 'Ymd' );
	}

	/** افزایش/کاهش اتمیک شمارنده و برگرداندن مقدار جدید */
	private static function bump( $name, $delta = 1 ) {
		global $wpdb;
		$opt = self::PREFIX . $name;
		add_option( $opt, 0, '', 'no' ); // اگر وجود داشته باشد بی‌اثر است
		// phpcs:disable WordPress.DB.DirectDatabaseQuery
		$wpdb->query( $wpdb->prepare( "UPDATE {$wpdb->options} SET option_value = GREATEST(0, CAST(option_value AS SIGNED) + %d) WHERE option_name = %s", (int) $delta, $opt ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$v = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $opt ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		// phpcs:enable
		wp_cache_delete( $opt, 'options' );
		wp_cache_delete( 'notoptions', 'options' );
		return (int) $v;
	}

	private static function peek( $name ) {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		return (int) $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", self::PREFIX . $name ) );
	}

	/** پاک‌سازی شمارنده‌های قدیمی (روزانه) */
	public static function cleanup() {
		global $wpdb;
		$keep1 = self::day();
		$keep2 = wp_date( 'Ymd', time() - DAY_IN_SECONDS );
		// phpcs:disable WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s AND option_name NOT LIKE %s AND option_name NOT LIKE %s",
				$wpdb->esc_like( self::PREFIX ) . '%',
				'%' . $wpdb->esc_like( '_' . $keep1 ) . '%',
				'%' . $wpdb->esc_like( '_' . $keep2 ) . '%'
			)
		);
		// phpcs:enable
	}

	/* ───────────── قفل اضطراری ───────────── */

	public static function lock_state() {
		$s = get_option( self::OPT_LOCK, array() );
		$s = wp_parse_args( is_array( $s ) ? $s : array(), array( 'mode' => 'off', 'until' => 0, 'reason' => '', 'at' => 0, 'by' => '' ) );
		$active = 'manual' === $s['mode'] || ( 'auto' === $s['mode'] && (int) $s['until'] > time() );
		if ( 'auto' === $s['mode'] && ! $active ) {
			$s['mode'] = 'off'; // قفل خودکار منقضی شد
		}
		$s['active'] = $active;
		return $s;
	}

	public static function is_locked() {
		$s = self::lock_state();
		return (bool) $s['active'];
	}

	public static function lock( $mode, $reason = '', $minutes = 60, $by = '' ) {
		$mode = 'manual' === $mode ? 'manual' : 'auto';
		update_option(
			self::OPT_LOCK,
			array(
				'mode'   => $mode,
				'until'  => 'auto' === $mode ? time() + max( 5, (int) $minutes ) * MINUTE_IN_SECONDS : 0,
				'reason' => mb_substr( wp_strip_all_tags( (string) $reason ), 0, 200 ),
				'at'     => time(),
				'by'     => (string) $by,
			),
			false
		);
	}

	public static function unlock() {
		update_option( self::OPT_LOCK, array( 'mode' => 'off', 'until' => 0, 'reason' => '', 'at' => time(), 'by' => '' ), false );
	}

	/* ───────────── بررسی ───────────── */

	private static function deny( $code, $msg ) {
		self::bump( 'b_' . self::day() ); // شمارنده‌ی مسدودشده‌ها
		return array( 'ok' => false, 'code' => $code, 'msg' => '⛔ ' . $msg, 'reserved' => false );
	}

	/**
	 * بررسی و رزرو سهمیه‌ی یک تلاش برای صدور قرارداد از فرم عمومی.
	 *
	 * @param string $channel form|request
	 * @param string $email   ایمیل مشتری (برای سقف هر ایمیل)
	 * @return array{ok:bool,code:string,msg:string,reserved:bool}
	 */
	public static function check( $channel = 'form', $email = '' ) {
		$o   = self::opts();
		$day = self::day();

		if ( self::is_locked() ) {
			return self::deny( 'lockdown', __( 'قفل اضطراری فعال است؛ صدور از فرم‌ها موقتاً متوقف شده است.', 'emzagar' ) );
		}

		// موج ناگهانی: هر تلاش شمرده می‌شود (حتی اگر بعداً رد شود)
		if ( (int) $o['burst'] > 0 ) {
			$slot = $day . '_' . (int) floor( time() / 600 );
			if ( self::bump( 'bu_' . $slot ) > (int) $o['burst'] ) {
				self::lock( 'auto', __( 'موج غیرعادی ارسال فرم (احتمال اسپم) شناسایی شد.', 'emzagar' ), (int) $o['lock_minutes'], 'system' );
				self::announce_lock( $o );
				return self::deny( 'burst', __( 'تعداد ارسال‌ها غیرعادی است؛ قفل خودکار فعال شد.', 'emzagar' ) );
			}
		}

		$ip = self::client_ip();
		if ( (int) $o['ip_hour'] > 0 && 'unknown' !== $ip ) {
			$hour = wp_date( 'YmdH' );
			if ( self::bump( 'ip_' . substr( md5( $ip ), 0, 12 ) . '_' . $day . '_' . $hour ) > (int) $o['ip_hour'] ) {
				return self::deny( 'ip', __( 'سقف ارسال در ساعت برای این شبکه پر شده است.', 'emzagar' ) );
			}
		}

		$email = strtolower( trim( (string) $email ) );
		if ( (int) $o['email_day'] > 0 && '' !== $email ) {
			if ( self::bump( 'em_' . substr( md5( $email ), 0, 12 ) . '_' . $day ) > (int) $o['email_day'] ) {
				return self::deny( 'email', __( 'سقف روزانه‌ی این ایمیل پر شده است.', 'emzagar' ) );
			}
		}

		if ( (int) $o['daily_cap'] > 0 ) {
			if ( self::bump( 'd_' . $day ) > (int) $o['daily_cap'] ) {
				self::bump( 'd_' . $day, -1 );
				return self::deny( 'daily', __( 'سقف روزانه‌ی صدور قرارداد از فرم‌ها پر شده است؛ فردا خودکار باز می‌شود.', 'emzagar' ) );
			}
			return array( 'ok' => true, 'code' => '', 'msg' => '', 'reserved' => true );
		}
		self::bump( 'd_' . $day ); // شمارش برای آمار حتی بدون سقف
		return array( 'ok' => true, 'code' => '', 'msg' => '', 'reserved' => true );
	}

	/** برگرداندن سهمیه‌ی رزروشده وقتی صدور واقعاً انجام نشد (خطای ابر) */
	public static function release( $gate ) {
		if ( is_array( $gate ) && ! empty( $gate['reserved'] ) ) {
			self::bump( 'd_' . self::day(), -1 );
		}
	}

	/** محدودیت شورت‌کد درخواست قرارداد برای کاربر واردشده */
	public static function check_user( $user_id, $email ) {
		$o = self::opts();
		if ( self::is_locked() ) {
			return self::deny( 'lockdown', __( 'قفل اضطراری فعال است.', 'emzagar' ) );
		}
		if ( (int) $o['user_hour'] > 0 && self::bump( 'us_' . (int) $user_id . '_' . self::day() . '_' . wp_date( 'H' ) ) > (int) $o['user_hour'] ) {
			return self::deny( 'user', __( 'سقف درخواست در ساعت پر شده است.', 'emzagar' ) );
		}
		return self::check( 'request', $email );
	}

	/** اطلاع‌رسانی قفل خودکار: صندوق فعالیت + ایمیل (فقط یک‌بار در هر قفل) */
	private static function announce_lock( $o ) {
		Emzagar_Inbox::add( 'info', __( 'قفل اضطراری خودکار فعال شد', 'emzagar' ), __( 'موج غیرعادی ارسال فرم شناسایی شد. صدور از فرم‌ها موقتاً متوقف است.', 'emzagar' ) );
		if ( 'yes' === $o['notify'] && ! get_transient( 'emz_lock_mail' ) ) {
			set_transient( 'emz_lock_mail', 1, HOUR_IN_SECONDS );
			wp_mail(
				get_option( 'admin_email' ),
				'[' . wp_strip_all_tags( get_bloginfo( 'name' ) ) . '] ' . __( 'قفل اضطراری امضاگیر فعال شد', 'emzagar' ),
				__( 'تعداد ارسال فرم‌ها در ۱۰ دقیقه از آستانه گذشت و صدور خودکار قرارداد از فرم‌ها موقتاً متوقف شد. اگر ترافیک واقعی بوده، از «امضاگیر ← تنظیمات ← محدودیت و امنیت» قفل را باز کنید.', 'emzagar' ) . "\n" . Emzagar_Settings::tab_url( 'limits' )
			);
		}
	}

	/* ───────────── آمار ───────────── */

	public static function stats() {
		$o   = self::opts();
		$day = self::day();
		$lk  = self::lock_state();
		return array(
			'issuedToday'  => self::peek( 'd_' . $day ),
			'blockedToday' => self::peek( 'b_' . $day ),
			'dailyCap'     => (int) $o['daily_cap'],
			'locked'       => (bool) $lk['active'],
			'lockMode'     => $lk['mode'],
			'lockReason'   => $lk['reason'],
			'lockUntil'    => (int) $lk['until'],
		);
	}

	/* ───────────── مدیریت ───────────── */

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	public static function act_save() {
		self::guard( 'emzagar_limits_save' );
		update_option( self::OPT, self::sanitize( isset( $_POST['lim'] ) && is_array( $_POST['lim'] ) ? wp_unslash( $_POST['lim'] ) : array() ), false ); // phpcs:ignore WordPress.Security.NonceVerification.Missing, WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- در guard بررسی و در sanitize پاک‌سازی می‌شود
		wp_safe_redirect( add_query_arg( 'emz_l', 'saved', Emzagar_Settings::tab_url( 'limits' ) ) );
		exit;
	}

	public static function act_lockdown() {
		self::guard( 'emzagar_lockdown' );
		$mode = isset( $_GET['mode'] ) ? sanitize_key( wp_unslash( $_GET['mode'] ) ) : 'on';
		$user = wp_get_current_user();
		if ( 'off' === $mode ) {
			self::unlock();
		} else {
			self::lock( 'manual', __( 'فعال‌شده توسط مدیر', 'emzagar' ), 0, $user->user_login );
		}
		$back = isset( $_GET['back'] ) ? esc_url_raw( wp_unslash( $_GET['back'] ) ) : '';
		$back = $back ? wp_validate_redirect( $back, Emzagar_Settings::tab_url( 'limits' ) ) : Emzagar_Settings::tab_url( 'limits' );
		wp_safe_redirect( add_query_arg( 'emz_l', 'off' === $mode ? 'unlocked' : 'locked', $back ) );
		exit;
	}

	public static function lock_link( $mode, $back = '' ) {
		$args = 'action=emzagar_lockdown&mode=' . rawurlencode( $mode );
		if ( '' !== $back ) {
			$args .= '&back=' . rawurlencode( $back );
		}
		return wp_nonce_url( admin_url( 'admin-post.php?' . $args ), 'emzagar_lockdown' );
	}

	public static function notice() {
		if ( ! current_user_can( 'manage_options' ) || ! self::is_locked() ) {
			return;
		}
		$s = self::lock_state();
		printf(
			'<div class="notice notice-error"><p><strong>%s</strong> %s <a class="button button-small" href="%s">%s</a></p></div>',
			esc_html__( 'قفل اضطراری امضاگیر فعال است.', 'emzagar' ),
			esc_html( 'auto' === $s['mode'] ? sprintf( /* translators: %s: time */ __( 'تا %s (خودکار باز می‌شود). صدور از فرم‌ها متوقف است.', 'emzagar' ), wp_date( 'H:i', (int) $s['until'] ) ) : __( 'صدور از فرم‌ها تا باز کردن دستی متوقف است.', 'emzagar' ) ),
			esc_url( self::lock_link( 'off', admin_url( 'admin.php?page=emzagar' ) ) ),
			esc_html__( 'باز کردن قفل', 'emzagar' )
		);
	}

	public static function bar_style() {
		if ( ! is_admin_bar_showing() ) {
			return;
		}
		echo '<style>#wp-admin-bar-emzagar-lock>.ab-item{background:#b32d2e!important;color:#fff!important}#wp-admin-bar-emzagar-lock .ab-icon:before{content:"\f160";top:2px}</style>';
	}

	public static function admin_bar( $bar ) {
		if ( ! current_user_can( 'manage_options' ) || ! self::is_locked() ) {
			return;
		}
		$bar->add_node(
			array(
				'id'    => 'emzagar-lock',
				'title' => '<span class="ab-icon"></span><span class="ab-label">' . esc_html__( 'قفل اضطراری فعال', 'emzagar' ) . '</span>',
				'href'  => Emzagar_Settings::tab_url( 'limits' ),
			)
		);
	}

	/** تب «محدودیت و امنیت» */
	public static function render_tab() {
		$o    = self::opts();
		$st   = self::stats();
		$lk   = self::lock_state();
		$code = isset( $_GET['emz_l'] ) ? sanitize_key( wp_unslash( $_GET['emz_l'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$msgs = array(
			'saved'    => __( 'محدودیت‌ها ذخیره شد.', 'emzagar' ),
			'locked'   => __( 'قفل اضطراری فعال شد.', 'emzagar' ),
			'unlocked' => __( 'قفل اضطراری باز شد.', 'emzagar' ),
		);
		if ( isset( $msgs[ $code ] ) ) {
			printf( '<div class="notice notice-success is-dismissible"><p>%s</p></div>', esc_html( $msgs[ $code ] ) );
		}
		$name = self::OPT;
		?>
		<section class="emz-card emz-lock <?php echo $st['locked'] ? 'is-locked' : ''; ?>">
			<div class="emz-lock-head">
				<span class="emz-lamp <?php echo $st['locked'] ? 'is-red' : 'is-green'; ?>" aria-hidden="true"></span>
				<div>
					<h2><?php echo $st['locked'] ? esc_html__( 'قفل اضطراری فعال است', 'emzagar' ) : esc_html__( 'قفل اضطراری خاموش است', 'emzagar' ); ?></h2>
					<p class="description">
						<?php
						if ( $st['locked'] ) {
							echo esc_html( $lk['reason'] );
							if ( 'auto' === $lk['mode'] ) {
								echo ' — ' . esc_html( sprintf( /* translators: %s: time */ __( 'باز شدن خودکار: %s', 'emzagar' ), wp_date( 'H:i', (int) $lk['until'] ) ) );
							}
						} else {
							esc_html_e( 'در حمله‌ی اسپم، با یک کلیک صدور قرارداد از فرم‌های عمومی را متوقف کنید. خریدهای ووکامرس و کار تیم شما متوقف نمی‌شود.', 'emzagar' );
						}
						?>
					</p>
				</div>
				<div class="emz-lock-btn">
					<?php if ( $st['locked'] ) : ?>
						<a class="button button-primary button-hero" href="<?php echo esc_url( self::lock_link( 'off' ) ); ?>"><?php esc_html_e( 'باز کردن قفل', 'emzagar' ); ?></a>
					<?php else : ?>
						<a class="button button-hero emz-btn-danger" href="<?php echo esc_url( self::lock_link( 'on' ) ); ?>" onclick="return confirm('<?php echo esc_js( __( 'صدور قرارداد از فرم‌ها متوقف شود؟', 'emzagar' ) ); ?>')"><?php esc_html_e( '🛑 فعال‌کردن قفل اضطراری', 'emzagar' ); ?></a>
					<?php endif; ?>
				</div>
			</div>
			<div class="emz-stats">
				<div><b><?php echo (int) $st['issuedToday']; ?></b><span><?php esc_html_e( 'صدور از فرم‌ها امروز', 'emzagar' ); ?></span></div>
				<div><b><?php echo $st['dailyCap'] > 0 ? (int) $st['dailyCap'] : '∞'; ?></b><span><?php esc_html_e( 'سقف روزانه', 'emzagar' ); ?></span></div>
				<div><b><?php echo (int) $st['blockedToday']; ?></b><span><?php esc_html_e( 'مسدودشده امروز', 'emzagar' ); ?></span></div>
			</div>
		</section>

		<section class="emz-card">
			<h2><?php esc_html_e( 'سقف‌های ارسال فرم', 'emzagar' ); ?></h2>
			<p class="description"><?php esc_html_e( 'علاوه بر نادیده‌گرفتن ارسال تکراری (همان ایمیل و قالب در ۱۰ دقیقه)، این سقف‌ها جلوی سوءاستفاده و اسپم را می‌گیرند. «۰» یعنی بدون محدودیت.', 'emzagar' ); ?></p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="emzagar_limits_save">
				<?php wp_nonce_field( 'emzagar_limits_save' ); ?>
				<table class="form-table" role="presentation"><tbody>
					<tr><th><label for="emz-l-d"><?php esc_html_e( 'سقف روزانه‌ی قرارداد از فرم‌ها', 'emzagar' ); ?></label></th><td><input id="emz-l-d" type="number" min="0" class="small-text" name="lim[daily_cap]" value="<?php echo (int) $o['daily_cap']; ?>"> <span class="description"><?php esc_html_e( 'پس از رسیدن به سقف، تا فردا قراردادی از فرم‌ها صادر نمی‌شود.', 'emzagar' ); ?></span></td></tr>
					<tr><th><label for="emz-l-i"><?php esc_html_e( 'هر IP در ساعت', 'emzagar' ); ?></label></th><td><input id="emz-l-i" type="number" min="0" class="small-text" name="lim[ip_hour]" value="<?php echo (int) $o['ip_hour']; ?>"></td></tr>
					<tr><th><label for="emz-l-e"><?php esc_html_e( 'هر ایمیل در روز', 'emzagar' ); ?></label></th><td><input id="emz-l-e" type="number" min="0" class="small-text" name="lim[email_day]" value="<?php echo (int) $o['email_day']; ?>"></td></tr>
					<tr><th><label for="emz-l-u"><?php esc_html_e( 'هر کاربر در ساعت (شورت‌کد درخواست قرارداد)', 'emzagar' ); ?></label></th><td><input id="emz-l-u" type="number" min="0" class="small-text" name="lim[user_hour]" value="<?php echo (int) $o['user_hour']; ?>"></td></tr>
					<tr><th><label for="emz-l-b"><?php esc_html_e( 'قفل خودکار هنگام موج ناگهانی', 'emzagar' ); ?></label></th><td>
						<input id="emz-l-b" type="number" min="0" class="small-text" name="lim[burst]" value="<?php echo (int) $o['burst']; ?>"> <span class="description"><?php esc_html_e( 'تلاش در ۱۰ دقیقه؛ بیشتر از این یعنی احتمالاً حمله (۰ = خاموش).', 'emzagar' ); ?></span><br>
						<input type="number" min="5" class="small-text" name="lim[lock_minutes]" value="<?php echo (int) $o['lock_minutes']; ?>"> <span class="description"><?php esc_html_e( 'دقیقه قفل بماند', 'emzagar' ); ?></span>
					</td></tr>
					<tr><th><?php esc_html_e( 'اطلاع‌رسانی', 'emzagar' ); ?></th><td><label><input type="checkbox" name="lim[notify]" value="yes" <?php checked( 'yes', $o['notify'] ); ?>> <?php esc_html_e( 'هنگام قفل خودکار به ایمیل مدیر خبر بده', 'emzagar' ); ?></label></td></tr>
				</tbody></table>
				<?php submit_button( __( 'ذخیره‌ی محدودیت‌ها', 'emzagar' ) ); ?>
			</form>
			<p class="description"><?php esc_html_e( 'نکته: پشت Cloudflare یا پراکسی، IP واقعی بازدیدکننده را با فیلتر emzagar_client_ip تنظیم کنید.', 'emzagar' ); ?></p>
		</section>
		<?php
		unset( $name );
	}
}
