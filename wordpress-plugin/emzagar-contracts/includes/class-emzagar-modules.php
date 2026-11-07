<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * کلید فعال/غیرفعال (Feature Flag) برای هر ماژول + «مدار شکن» (Circuit Breaker).
 *
 * هدف: اگر یک ماژول با افزونه‌ی دیگری تداخل کرد، فقط همان ماژول خاموش می‌شود و کل سیستم از کار نمی‌افتد.
 *
 *  • هر ماژول اختیاری یک کلید روشن/خاموش مستقل دارد (تب «ماژول‌ها» در تنظیمات).
 *  • خطای مرگبار (Fatal) داخل فایل یک ماژول → همان ماژول خودکار خاموش می‌شود و به مدیر اطلاع داده می‌شود.
 *  • استثناهای قابل‌گرفتن در زمان راه‌اندازی هر ماژول گرفته و ثبت می‌شوند (سایت بالا می‌ماند).
 *  • «حالت امن»: همه‌ی ماژول‌های اختیاری یک‌جا خاموش می‌شوند (فقط اتصال به ابر و تنظیمات می‌ماند).
 *  • قفل از بیرون (بدون ورود به پیشخوان): در wp-config.php
 *        define( 'EMZAGAR_SAFE_MODE', true );
 *        define( 'EMZAGAR_DISABLE_MODULES', 'automations,forms' );
 *
 * هسته (اتصال، تنظیمات، وضعیت سیستم، خروجی داده، محدودیت نرخ) هرگز خاموش نمی‌شود.
 */
class Emzagar_Modules {

	const OPT     = 'emzagar_modules';
	const OPT_ERR = 'emzagar_module_errors';

	/** ماژولی که هم‌اکنون در حال راه‌اندازی است (برای تشخیص عامل خطا) */
	private static $booting = '';

