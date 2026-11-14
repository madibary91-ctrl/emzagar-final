<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * صفحه‌ی امضاگیر در پیشخوان: وضعیت اتصال (خودکار)، ورود یک‌کلیکی به پنل، تنظیمات ووکامرس.
 * کلید API و آدرس سرور فقط در بخش «پیشرفته» (برای کاربران حرفه‌ای / سرور اختصاصی) قرار دارد.
 */
class Emzagar_Settings {

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register' ) );
		add_action( 'wp_ajax_emzagar_test', array( __CLASS__, 'ajax_test' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'admin_notices', array( __CLASS__, 'notices' ) );
	}

	public static function tab_url( $tab = 'general' ) {
		return add_query_arg( array( 'page' => 'emzagar', 'tab' => $tab ), admin_url( 'admin.php' ) );
	}

	public static function tabs() {
		return array(
			'general' => __( 'عمومی', 'emzagar' ),
			'modules' => __( 'ماژول‌ها', 'emzagar' ),
			'limits'  => __( 'محدودیت و امنیت', 'emzagar' ),
			'data'    => __( 'داده‌ها و پشتیبان', 'emzagar' ),
			'license' => __( 'لایسنس و به‌روزرسانی', 'emzagar' ),
		);
	}

	public static function menu() {
		add_menu_page(
			__( 'امضاگیر', 'emzagar' ),
			__( 'امضاگیر', 'emzagar' ),
			'manage_options',
			'emzagar',
			array( __CLASS__, 'render' ),
			class_exists( 'Emzagar_Brand' ) ? Emzagar_Brand::menu_icon() : 'dashicons-edit-page',
			58
		);
	}