	/** تعریف ماژول‌ها به ترتیب راه‌اندازی */
	public static function registry() {
		return array(
			'sync'       => array(
				'label' => __( 'همگام‌سازی دوطرفه و دریافت رویداد', 'emzagar' ),
				'desc'  => __( 'ارسال سفارش و مشتری به ابر و دریافت رویدادهای امضا. توجه: با خاموش‌شدن آن، اعلان‌ها و اتوماسیون‌ها رویداد جدید دریافت نمی‌کنند.', 'emzagar' ),
				'class' => 'Emzagar_Sync',
				'file'  => 'class-emzagar-sync.php',
				'icon'  => '⇄',
				'warn'  => true,
			),
			'access'     => array(
				'label' => __( 'دروازه‌ی قرارداد و نقش خودکار', 'emzagar' ),
				'desc'  => __( 'قفل محتوا/محصول تا امضای قرارداد، نقش کاربری پس از امضا و شاخص محلی امضاها.', 'emzagar' ),
				'class' => 'Emzagar_Access',
				'file'  => 'class-emzagar-access.php',
				'icon'  => '🔒',
			),
			'hub'        => array(
				'label' => __( 'مرکز فرماندهی کسب‌وکار', 'emzagar' ),
				'desc'  => __( 'ویجت پیشخوان، نشان زنده‌ی نوار مدیریت، گزارش هفتگی، نشان اعتماد و آزمون سلامت سایت.', 'emzagar' ),
				'class' => 'Emzagar_Hub',
				'file'  => 'class-emzagar-hub.php',
				'icon'  => '📊',
			),
			'inbox'      => array(
				'label' => __( 'اعلان زنده و صندوق فعالیت', 'emzagar' ),
				'desc'  => __( 'اعلان لحظه‌ای امضا (Toast) با Heartbeat وردپرس، زنگ فعالیت و فهرست وظایف.', 'emzagar' ),
				'class' => 'Emzagar_Inbox',
				'file'  => 'class-emzagar-inbox.php',
				'icon'  => '🔔',
			),
			'workspace'  => array(
				'label' => __( 'میز کار قراردادها (کانبان)', 'emzagar' ),
				'desc'  => __( 'برد کانبان، فهرست قراردادها، کشوی جزئیات، صدور و دانلود PDF داخل پیشخوان.', 'emzagar' ),
				'class' => 'Emzagar_Workspace',
				'file'  => 'class-emzagar-workspace.php',
				'icon'  => '🗂️',
			),
			'palette'    => array(
				'label' => __( 'پالت فرمان Ctrl+K', 'emzagar' ),
				'desc'  => __( 'جستجو و پرش سریع در همه‌ی بخش‌های پیشخوان.', 'emzagar' ),
				'class' => 'Emzagar_Palette',
				'file'  => 'class-emzagar-palette.php',
				'icon'  => '⌘',
			),
			'automations' => array(
				'label' => __( 'اتوماسیون «اگر … آنگاه»', 'emzagar' ),
				'desc'  => __( 'اجرای خودکار قوانین پس از امضا، رد، انقضا و صدور قرارداد. (قوانین ذخیره می‌مانند و پس از روشن‌شدن دوباره کار می‌کنند.)', 'emzagar' ),
				'class' => 'Emzagar_Automations',
				'file'  => 'class-emzagar-automations.php',
				'icon'  => '⚡',
			),
			'forms'      => array(
				'label' => __( 'اتصال فرم‌ها به قرارداد', 'emzagar' ),
				'desc'  => __( 'صدور خودکار قرارداد با ارسال فرم (CF7، WPForms، Gravity، Elementor Pro، Fluent Forms).', 'emzagar' ),
				'class' => 'Emzagar_Forms',
				'file'  => 'class-emzagar-forms.php',
				'icon'  => '📝',
			),
			'shortcodes' => array(
				'label' => __( 'شورت‌کدها و داشبورد مشتری', 'emzagar' ),
				'desc'  => __( '[emzagar_dashboard]، [emzagar_stats] و [emzagar_request_contract] در صفحات سایت.', 'emzagar' ),
				'class' => 'Emzagar_Shortcodes',
				'file'  => 'class-emzagar-shortcodes.php',
				'icon'  => '🧩',
			),
			'woocommerce' => array(
				'label' => __( 'یکپارچگی ووکامرس', 'emzagar' ),
				'desc'  => __( 'صدور خودکار قرارداد پس از خرید، تب «قراردادها» در حساب کاربری و قفل دانلود.', 'emzagar' ),
				'class' => 'Emzagar_WooCommerce',
				'file'  => 'class-emzagar-woocommerce.php',
				'icon'  => '🛒',
				'needs' => 'WooCommerce',
			),
			'order_ui'   => array(
				'label' => __( 'جعبه و ستون قرارداد در سفارش‌ها', 'emzagar' ),
				'desc'  => __( 'نمایش وضعیت امضا در فهرست و صفحه‌ی سفارش و اقدام گروهی.', 'emzagar' ),
				'class' => 'Emzagar_Order_UI',
				'file'  => 'class-emzagar-order-ui.php',
				'icon'  => '📦',
				'needs' => 'WooCommerce',
			),
			'elementor'  => array(
				'label' => __( 'ویجت‌های المنتور', 'emzagar' ),
				'desc'  => __( 'دسته‌ی «امضاگیر» و ویجت‌ها در ویرایشگر المنتور.', 'emzagar' ),
				'class' => 'Emzagar_Elementor',
				'file'  => 'class-emzagar-elementor.php',
				'icon'  => '🎨',
				'needs' => 'Elementor\Plugin',
			),
		);
	}

	/* ───────────── وضعیت ───────────── */

	/** فهرست خاموش‌شده‌ها از wp-config */
	private static function forced_off() {
		$list = array();
		if ( defined( 'EMZAGAR_DISABLE_MODULES' ) && is_string( EMZAGAR_DISABLE_MODULES ) ) {
			$list = array_filter( array_map( 'sanitize_key', explode( ',', EMZAGAR_DISABLE_MODULES ) ) );
		}
		return $list;
	}

	public static function safe_mode() {
		return defined( 'EMZAGAR_SAFE_MODE' ) && EMZAGAR_SAFE_MODE;
	}

	/** مقدار ذخیره‌شده‌ی کلیدها: id => 'yes'|'no' */
	public static function saved() {
		$s = get_option( self::OPT, array() );
		return is_array( $s ) ? $s : array();
	}

	/** آیا ماژول روشن است؟ (همه‌ی لایه‌ها: safe mode، wp-config، تنظیمات، فیلتر) */
	public static function on( $id ) {
		$reg = self::registry();
		if ( ! isset( $reg[ $id ] ) ) {
			return true; // ماژول هسته
		}
		if ( self::safe_mode() || in_array( $id, self::forced_off(), true ) ) {
			return false;
		}
		$saved = self::saved();
		$on    = ! isset( $saved[ $id ] ) || 'no' !== $saved[ $id ];
		/**
		 * امکان خاموش/روشن‌کردن ماژول از کد (مثلاً برای رفع تداخل در قالب).
		 *
		 * @param bool   $on روشن؟
		 * @param string $id شناسه‌ی ماژول
		 */
		return (bool) apply_filters( 'emzagar_module_enabled', $on, $id );
	}