	public static function register() {
		register_setting(
			'emzagar_group',
			EMZ_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => array(),
			)
		);
	}

	/** اعتبارسنجی و پاک‌سازی؛ مقادیر اتصال (کلید، آدرس، وضعیت) هرگز با ارسال ناقص فرم از بین نمی‌روند */
	public static function sanitize( $in ) {
		$old = emzagar_options();
		$in  = is_array( $in ) ? $in : array();
		$out = $old;

		// ── بخش پیشرفته: اتصال دستی ──
		$base = isset( $in['base_url'] ) ? Emzagar_API::clean_base_url( $in['base_url'] ) : '';
		if ( '' !== $base && $base !== $old['base_url'] ) {
			if ( 0 !== strpos( $base, 'https://' ) && ! self::is_local( $base ) ) {
				add_settings_error( EMZ_OPTION, 'emz_https', __( 'برای امنیت، آدرس سرور باید با https:// شروع شود.', 'emzagar' ) );
			} else {
				$out['base_url'] = $base;
			}
		}

		$key = isset( $in['api_key'] ) ? trim( sanitize_text_field( $in['api_key'] ) ) : '';
		if ( '' === $key && $out['base_url'] !== $old['base_url'] ) {
			// کلید قبلی متعلق به سرور قبلی است؛ بدون کلید جدید آدرس تغییر نمی‌کند
			$out['base_url'] = $old['base_url'];
			add_settings_error( EMZ_OPTION, 'emz_base_key', __( 'با تغییر آدرس سرور، کلید API همان سرور را هم وارد کنید.', 'emzagar' ) );
		}
		if ( '' !== $key ) {
			if ( ! preg_match( '/^emz_[a-f0-9]{48}$/', $key ) ) {
				add_settings_error( EMZ_OPTION, 'emz_key', __( 'قالب کلید معتبر نیست (باید با emz_ شروع شود).', 'emzagar' ) );
			} else {
				$out['api_key']    = $key;
				$out['connection'] = 'manual';
				$out['workspace']  = '';
				$out['sso']        = 'no';
			}
		}
		if ( ! empty( $in['clear_key'] ) ) {
			$out['api_key']    = '';
			$out['connection'] = '';
			delete_option( Emzagar_Connect::OPT_NEXT );
		}
		$cloud = isset( $in['cloud_url'] ) ? Emzagar_API::clean_base_url( $in['cloud_url'] ) : '';
		if ( '' !== $cloud && Emzagar_Connect::is_acceptable_cloud( $cloud ) ) {
			$out['cloud_url'] = $cloud;
		}

		// ── تنظیمات عمومی و ووکامرس ──
		// ارسال فرم: چک‌باکس‌های تیک‌نخورده «no» می‌شوند. به‌روزرسانی برنامه‌نویسی‌شده (مثل اتصال خودکار): مقدار ورودی حفظ می‌شود.
		$is_form = isset( $_POST['option_page'] ) && 'emzagar_group' === $_POST['option_page']; // phpcs:ignore WordPress.Security.NonceVerification.Missing -- options.php قبلاً nonce را بررسی کرده است
		foreach ( array( 'wc_enabled', 'wc_all_orders', 'sync_orders', 'sync_customers', 'wc_hold_until_signed', 'wc_gate_downloads' ) as $flag ) {
			if ( $is_form ) {
				$out[ $flag ] = ! empty( $in[ $flag ] ) ? 'yes' : 'no';
			} elseif ( isset( $in[ $flag ] ) ) {
				$out[ $flag ] = ( 'yes' === $in[ $flag ] || true === $in[ $flag ] ) ? 'yes' : 'no';
			}
		}
		$out['cache_minutes']    = max( 0, min( 60, (int) ( isset( $in['cache_minutes'] ) ? $in['cache_minutes'] : $old['cache_minutes'] ) ) );
		$out['default_template'] = max( 0, (int) ( isset( $in['default_template'] ) ? $in['default_template'] : $old['default_template'] ) );
		$out['wc_trigger']       = ( isset( $in['wc_trigger'] ) && 'completed' === $in['wc_trigger'] ) ? 'completed' : 'processing';
		$out['wc_expiry_days']   = max( 0, min( 3650, (int) ( isset( $in['wc_expiry_days'] ) ? $in['wc_expiry_days'] : $old['wc_expiry_days'] ) ) );
		$out['wc_on_signed']     = ( isset( $in['wc_on_signed'] ) && in_array( $in['wc_on_signed'], array( 'none', 'processing', 'completed' ), true ) ) ? $in['wc_on_signed'] : $old['wc_on_signed'];
		$out['wc_on_reject']     = ( isset( $in['wc_on_reject'] ) && in_array( $in['wc_on_reject'], array( 'none', 'on-hold', 'cancelled' ), true ) ) ? $in['wc_on_reject'] : $old['wc_on_reject'];
		$accent                  = isset( $in['accent'] ) ? sanitize_hex_color( $in['accent'] ) : '';
		$out['accent']           = $accent ? $accent : $old['accent'];

		Emzagar_API::flush_cache();
		return $out;
	}

	private static function is_local( $url ) {
		$host = wp_parse_url( $url, PHP_URL_HOST );
		return in_array( $host, array( 'localhost', '127.0.0.1' ), true ) && defined( 'WP_DEBUG' ) && WP_DEBUG;
	}

	public static function assets( $hook ) {
		if ( 'toplevel_page_emzagar' !== $hook ) {
			return;
		}
		wp_enqueue_style( 'emzagar-admin', EMZ_URL . 'assets/css/emzagar.css', array(), EMZ_VERSION );
		wp_enqueue_style( 'emzagar-control', EMZ_URL . 'assets/css/control.css', array(), EMZ_VERSION );
		wp_enqueue_script( 'emzagar-admin', EMZ_URL . 'assets/js/admin.js', array(), EMZ_VERSION, true );
		wp_localize_script(
			'emzagar-admin',
			'EmzagarAdmin',
			array(
				'ajax'  => admin_url( 'admin-ajax.php' ),
				'nonce' => wp_create_nonce( 'emzagar_test' ),
				'wait'  => __( 'در حال بررسی…', 'emzagar' ),
				'sync'  => wp_create_nonce( 'emzagar_sync' ),
				'i18n'  => array(
					'working'  => __( 'در حال همگام‌سازی…', 'emzagar' ),
					'done'     => __( 'همگام‌سازی کامل شد ✓', 'emzagar' ),
					'failed'   => __( 'خطا در ارتباط؛ دوباره تلاش کنید.', 'emzagar' ),
					'orders'   => __( 'سفارش', 'emzagar' ),
				),
			)
		);
	}

	/** اعلان‌ها: پس از فعال‌سازی «آماده است» و در صورت قطع بودن، راهنمای ساده (بدون اصطلاح فنی) */
	public static function notices() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$screen  = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		$on_page = $screen && 'toplevel_page_emzagar' === $screen->id;
		$page    = admin_url( 'admin.php?page=emzagar' );

		if ( Emzagar_API::is_configured() ) {
			if ( get_transient( 'emzagar_just_activated' ) && ! $on_page ) {
				delete_transient( 'emzagar_just_activated' );
				printf(
					'<div class="notice notice-success is-dismissible"><p><strong>%s</strong> %s <a class="button button-primary" href="%s">%s</a> <a class="button" href="%s">%s</a></p></div>',
					esc_html__( 'امضاگیر آماده است ✓', 'emzagar' ),
					esc_html__( 'افزونه خودکار به سرویس وصل شد؛ نیازی به هیچ تنظیمی نیست.', 'emzagar' ),
					esc_url( Emzagar_Connect::panel_link( 'templates' ) ),
					esc_html__( 'ساخت اولین قرارداد', 'emzagar' ),
					esc_url( $page ),
					esc_html__( 'شروع سریع', 'emzagar' )
				);
			}
			return;
		}
		if ( $on_page ) {
			return;
		}
		printf(
			'<div class="notice notice-warning"><p>%s <a href="%s">%s</a></p></div>',
			esc_html__( 'امضاگیر هنوز وصل نشده است؛ افزونه در پس‌زمینه تلاش می‌کند.', 'emzagar' ),
			esc_url( $page ),
			esc_html__( 'مشاهده‌ی وضعیت', 'emzagar' )
		);
	}

	/** بررسی اتصال (فقط مدیر؛ با nonce) */
	public static function ajax_test() {
		check_ajax_referer( 'emzagar_test', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'دسترسی ندارید.', 'emzagar' ) ), 403 );
		}
		$res = Emzagar_API::request( 'GET', '/api/v1/stats' );
		if ( is_wp_error( $res ) ) {
			wp_send_json_error( array( 'message' => $res->get_error_message() ) );
		}
		wp_send_json_success(
			array(
				/* translators: %s: workspace name */
				'message' => sprintf( __( 'اتصال برقرار است ✓ — %s', 'emzagar' ), $res['workspace'] ),
			)
		);
	}

	/** فهرست قالب‌ها برای فیلد انتخاب (کش‌شده) */
	public static function templates() {
		$res = Emzagar_API::request( 'GET', '/api/v1/templates', array(), null, true );
		return is_wp_error( $res ) || empty( $res['items'] ) ? array() : $res['items'];
	}

	/* ───────────── نمایش ───────────── */

	private static function status_card( $o ) {
		$connected = Emzagar_API::is_configured();
		$auto      = 'manual' !== $o['connection'];
		$flag      = isset( $_GET['emz_connect'] ) ? sanitize_key( wp_unslash( $_GET['emz_connect'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		?>
		<div class="emz-status <?php echo $connected ? 'is-ok' : 'is-wait'; ?>">
			<?php if ( $connected ) : ?>
				<div class="emz-status-head">
					<span class="emz-dot" aria-hidden="true"></span>
					<div>
						<h2><?php esc_html_e( 'امضاگیر به سایت شما متصل است', 'emzagar' ); ?></h2>
						<p>
							<?php
							if ( ! empty( $o['workspace'] ) ) {
								/* translators: %s: workspace name */
								echo esc_html( sprintf( __( 'فضای کاری: %s', 'emzagar' ), $o['workspace'] ) );
							} else {
								esc_html_e( 'همه‌چیز آماده است؛ نیازی به تنظیم دیگری نیست.', 'emzagar' );
							}
							?>
						</p>
					</div>
				</div>
				<p class="emz-actions">
					<a class="button button-primary button-hero" href="<?php echo esc_url( Emzagar_Connect::panel_link( 'admin' ) ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'باز کردن پنل امضاگیر', 'emzagar' ); ?></a>
					<a class="button button-hero" href="<?php echo esc_url( Emzagar_Connect::panel_link( 'templates' ) ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'ویرایش قالب‌های قرارداد', 'emzagar' ); ?></a>
					<button type="button" class="button" id="emz-test"><?php esc_html_e( 'بررسی اتصال', 'emzagar' ); ?></button>
					<span id="emz-test-result" role="status" aria-live="polite"></span>
				</p>
				<?php if ( 'yes' !== $o['verified'] && $auto ) : ?>
					<p class="description"><?php esc_html_e( 'این سایت محلی/آزمایشی است؛ پس از انتقال به دامنه‌ی واقعی، اتصال خودکار تایید می‌شود.', 'emzagar' ); ?></p>
				<?php endif; ?>
			<?php else : ?>
				<div class="emz-status-head">
					<span class="emz-dot" aria-hidden="true"></span>
					<div>
						<h2><?php echo '' === Emzagar_Connect::cloud_url() ? esc_html__( 'نصب کامل نشده است', 'emzagar' ) : esc_html__( 'در حال اتصال…', 'emzagar' ); ?></h2>
						<p>
							<?php
							if ( '' === Emzagar_Connect::cloud_url() ) {
								esc_html_e( 'این نسخه‌ی افزونه آدرس سرویس را ندارد. افزونه را از پنل امضاگیر («وردپرس و ووکامرس») دانلود و نصب کنید تا خودکار وصل شود.', 'emzagar' );
							} else {
								esc_html_e( 'افزونه در حال برقراری ارتباط امن با سرویس است و معمولاً چند ثانیه طول می‌کشد. نیازی به وارد کردن کلید یا آدرس نیست.', 'emzagar' );
							}
							?>
						</p>
					</div>
				</div>
				<?php $err = Emzagar_Connect::last_error(); ?>
				<?php if ( $err ) : ?>
					<p class="emz-err" role="alert"><?php echo esc_html( $err ); ?></p>
				<?php endif; ?>
				<?php if ( 'fail' === $flag && ! $err ) : ?>
					<p class="emz-err" role="alert"><?php esc_html_e( 'اتصال انجام نشد؛ چند دقیقه بعد دوباره امتحان کنید.', 'emzagar' ); ?></p>
				<?php endif; ?>
				<?php if ( '' !== Emzagar_Connect::cloud_url() ) : ?>
					<p class="emz-actions"><a class="button button-primary button-hero" id="emz-reconnect" href="<?php echo esc_url( Emzagar_Connect::reconnect_link() ); ?>"><?php esc_html_e( 'اتصال دوباره', 'emzagar' ); ?></a></p>
				<?php endif; ?>
			<?php endif; ?>
		</div>
		<?php
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$tabs = self::tabs();
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'general'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$tab  = isset( $tabs[ $tab ] ) ? $tab : 'general';
		?>
		<div class="wrap emz-admin emz-ctl" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>">
			<h1><?php esc_html_e( 'امضاگیر — قرارداد و امضای آنلاین', 'emzagar' ); ?></h1>
			<?php Emzagar_Onboarding::banner(); ?>
			<h2 class="nav-tab-wrapper emz-tabs">
				<?php foreach ( $tabs as $k => $label ) : ?>
					<a class="nav-tab <?php echo $k === $tab ? 'nav-tab-active' : ''; ?>" href="<?php echo esc_url( self::tab_url( $k ) ); ?>"><?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
				<a class="nav-tab emz-tab-ext" href="<?php echo esc_url( Emzagar_Health::url() ); ?>">🩺 <?php esc_html_e( 'وضعیت سیستم', 'emzagar' ); ?></a>
			</h2>
			<?php
			if ( 'modules' === $tab ) {
				Emzagar_Modules::render_tab();
			} elseif ( 'limits' === $tab ) {
				Emzagar_Limits::render_tab();
			} elseif ( 'data' === $tab ) {
				Emzagar_Export::render_tab();
			} elseif ( 'license' === $tab ) {
				Emzagar_Updater::render_tab();
			} else {
				self::render_general();
			}
			?>
		</div>
		<?php
	}

	private static function render_general() {
		$o         = emzagar_options();
		$has_key   = ! empty( $o['api_key'] );
		$masked    = $has_key ? '••••••••' . substr( $o['api_key'], -4 ) : '';
		$templates = Emzagar_API::is_configured() ? self::templates() : array();
		$name      = EMZ_OPTION;
		$page_url  = ! empty( $o['page_id'] ) && 'publish' === get_post_status( (int) $o['page_id'] ) ? get_permalink( (int) $o['page_id'] ) : '';
		?>
		<div class="emz-general">
			<?php settings_errors( EMZ_OPTION ); ?>

			<?php self::status_card( $o ); ?>

			<div class="emz-quick">
				<h2><?php esc_html_e( 'شروع سریع', 'emzagar' ); ?></h2>
				<ol>
					<li>
						<?php if ( $page_url ) : ?>
							<?php esc_html_e( 'صفحه‌ی «قراردادهای من» برای مشتریان ساخته شد:', 'emzagar' ); ?> <a href="<?php echo esc_url( $page_url ); ?>" target="_blank" rel="noopener"><?php esc_html_e( 'مشاهده', 'emzagar' ); ?></a>
						<?php elseif ( class_exists( 'WooCommerce' ) ) : ?>
							<?php esc_html_e( 'تب «قراردادها» به «حساب کاربری من» ووکامرس اضافه شد (یک‌بار «تنظیمات ← پیوندهای یکتا ← ذخیره» را بزنید).', 'emzagar' ); ?>
						<?php else : ?>
							<?php esc_html_e( 'شورت‌کد [emzagar_dashboard] را در هر برگه‌ای بگذارید تا مشتری قراردادهایش را ببیند.', 'emzagar' ); ?>
						<?php endif; ?>
					</li>
					<li><?php esc_html_e( 'ووکامرس: در ویرایش هر محصول (تب «عمومی»)، «قالب قرارداد امضاگیر» را انتخاب کنید؛ پس از خرید، قرارداد خودکار برای مشتری صادر می‌شود.', 'emzagar' ); ?></li>
					<li><?php esc_html_e( 'المنتور: ویجت‌های دسته‌ی «امضاگیر» را بکشید و رها کنید.', 'emzagar' ); ?></li>
				</ol>
			</div>

			<form method="post" action="options.php" autocomplete="off">
				<?php settings_fields( 'emzagar_group' ); ?>

				<h2 class="title"><?php esc_html_e( 'ووکامرس', 'emzagar' ); ?></h2>
				<?php if ( ! class_exists( 'WooCommerce' ) ) : ?>
					<p class="description"><?php esc_html_e( 'ووکامرس فعال نیست؛ این بخش پس از نصب ووکامرس کار می‌کند.', 'emzagar' ); ?></p>
				<?php endif; ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'صدور خودکار قرارداد', 'emzagar' ); ?></th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[wc_enabled]" value="1" <?php checked( 'yes', $o['wc_enabled'] ); ?> /> <?php esc_html_e( 'پس از خرید، برای محصولاتی که قالب دارند قرارداد صادر شود', 'emzagar' ); ?></label>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="emz_trigger"><?php esc_html_e( 'زمان صدور', 'emzagar' ); ?></label></th>
						<td>
							<select id="emz_trigger" name="<?php echo esc_attr( $name ); ?>[wc_trigger]">
								<option value="processing" <?php selected( 'processing', $o['wc_trigger'] ); ?>><?php esc_html_e( 'پس از پرداخت (در حال انجام)', 'emzagar' ); ?></option>
								<option value="completed" <?php selected( 'completed', $o['wc_trigger'] ); ?>><?php esc_html_e( 'پس از تکمیل سفارش', 'emzagar' ); ?></option>
							</select>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="emz_tpl"><?php esc_html_e( 'قالب پیش‌فرض', 'emzagar' ); ?></label></th>
						<td>
							<?php if ( $templates ) : ?>
								<select id="emz_tpl" name="<?php echo esc_attr( $name ); ?>[default_template]">
									<option value="0"><?php esc_html_e( '— بدون قالب پیش‌فرض —', 'emzagar' ); ?></option>
									<?php foreach ( $templates as $t ) : ?>
										<option value="<?php echo esc_attr( $t['id'] ); ?>" <?php selected( (int) $o['default_template'], (int) $t['id'] ); ?>><?php echo esc_html( $t['title'] ); ?></option>
									<?php endforeach; ?>
								</select>
							<?php else : ?>
								<input type="hidden" name="<?php echo esc_attr( $name ); ?>[default_template]" value="<?php echo esc_attr( $o['default_template'] ); ?>" />
								<span class="description"><?php esc_html_e( 'پس از اتصال، فهرست قالب‌ها اینجا نمایش داده می‌شود.', 'emzagar' ); ?></span>
							<?php endif; ?>
							<br /><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[wc_all_orders]" value="1" <?php checked( 'yes', $o['wc_all_orders'] ); ?> /> <?php esc_html_e( 'برای محصولات بدون قالب هم از قالب پیش‌فرض استفاده شود', 'emzagar' ); ?></label>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="emz_exp"><?php esc_html_e( 'مهلت امضا (روز)', 'emzagar' ); ?></label></th>
						<td><input id="emz_exp" name="<?php echo esc_attr( $name ); ?>[wc_expiry_days]" type="number" min="0" max="3650" class="small-text" value="<?php echo esc_attr( $o['wc_expiry_days'] ); ?>" /> <span class="description"><?php esc_html_e( '۰ = بدون انقضا', 'emzagar' ); ?></span></td>
					</tr>
					<tr>
						<th scope="row"><label for="emz_accent"><?php esc_html_e( 'رنگ اصلی', 'emzagar' ); ?></label></th>
						<td><input id="emz_accent" name="<?php echo esc_attr( $name ); ?>[accent]" type="color" value="<?php echo esc_attr( $o['accent'] ); ?>" /></td>
					</tr>
				</table>

				<h2 class="title"><?php esc_html_e( 'همگام‌سازی دوطرفه و اتوماسیون سفارش', 'emzagar' ); ?></h2>
				<?php $sy = Emzagar_Sync::summary(); ?>
				<div class="emz-sync" id="emz-sync">
					<table class="widefat striped emz-sync-table">
						<tbody>
							<tr><th><?php esc_html_e( 'ارسال به ابر', 'emzagar' ); ?></th><td><span data-emz="lastFlush"><?php echo $sy['lastFlush'] ? esc_html( sprintf( /* translators: %s: time diff */ __( '%s پیش', 'emzagar' ), $sy['lastFlush'] ) ) : '—'; ?></span> · <?php esc_html_e( 'ارسال‌شده:', 'emzagar' ); ?> <b data-emz="sent"><?php echo (int) $sy['sent']; ?></b></td></tr>
							<tr><th><?php esc_html_e( 'دریافت از ابر', 'emzagar' ); ?></th><td><span data-emz="lastPull"><?php echo $sy['lastPull'] ? esc_html( sprintf( /* translators: %s: time diff */ __( '%s پیش', 'emzagar' ), $sy['lastPull'] ) ) : '—'; ?></span> · <?php esc_html_e( 'اعمال‌شده:', 'emzagar' ); ?> <b data-emz="received"><?php echo (int) $sy['received']; ?></b></td></tr>
							<tr><th><?php esc_html_e( 'صف', 'emzagar' ); ?></th><td><?php esc_html_e( 'محلی:', 'emzagar' ); ?> <b data-emz="queue"><?php echo (int) $sy['queue']; ?></b> · <?php esc_html_e( 'معلق در ابر:', 'emzagar' ); ?> <b data-emz="cloudPending"><?php echo (int) $sy['cloudPending']; ?></b></td></tr>
							<tr><th><?php esc_html_e( 'امنیت', 'emzagar' ); ?></th><td data-emz="secret"><?php echo $sy['secret'] ? esc_html__( 'امضای HMAC فعال است ✓', 'emzagar' ) : esc_html__( 'در انتظار دست‌دادن با ابر…', 'emzagar' ); ?></td></tr>
							<?php if ( $sy['lastError'] ) : ?>
								<tr><th><?php esc_html_e( 'آخرین خطا', 'emzagar' ); ?></th><td class="emz-err" data-emz="lastError"><?php echo esc_html( $sy['lastError'] ); ?></td></tr>
							<?php endif; ?>
						</tbody>
					</table>
					<p class="emz-actions">
						<?php if ( class_exists( 'WooCommerce' ) ) : ?>
							<button type="button" class="button button-primary" id="emz-backfill"><?php esc_html_e( 'همگام‌سازی کامل سفارش‌ها و مشتریان', 'emzagar' ); ?></button>
						<?php endif; ?>
						<button type="button" class="button" id="emz-sync-now"><?php esc_html_e( 'ارسال و دریافت همین حالا', 'emzagar' ); ?></button>
						<button type="button" class="button" id="emz-sync-rotate"><?php esc_html_e( 'دریافت مجدد کلید امضا', 'emzagar' ); ?></button>
						<span id="emz-sync-result" role="status" aria-live="polite"></span>
					</p>
					<div class="emz-progress" id="emz-progress" hidden><div class="emz-progress-bar" id="emz-progress-bar" style="width:<?php echo (int) $sy['percent']; ?>%"></div></div>
					<?php $slog = Emzagar_Sync::state()['log']; ?>
					<?php if ( ! empty( $slog ) ) : ?>
						<details class="emz-advanced"><summary><?php esc_html_e( 'گزارش اخیر همگام‌سازی', 'emzagar' ); ?></summary>
							<ul class="emz-log">
								<?php foreach ( array_slice( $slog, 0, 12 ) as $row ) : ?>
									<li class="<?php echo 'error' === $row['l'] ? 'is-error' : ''; ?>"><span><?php echo esc_html( wp_date( 'H:i:s', (int) $row['t'] ) ); ?></span> <?php echo esc_html( $row['m'] ); ?></li>
								<?php endforeach; ?>
							</ul>
						</details>
					<?php endif; ?>
				</div>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'داده‌های همگام‌شده', 'emzagar' ); ?></th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[sync_orders]" value="1" <?php checked( 'yes', $o['sync_orders'] ); ?> /> <?php esc_html_e( 'سفارش‌ها (وضعیت، مبلغ، اقلام) به پنل امضاگیر ارسال شود', 'emzagar' ); ?></label><br />
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[sync_customers]" value="1" <?php checked( 'yes', $o['sync_customers'] ); ?> /> <?php esc_html_e( 'مشخصات مشتریان (نام و موبایل) همگام شود', 'emzagar' ); ?></label>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'نگه‌داشتن سفارش تا امضا', 'emzagar' ); ?></th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[wc_hold_until_signed]" value="1" <?php checked( 'yes', $o['wc_hold_until_signed'] ); ?> /> <?php esc_html_e( 'سفارش پرداخت‌شده تا امضای قرارداد «در انتظار بررسی» بماند', 'emzagar' ); ?></label><br />
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[wc_gate_downloads]" value="1" <?php checked( 'yes', $o['wc_gate_downloads'] ); ?> /> <?php esc_html_e( 'دانلود محصولات مجازی فقط پس از امضا فعال شود', 'emzagar' ); ?></label>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="emz_on_signed"><?php esc_html_e( 'پس از امضای همه‌ی طرفین', 'emzagar' ); ?></label></th>
						<td>
							<select id="emz_on_signed" name="<?php echo esc_attr( $name ); ?>[wc_on_signed]">
								<option value="none" <?php selected( 'none', $o['wc_on_signed'] ); ?>><?php esc_html_e( 'فقط یادداشت (و آزادسازی سفارش نگه‌داشته‌شده)', 'emzagar' ); ?></option>
								<option value="processing" <?php selected( 'processing', $o['wc_on_signed'] ); ?>><?php esc_html_e( 'سفارش «در حال انجام» شود', 'emzagar' ); ?></option>
								<option value="completed" <?php selected( 'completed', $o['wc_on_signed'] ); ?>><?php esc_html_e( 'سفارش «تکمیل‌شده» شود', 'emzagar' ); ?></option>
							</select>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="emz_on_reject"><?php esc_html_e( 'پس از رد، انقضا یا لغو قرارداد', 'emzagar' ); ?></label></th>
						<td>
							<select id="emz_on_reject" name="<?php echo esc_attr( $name ); ?>[wc_on_reject]">
								<option value="none" <?php selected( 'none', $o['wc_on_reject'] ); ?>><?php esc_html_e( 'فقط یادداشت', 'emzagar' ); ?></option>
								<option value="on-hold" <?php selected( 'on-hold', $o['wc_on_reject'] ); ?>><?php esc_html_e( 'سفارش «در انتظار بررسی» شود', 'emzagar' ); ?></option>
								<option value="cancelled" <?php selected( 'cancelled', $o['wc_on_reject'] ); ?>><?php esc_html_e( 'سفارش لغو شود', 'emzagar' ); ?></option>
							</select>
						</td>
					</tr>
				</table>

				<details class="emz-advanced">
					<summary><?php esc_html_e( 'تنظیمات پیشرفته (فقط برای کاربران حرفه‌ای)', 'emzagar' ); ?></summary>
					<p class="description"><?php esc_html_e( 'به‌صورت عادی به این بخش نیازی نیست. فقط اگر سرویس امضاگیر را روی سرور اختصاصی خودتان اجرا می‌کنید، آدرس و کلید را دستی وارد کنید.', 'emzagar' ); ?></p>
					<table class="form-table" role="presentation">
						<tr>
							<th scope="row"><label for="emz_base"><?php esc_html_e( 'آدرس سرور', 'emzagar' ); ?></label></th>
							<td><input id="emz_base" name="<?php echo esc_attr( $name ); ?>[base_url]" type="url" class="regular-text" dir="ltr" placeholder="https://sign.example.com" value="<?php echo esc_attr( $o['base_url'] ); ?>" /></td>
						</tr>
						<tr>
							<th scope="row"><label for="emz_key"><?php esc_html_e( 'کلید API', 'emzagar' ); ?></label></th>
							<td>
								<span class="emz-key-wrap">
									<input id="emz_key" name="<?php echo esc_attr( $name ); ?>[api_key]" type="password" class="regular-text" dir="ltr" autocomplete="new-password" spellcheck="false" placeholder="<?php echo esc_attr( $has_key ? $masked : 'emz_…' ); ?>" value="" />
									<button type="button" class="button" id="emz-toggle-key"><?php esc_html_e( 'نمایش', 'emzagar' ); ?></button>
								</span>
								<p class="description"><?php esc_html_e( 'برای حفظ کلید فعلی، خالی بگذارید.', 'emzagar' ); ?></p>
								<?php if ( $has_key ) : ?>
									<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[clear_key]" value="1" /> <?php esc_html_e( 'حذف کلید فعلی و اتصال خودکار از نو', 'emzagar' ); ?></label>
								<?php endif; ?>
							</td>
						</tr>
						<?php if ( '' === Emzagar_Connect::cloud_url() ) : ?>
							<tr>
								<th scope="row"><label for="emz_cloud"><?php esc_html_e( 'آدرس سرویس برای اتصال خودکار', 'emzagar' ); ?></label></th>
								<td><input id="emz_cloud" name="<?php echo esc_attr( $name ); ?>[cloud_url]" type="url" class="regular-text" dir="ltr" placeholder="https://app.example.com" value="<?php echo esc_attr( $o['cloud_url'] ); ?>" /></td>
							</tr>
						<?php endif; ?>
						<tr>
							<th scope="row"><label for="emz_cache"><?php esc_html_e( 'مدت کش (دقیقه)', 'emzagar' ); ?></label></th>
							<td>
								<input id="emz_cache" name="<?php echo esc_attr( $name ); ?>[cache_minutes]" type="number" min="0" max="60" class="small-text" value="<?php echo esc_attr( $o['cache_minutes'] ); ?>" />
								<span class="description"><?php esc_html_e( '۰ = بدون کش', 'emzagar' ); ?></span>
							</td>
						</tr>
					</table>
				</details>
				<?php submit_button(); ?>
			</form>

			<hr />
			<h2><?php esc_html_e( 'شورت‌کدها (سازگار با المنتور، گوتنبرگ و همه‌ی صفحه‌سازها)', 'emzagar' ); ?></h2>
			<div class="emz-table-scroll">
				<table class="widefat striped emz-codes">
					<tbody>
						<tr><td><code dir="ltr">[emzagar_dashboard]</code></td><td><?php esc_html_e( 'داشبورد قراردادهای کاربر واردشده؛ با آمار، فیلتر وضعیت و صفحه‌بندی. پارامترها: status، per_page، show_stats، scope="mine|all"، title', 'emzagar' ); ?></td></tr>
						<tr><td><code dir="ltr">[emzagar_stats]</code></td><td><?php esc_html_e( 'کارت‌های آمار (کل، امضا شده، در انتظار، نرخ تکمیل).', 'emzagar' ); ?></td></tr>
						<tr><td><code dir="ltr">[emzagar_request_contract template_id="12"]</code></td><td><?php esc_html_e( 'فرم درخواست قرارداد برای کاربر واردشده. پارامترها: template_id، button، title', 'emzagar' ); ?></td></tr>
					</tbody>
				</table>
			</div>
		</div>
		<?php
	}
}