	/** وضعیت نمایشی: on | off | locked | auto | missing */
	public static function state( $id ) {
		$reg = self::registry();
		if ( ! isset( $reg[ $id ] ) ) {
			return 'on';
		}
		if ( self::safe_mode() || in_array( $id, self::forced_off(), true ) ) {
			return 'locked';
		}
		$errs  = self::errors();
		$saved = self::saved();
		if ( isset( $errs[ $id ] ) && isset( $saved[ $id ] ) && 'no' === $saved[ $id ] && ! empty( $errs[ $id ]['auto'] ) ) {
			return 'auto';
		}
		if ( ! self::on( $id ) ) {
			return 'off';
		}
		if ( ! empty( $reg[ $id ]['needs'] ) && ! class_exists( $reg[ $id ]['needs'] ) ) {
			return 'missing';
		}
		return 'on';
	}

	public static function errors() {
		$e = get_option( self::OPT_ERR, array() );
		return is_array( $e ) ? $e : array();
	}

	public static function active_ids() {
		$out = array();
		foreach ( array_keys( self::registry() ) as $id ) {
			if ( self::on( $id ) ) {
				$out[] = $id;
			}
		}
		return $out;
	}

	/* ───────────── راه‌اندازی ───────────── */

	/** راه‌اندازی همه‌ی ماژول‌های روشن، هر کدام در یک پوسته‌ی امن */
	public static function boot() {
		register_shutdown_function( array( __CLASS__, 'on_shutdown' ) );
		foreach ( self::registry() as $id => $m ) {
			if ( ! self::on( $id ) ) {
				continue;
			}
			self::$booting = $id;
			try {
				call_user_func( array( $m['class'], 'init' ) );
			} catch ( \Throwable $e ) { // phpcs:ignore PHPCompatibility.Keywords.NewKeywords.t_throwableFound
				self::trip( $id, $e->getMessage(), $e->getFile(), $e->getLine(), true );
			}
			self::$booting = '';
		}
	}

	/** خطای مرگبار: اگر در فایل یکی از ماژول‌ها رخ داده باشد همان ماژول خاموش می‌شود */
	public static function on_shutdown() {
		$e = error_get_last();
		if ( ! $e || ! in_array( $e['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_RECOVERABLE_ERROR ), true ) ) {
			return;
		}
		$file = str_replace( '\\', '/', (string) $e['file'] );
		$dir  = str_replace( '\\', '/', EMZ_DIR );
		if ( 0 !== strpos( $file, $dir ) ) {
			return; // خطا مربوط به افزونه‌ی دیگری است
		}
		$id = self::module_for_file( $file );
		if ( '' === $id && '' !== self::$booting ) {
			$id = self::$booting;
		}
		if ( '' === $id ) {
			return; // هسته: خاموش‌شدنی نیست
		}
		self::trip( $id, (string) $e['message'], (string) $e['file'], (int) $e['line'], true );
	}

	private static function module_for_file( $file ) {
		if ( false !== strpos( $file, '/includes/elementor/' ) ) {
			return 'elementor';
		}
		$base = basename( $file );
		foreach ( self::registry() as $id => $m ) {
			if ( $m['file'] === $base ) {
				return $id;
			}
		}
		return '';
	}

	/** ثبت خطا و خاموش‌کردن خودکار ماژول */
	public static function trip( $id, $msg, $file = '', $line = 0, $disable = true ) {
		$reg = self::registry();
		if ( ! isset( $reg[ $id ] ) ) {
			return;
		}
		$errs        = self::errors();
		$errs[ $id ] = array(
			'ts'   => time(),
			'msg'  => mb_substr( wp_strip_all_tags( (string) $msg ), 0, 300 ),
			'file' => str_replace( str_replace( '\\', '/', EMZ_DIR ), '', str_replace( '\\', '/', (string) $file ) ),
			'line' => (int) $line,
			'auto' => (bool) $disable,
		);
		update_option( self::OPT_ERR, $errs, false );
		if ( $disable ) {
			$saved        = self::saved();
			$saved[ $id ] = 'no';
			update_option( self::OPT, $saved, false );
		}
	}

	/* ───────────── مدیریت ───────────── */

	public static function init_admin() {
		add_action( 'admin_post_emzagar_modules_save', array( __CLASS__, 'act_save' ) );
		add_action( 'admin_post_emzagar_modules_safe', array( __CLASS__, 'act_safe' ) );
		add_action( 'admin_post_emzagar_modules_reset', array( __CLASS__, 'act_reset' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notice' ) );
	}

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	private static function back( $code ) {
		wp_safe_redirect( add_query_arg( 'emz_m', $code, Emzagar_Settings::tab_url( 'modules' ) ) );
		exit;
	}

	/** ذخیره‌ی کلیدها: چک‌باکس‌های تیک‌نخورده = خاموش */
	public static function apply( $on_ids ) {
		$saved = array();
		foreach ( array_keys( self::registry() ) as $id ) {
			$saved[ $id ] = in_array( $id, (array) $on_ids, true ) ? 'yes' : 'no';
		}
		$before = self::saved();
		update_option( self::OPT, $saved, false );
		// ماژولی که دستی دوباره روشن شد: خطای قدیمی پاک می‌شود
		$errs = self::errors();
		foreach ( $saved as $id => $v ) {
			if ( 'yes' === $v && isset( $errs[ $id ] ) ) {
				unset( $errs[ $id ] );
			}
		}
		update_option( self::OPT_ERR, $errs, false );
		if ( ( $before['woocommerce'] ?? 'yes' ) !== $saved['woocommerce'] ) {
			update_option( 'emzagar_flush_rewrite', 1, false );
		}
		Emzagar_Hub::invalidate();
	}

	public static function act_save() {
		self::guard( 'emzagar_modules_save' );
		$on = isset( $_POST['mod'] ) && is_array( $_POST['mod'] ) ? array_map( 'sanitize_key', wp_unslash( $_POST['mod'] ) ) : array(); // phpcs:ignore WordPress.Security.NonceVerification.Missing -- در guard بررسی شده
		self::apply( $on );
		self::back( 'saved' );
	}

	public static function act_safe() {
		self::guard( 'emzagar_modules_safe' );
		self::apply( array() );
		self::back( 'safe' );
	}

	public static function act_reset() {
		self::guard( 'emzagar_modules_reset' );
		self::apply( array_keys( self::registry() ) );
		delete_option( self::OPT_ERR );
		self::back( 'reset' );
	}

	/** اعلان در پیشخوان وقتی ماژولی خودکار خاموش شده است */
	public static function notice() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$reg = self::registry();
		foreach ( self::errors() as $id => $e ) {
			if ( empty( $e['auto'] ) || ! isset( $reg[ $id ] ) || 'auto' !== self::state( $id ) ) {
				continue;
			}
			printf(
				'<div class="notice notice-error"><p><strong>%s</strong> %s <a class="button button-small" href="%s">%s</a></p></div>',
				esc_html__( 'امضاگیر — سپر ایمنی فعال شد:', 'emzagar' ),
				esc_html(
					sprintf(
						/* translators: %s: module label */
						__( 'ماژول «%s» به‌خاطر یک خطای شدید (احتمالاً تداخل با افزونه یا قالب دیگر) خودکار خاموش شد؛ بقیه‌ی سیستم سالم و فعال است.', 'emzagar' ),
						$reg[ $id ]['label']
					)
				),
				esc_url( Emzagar_Settings::tab_url( 'modules' ) ),
				esc_html__( 'جزئیات و روشن‌کردن دوباره', 'emzagar' )
			);
			break; // هر بار فقط یک اعلان
		}
	}

	private static function notice_text( $code ) {
		$m = array(
			'saved' => array( 'success', __( 'تنظیمات ماژول‌ها ذخیره شد.', 'emzagar' ) ),
			'safe'  => array( 'warning', __( 'حالت امن فعال شد: همه‌ی ماژول‌های اختیاری خاموش‌اند.', 'emzagar' ) ),
			'reset' => array( 'success', __( 'همه‌ی ماژول‌ها دوباره روشن شدند.', 'emzagar' ) ),
		);
		return isset( $m[ $code ] ) ? $m[ $code ] : null;
	}

	/** تب «ماژول‌ها» */
	public static function render_tab() {
		$reg   = self::registry();
		$errs  = self::errors();
		$code  = isset( $_GET['emz_m'] ) ? sanitize_key( wp_unslash( $_GET['emz_m'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$notice = $code ? self::notice_text( $code ) : null;
		$labels = array(
			'on'      => array( 'emz-pill-ok', __( 'فعال', 'emzagar' ) ),
			'off'     => array( 'emz-pill-off', __( 'خاموش', 'emzagar' ) ),
			'auto'    => array( 'emz-pill-bad', __( 'خاموش خودکار (خطا)', 'emzagar' ) ),
			'locked'  => array( 'emz-pill-warn', __( 'قفل از wp-config', 'emzagar' ) ),
			'missing' => array( 'emz-pill-warn', __( 'افزونه‌ی وابسته نصب نیست', 'emzagar' ) ),
		);
		if ( $notice ) {
			printf( '<div class="notice notice-%s is-dismissible"><p>%s</p></div>', esc_attr( $notice[0] ), esc_html( $notice[1] ) );
		}
		if ( self::safe_mode() ) {
			echo '<div class="notice notice-warning"><p>' . esc_html__( 'ثابت EMZAGAR_SAFE_MODE در wp-config.php فعال است؛ همه‌ی ماژول‌های اختیاری خاموش‌اند. برای فعال‌سازی، آن خط را بردارید.', 'emzagar' ) . '</p></div>';
		}
		?>
		<section class="emz-card">
			<h2><?php esc_html_e( 'ماژول‌ها (کلید روشن/خاموش مستقل)', 'emzagar' ); ?></h2>
			<p class="description"><?php esc_html_e( 'اگر یکی از قابلیت‌ها با افزونه یا قالب دیگری تداخل کرد، فقط همان را خاموش کنید؛ بقیه‌ی سیستم بدون مشکل کار می‌کند. داده‌ها و قوانین با خاموش‌کردن پاک نمی‌شوند.', 'emzagar' ); ?></p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="emzagar_modules_save">
				<?php wp_nonce_field( 'emzagar_modules_save' ); ?>
				<div class="emz-mods">
					<?php
					foreach ( $reg as $id => $m ) :
						$st     = self::state( $id );
						$lock   = in_array( $st, array( 'locked' ), true );
						$checked = self::on( $id ) || 'locked' === $st;
						$checked = ( 'locked' === $st ) ? false : self::on( $id );
						?>
						<label class="emz-mod <?php echo esc_attr( 'is-' . $st ); ?>">
							<span class="emz-mod-ico" aria-hidden="true"><?php echo esc_html( $m['icon'] ); ?></span>
							<span class="emz-mod-body">
								<b><?php echo esc_html( $m['label'] ); ?></b>
								<small><?php echo esc_html( $m['desc'] ); ?></small>
								<?php if ( isset( $errs[ $id ] ) ) : ?>
									<small class="emz-mod-err" dir="ltr"><?php echo esc_html( wp_date( 'Y-m-d H:i', (int) $errs[ $id ]['ts'] ) . ' — ' . $errs[ $id ]['msg'] . ( $errs[ $id ]['file'] ? ' @ ' . $errs[ $id ]['file'] . ':' . (int) $errs[ $id ]['line'] : '' ) ); ?></small>
								<?php endif; ?>
							</span>
							<span class="emz-mod-state"><span class="emz-pill <?php echo esc_attr( $labels[ $st ][0] ); ?>"><?php echo esc_html( $labels[ $st ][1] ); ?></span></span>
							<span class="emz-switch">
								<input type="checkbox" name="mod[]" value="<?php echo esc_attr( $id ); ?>" <?php checked( $checked ); ?> <?php disabled( $lock ); ?> aria-label="<?php echo esc_attr( $m['label'] ); ?>">
								<i></i>
							</span>
						</label>
					<?php endforeach; ?>
				</div>
				<p class="emz-actions">
					<?php submit_button( __( 'ذخیره‌ی ماژول‌ها', 'emzagar' ), 'primary', 'submit', false ); ?>
					<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_modules_reset' ), 'emzagar_modules_reset' ) ); ?>"><?php esc_html_e( 'روشن‌کردن همه', 'emzagar' ); ?></a>
					<a class="button button-link-delete" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_modules_safe' ), 'emzagar_modules_safe' ) ); ?>" onclick="return confirm('<?php echo esc_js( __( 'همه‌ی ماژول‌های اختیاری خاموش شوند؟ (اتصال به ابر و تنظیمات می‌ماند)', 'emzagar' ) ); ?>')"><?php esc_html_e( 'حالت امن (خاموش‌کردن همه)', 'emzagar' ); ?></a>
				</p>
			</form>
		</section>
		<section class="emz-card">
			<h2><?php esc_html_e( 'اگر وارد پیشخوان نمی‌شوید', 'emzagar' ); ?></h2>
			<p class="description"><?php esc_html_e( 'یکی از خط‌های زیر را در wp-config.php (بالای خط «That\'s all, stop editing») بگذارید یا از WP-CLI استفاده کنید:', 'emzagar' ); ?></p>
			<pre class="emz-code" dir="ltr">define( 'EMZAGAR_SAFE_MODE', true );                         // all optional modules off
define( 'EMZAGAR_DISABLE_MODULES', 'automations,forms' );   // specific modules off

wp emzagar modules list
wp emzagar modules disable forms
wp emzagar modules enable forms</pre>
		</section>
		<?php
	}
}
