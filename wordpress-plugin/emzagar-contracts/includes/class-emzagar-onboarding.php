<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * ویزارد خوش‌آمدگویی (Onboarding Wizard).
 *
 * بلافاصله پس از فعال‌سازی افزونه، مدیر یک‌بار به این صفحه می‌رسد و قدم‌به‌قدم با
 * اتصال، میز کار کانبان، اتوماسیون، فرم‌ها و ایمنی/پشتیبان آشنا می‌شود. هر گام وضعیت واقعی را
 * (مثلاً «آیا قانونی ساخته‌ای؟») تشخیص می‌دهد و تیک می‌خورد. «راه‌اندازی یک‌کلیکی» سه دستور پرکاربرد را روشن می‌کند.
 * هر زمان از منوی «راهنمای شروع» می‌توان دوباره به آن برگشت.
 */
class Emzagar_Onboarding {

	const PAGE      = 'emzagar-welcome';
	const OPT       = 'emzagar_onboarding';
	const REDIRECT  = 'emzagar_welcome_redirect';

	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 15 ); // پس از ساخته‌شدن منوی والد
		add_action( 'admin_init', array( __CLASS__, 'maybe_redirect' ) );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		add_action( 'wp_ajax_emzagar_onboard_step', array( __CLASS__, 'ajax_step' ) );
		add_action( 'admin_post_emzagar_onboard_done', array( __CLASS__, 'act_done' ) );
		add_action( 'admin_post_emzagar_onboard_reset', array( __CLASS__, 'act_reset' ) );
		add_action( 'admin_post_emzagar_onboard_quick', array( __CLASS__, 'act_quick' ) );
	}

	public static function url( $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::PAGE ), $args ), admin_url( 'admin.php' ) );
	}

	public static function state() {
		$s = get_option( self::OPT, array() );
		return wp_parse_args( is_array( $s ) ? $s : array(), array( 'done' => false, 'step' => 0, 'completed_at' => 0 ) );
	}

	public static function is_done() {
		$s = self::state();
		return ! empty( $s['done'] );
	}

	/** پس از فعال‌سازی: فقط یک‌بار و فقط برای مدیر */
	public static function maybe_redirect() {
		if ( ! get_transient( self::REDIRECT ) ) {
			return;
		}
		delete_transient( self::REDIRECT );
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( wp_doing_ajax() || is_network_admin() || isset( $_GET['activate-multi'] ) || ! current_user_can( 'manage_options' ) || self::is_done() ) {
			return;
		}
		wp_safe_redirect( self::url() );
		exit;
	}

	public static function menu() {
		add_submenu_page( 'emzagar', __( 'راهنمای شروع', 'emzagar' ), __( 'راهنمای شروع', 'emzagar' ) . ( self::is_done() ? '' : ' <span class="awaiting-mod">!</span>' ), 'manage_options', self::PAGE, array( __CLASS__, 'render' ), 1 );
	}

	public static function assets( $hook ) {
		if ( false === strpos( (string) $hook, self::PAGE ) ) {
			return;
		}
		wp_enqueue_style( 'emzagar-control', EMZ_URL . 'assets/css/control.css', array(), EMZ_VERSION );
		wp_enqueue_script( 'emzagar-welcome', EMZ_URL . 'assets/js/welcome.js', array(), EMZ_VERSION, true );
		wp_localize_script(
			'emzagar-welcome',
			'EmzagarWelcome',
			array(
				'ajax'  => admin_url( 'admin-ajax.php' ),
				'nonce' => wp_create_nonce( 'emzagar_onboard' ),
				'step'  => (int) self::state()['step'],
			)
		);
	}

	/* ───────────── کنش‌ها ───────────── */

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	public static function ajax_step() {
		check_ajax_referer( 'emzagar_onboard', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array(), 403 );
		}
		$s         = self::state();
		$s['step'] = isset( $_POST['step'] ) ? max( 0, min( 5, absint( $_POST['step'] ) ) ) : 0;
		update_option( self::OPT, $s, false );
		wp_send_json_success();
	}

	public static function act_done() {
		self::guard( 'emzagar_onboard_done' );
		update_option( self::OPT, array( 'done' => true, 'step' => 5, 'completed_at' => time() ), false );
		wp_safe_redirect( Emzagar_Modules::on( 'hub' ) ? admin_url( 'admin.php?page=' . Emzagar_Hub::PAGE ) : admin_url( 'admin.php?page=emzagar' ) );
		exit;
	}

	public static function act_reset() {
		self::guard( 'emzagar_onboard_reset' );
		update_option( self::OPT, array( 'done' => false, 'step' => 0, 'completed_at' => 0 ), false );
		wp_safe_redirect( self::url() );
		exit;
	}

	/** راه‌اندازی یک‌کلیکی: سه دستور پرکاربرد روشن می‌شود */
	public static function act_quick() {
		self::guard( 'emzagar_onboard_quick' );
		$added = 0;
		foreach ( array( 'mail_admin_signed', 'welcome_customer', 'task_on_reject' ) as $key ) {
			if ( 'added' === Emzagar_Automations::add_recipe( $key ) ) {
				++$added;
			}
		}
		wp_safe_redirect( self::url( array( 'step' => 2, 'quick' => $added ) ) );
		exit;
	}

	/* ───────────── گام‌ها ───────────── */

	/** @return array<int,array{key:string,title:string,done:bool}> */
	public static function checklist() {
		$connected = Emzagar_API::is_configured();
		$ws        = (bool) get_option( 'emzagar_ws_used', 0 );
		$rules     = Emzagar_Automations::active_count() > 0;
		$forms     = Emzagar_Forms::active_count() > 0;
		$safety    = (bool) get_option( Emzagar_Export::OPT_LAST, false ) || false !== get_option( Emzagar_Limits::OPT, false );
		return array(
			array( 'key' => 'connect', 'title' => __( 'اتصال به ابر برقرار است', 'emzagar' ), 'done' => $connected ),
			array( 'key' => 'kanban', 'title' => __( 'میز کار قراردادها را باز کرده‌اید', 'emzagar' ), 'done' => $ws ),
			array( 'key' => 'auto', 'title' => __( 'حداقل یک اتوماسیون فعال است', 'emzagar' ), 'done' => $rules ),
			array( 'key' => 'forms', 'title' => __( 'حداقل یک فرم به قرارداد وصل شده', 'emzagar' ), 'done' => $forms ),
			array( 'key' => 'safety', 'title' => __( 'محدودیت‌ها یا پشتیبان‌گیری را مرور کرده‌اید', 'emzagar' ), 'done' => $safety ),
		);
	}

	private static function lamp( $ok ) {
		return Emzagar_Health::lamp( $ok ? 'ok' : 'off' );
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$start     = isset( $_GET['step'] ) ? max( 0, min( 5, absint( $_GET['step'] ) ) ) : (int) self::state()['step']; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$connected = Emzagar_API::is_configured();
		$list      = self::checklist();
		$done_n    = count( array_filter( wp_list_pluck( $list, 'done' ) ) );
		$quick     = isset( $_GET['quick'] ) ? absint( $_GET['quick'] ) : -1; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$titles    = array(
			__( 'خوش‌آمدید', 'emzagar' ),
			__( 'میز کار کانبان', 'emzagar' ),
			__( 'اتوماسیون', 'emzagar' ),
			__( 'فرم‌ها', 'emzagar' ),
			__( 'ایمنی و داده‌ها', 'emzagar' ),
			__( 'آماده‌اید', 'emzagar' ),
		);
		$recipes = Emzagar_Automations::recipes();
		?>
		<div class="wrap emz-ctl emz-welcome" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>" id="emz-welcome" data-start="<?php echo (int) $start; ?>">
			<h1 class="screen-reader-text"><?php esc_html_e( 'راهنمای شروع امضاگیر', 'emzagar' ); ?></h1>

			<header class="emz-hero">
				<div>
					<span class="emz-eyebrow"><?php echo esc_html( 'v' . EMZ_VERSION ); ?></span>
					<h2><?php esc_html_e( 'به امضاگیر خوش آمدید 👋', 'emzagar' ); ?></h2>
					<p><?php esc_html_e( 'در ۵ قدم کوتاه، قراردادهای سایتتان را خودکار، امن و قابل‌پیگیری می‌کنیم.', 'emzagar' ); ?></p>
				</div>
				<div class="emz-ring" style="--p:<?php echo (int) round( 100 * $done_n / max( 1, count( $list ) ) ); ?>" aria-label="<?php echo esc_attr( sprintf( /* translators: 1: done 2: total */ __( '%1$d از %2$d انجام شده', 'emzagar' ), $done_n, count( $list ) ) ); ?>"><b><?php echo (int) $done_n; ?>/<?php echo (int) count( $list ); ?></b></div>
			</header>

			<ol class="emz-steps" id="emz-steps" aria-label="<?php esc_attr_e( 'مراحل', 'emzagar' ); ?>">
				<?php foreach ( $titles as $i => $t ) : ?>
					<li><button type="button" data-go="<?php echo (int) $i; ?>"><span><?php echo (int) ( $i + 1 ); ?></span><?php echo esc_html( $t ); ?></button></li>
				<?php endforeach; ?>
			</ol>

			<!-- گام ۱ -->
			<section class="emz-pane" data-pane="0">
				<h2><?php esc_html_e( 'امضاگیر چه می‌کند؟', 'emzagar' ); ?></h2>
				<div class="emz-cols">
					<div class="emz-tile"><b>📝</b><h3><?php esc_html_e( 'صدور قرارداد', 'emzagar' ); ?></h3><p><?php esc_html_e( 'از فروشگاه، فرم‌ها یا دستی؛ مشتری لینک امضا می‌گیرد.', 'emzagar' ); ?></p></div>
					<div class="emz-tile"><b>🗂️</b><h3><?php esc_html_e( 'کانبان', 'emzagar' ); ?></h3><p><?php esc_html_e( 'همه‌ی قراردادها در یک برد؛ از ارسال تا امضا.', 'emzagar' ); ?></p></div>
					<div class="emz-tile"><b>⚡</b><h3><?php esc_html_e( 'اتوماسیون', 'emzagar' ); ?></h3><p><?php esc_html_e( 'اگر امضا شد، آنگاه ایمیل بزن، نقش بده، سفارش را تکمیل کن.', 'emzagar' ); ?></p></div>
				</div>
				<div class="emz-status-line">
					<?php echo self::lamp( $connected ); // phpcs:ignore WordPress.Security.EscapeOutput ?>
					<b><?php echo $connected ? esc_html__( 'به ابر متصل هستید ✓', 'emzagar' ) : esc_html__( 'هنوز به ابر وصل نشده‌اید؛ افزونه در پس‌زمینه تلاش می‌کند.', 'emzagar' ); ?></b>
					<a href="<?php echo esc_url( Emzagar_Health::url() ); ?>"><?php esc_html_e( 'وضعیت سیستم', 'emzagar' ); ?> ›</a>
				</div>
			</section>

			<!-- گام ۲ -->
			<section class="emz-pane" data-pane="1">
				<h2><?php esc_html_e( 'میز کار قراردادها (کانبان)', 'emzagar' ); ?></h2>
				<p><?php esc_html_e( 'هر قرارداد یک کارت است و با پیشرفت امضا از ستونی به ستون بعد می‌رود. روی کارت بزنید تا جزئیات، امضاکنندگان و خط زمانی را ببینید؛ از همان‌جا یادآوری بفرستید، لغو کنید یا PDF بگیرید.', 'emzagar' ); ?></p>
				<div class="emz-mini-kanban" aria-hidden="true">
					<div><h4><?php esc_html_e( 'ارسال‌شده', 'emzagar' ); ?></h4><i></i><i></i></div>
					<div><h4><?php esc_html_e( 'مشاهده‌شده', 'emzagar' ); ?></h4><i></i></div>
					<div class="ok"><h4><?php esc_html_e( 'امضاشده', 'emzagar' ); ?></h4><i></i><i></i><i></i></div>
					<div class="no"><h4><?php esc_html_e( 'ردشده/منقضی', 'emzagar' ); ?></h4><i></i></div>
				</div>
				<ul class="emz-tips">
					<li><?php esc_html_e( 'کلید Ctrl+K (یا ⌘K) در هر صفحه‌ی پیشخوان: جستجو و پرش سریع.', 'emzagar' ); ?></li>
					<li><?php esc_html_e( 'اعلان زنده: لحظه‌ی امضای مشتری، بدون رفرش خبردار می‌شوید.', 'emzagar' ); ?></li>
				</ul>
				<?php if ( Emzagar_Modules::on( 'workspace' ) ) : ?>
					<p><a class="button button-primary" href="<?php echo esc_url( Emzagar_Workspace::url() ); ?>"><?php esc_html_e( 'باز کردن میز کار', 'emzagar' ); ?></a></p>
				<?php else : ?>
					<p class="description"><?php esc_html_e( 'ماژول میز کار خاموش است (تنظیمات ← ماژول‌ها).', 'emzagar' ); ?></p>
				<?php endif; ?>
			</section>

			<!-- گام ۳ -->
			<section class="emz-pane" data-pane="2">
				<h2><?php esc_html_e( 'اتوماسیون «اگر … آنگاه»', 'emzagar' ); ?></h2>
				<p><?php esc_html_e( 'کار تکراری را به سیستم بسپارید. با «راه‌اندازی یک‌کلیکی» سه دستور پرکاربرد روشن می‌شود:', 'emzagar' ); ?></p>
				<ul class="emz-tips">
					<?php foreach ( array( 'mail_admin_signed', 'welcome_customer', 'task_on_reject' ) as $k ) : ?>
						<li><b><?php echo esc_html( $recipes[ $k ]['name'] ); ?></b> — <?php echo esc_html( $recipes[ $k ]['desc'] ); ?></li>
					<?php endforeach; ?>
				</ul>
				<?php if ( $quick >= 0 ) : ?>
					<div class="notice notice-success inline"><p><?php echo esc_html( $quick > 0 ? sprintf( /* translators: %d: count */ __( '%d دستور روشن شد ✓', 'emzagar' ), $quick ) : __( 'این دستورها از قبل روشن بودند ✓', 'emzagar' ) ); ?></p></div>
				<?php endif; ?>
				<?php if ( Emzagar_Modules::on( 'automations' ) ) : ?>
					<p class="emz-actions">
						<a class="button button-primary" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_onboard_quick' ), 'emzagar_onboard_quick' ) ); ?>"><?php esc_html_e( '⚡ راه‌اندازی یک‌کلیکی', 'emzagar' ); ?></a>
						<a class="button" href="<?php echo esc_url( Emzagar_Automations::url() ); ?>"><?php esc_html_e( 'همه‌ی دستورها و ساخت قانون دلخواه', 'emzagar' ); ?></a>
					</p>
				<?php else : ?>
					<p class="description"><?php esc_html_e( 'ماژول اتوماسیون خاموش است (تنظیمات ← ماژول‌ها).', 'emzagar' ); ?></p>
				<?php endif; ?>
			</section>

			<!-- گام ۴ -->
			<section class="emz-pane" data-pane="3">
				<h2><?php esc_html_e( 'فرم‌ها ← قرارداد', 'emzagar' ); ?></h2>
				<p><?php esc_html_e( 'با ارسال هر فرم (تماس، ثبت‌نام، درخواست خدمات) نام، ایمیل و موبایل مشتری خوانده می‌شود و قرارداد انتخابی برایش صادر می‌شود — بدون کدنویسی.', 'emzagar' ); ?></p>
				<ul class="emz-prov">
					<?php foreach ( Emzagar_Forms::providers() as $k => $label ) : ?>
						<li><?php echo self::lamp( Emzagar_Forms::installed( $k ) ); // phpcs:ignore WordPress.Security.EscapeOutput ?> <?php echo esc_html( $label ); ?> <small><?php echo Emzagar_Forms::installed( $k ) ? esc_html__( 'نصب است', 'emzagar' ) : esc_html__( 'نصب نیست', 'emzagar' ); ?></small></li>
					<?php endforeach; ?>
				</ul>
				<ol class="emz-tips">
					<li><?php esc_html_e( 'فرمساز و فرم را انتخاب کنید (خالی = همه‌ی فرم‌ها).', 'emzagar' ); ?></li>
					<li><?php esc_html_e( 'قالب قرارداد و مهلت امضا را بگذارید.', 'emzagar' ); ?></li>
					<li><?php esc_html_e( 'یک فرم آزمایشی ارسال کنید و نتیجه را در «گزارش اجرا» ببینید.', 'emzagar' ); ?></li>
				</ol>
				<?php if ( Emzagar_Modules::on( 'forms' ) ) : ?>
					<p><a class="button button-primary" href="<?php echo esc_url( Emzagar_Automations::url( array( 'tab' => 'forms' ) ) ); ?>"><?php esc_html_e( 'اتصال اولین فرم', 'emzagar' ); ?></a></p>
				<?php else : ?>
					<p class="description"><?php esc_html_e( 'ماژول فرم‌ها خاموش است (تنظیمات ← ماژول‌ها).', 'emzagar' ); ?></p>
				<?php endif; ?>
			</section>

			<!-- گام ۵ -->
			<section class="emz-pane" data-pane="4">
				<h2><?php esc_html_e( 'ایمنی، کنترل و مالکیت داده', 'emzagar' ); ?></h2>
				<div class="emz-cols">
					<a class="emz-tile" href="<?php echo esc_url( Emzagar_Settings::tab_url( 'modules' ) ); ?>"><b>🎛️</b><h3><?php esc_html_e( 'کلید ماژول‌ها', 'emzagar' ); ?></h3><p><?php esc_html_e( 'اگر چیزی با افزونه‌ی دیگری تداخل کرد، فقط همان بخش را خاموش کنید.', 'emzagar' ); ?></p></a>
					<a class="emz-tile" href="<?php echo esc_url( Emzagar_Settings::tab_url( 'limits' ) ); ?>"><b>🛑</b><h3><?php esc_html_e( 'ضد اسپم و قفل اضطراری', 'emzagar' ); ?></h3><p><?php esc_html_e( 'سقف روزانه‌ی صدور از فرم‌ها و قفل یک‌کلیکی.', 'emzagar' ); ?></p></a>
					<a class="emz-tile" href="<?php echo esc_url( Emzagar_Settings::tab_url( 'data' ) ); ?>"><b>📦</b><h3><?php esc_html_e( 'خروجی کامل داده', 'emzagar' ); ?></h3><p><?php esc_html_e( 'JSON/CSV/ZIP و بازگردانی؛ داده‌ها مال شماست.', 'emzagar' ); ?></p></a>
					<a class="emz-tile" href="<?php echo esc_url( Emzagar_Health::url() ); ?>"><b>🩺</b><h3><?php esc_html_e( 'وضعیت سیستم', 'emzagar' ); ?></h3><p><?php esc_html_e( 'چراغ سبز/قرمز اتصال، Heartbeat و اجرای اتوماسیون‌ها.', 'emzagar' ); ?></p></a>
				</div>
			</section>

			<!-- گام ۶ -->
			<section class="emz-pane" data-pane="5">
				<h2><?php esc_html_e( 'فهرست راه‌اندازی شما', 'emzagar' ); ?></h2>
				<ul class="emz-check-list">
					<?php foreach ( $list as $it ) : ?>
						<li class="<?php echo $it['done'] ? 'is-done' : ''; ?>"><?php echo self::lamp( $it['done'] ); // phpcs:ignore WordPress.Security.EscapeOutput ?> <?php echo esc_html( $it['title'] ); ?></li>
					<?php endforeach; ?>
				</ul>
				<p class="emz-actions">
					<a class="button button-primary button-hero" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_onboard_done' ), 'emzagar_onboard_done' ) ); ?>"><?php esc_html_e( 'پایان و رفتن به مرکز فرماندهی', 'emzagar' ); ?></a>
					<?php if ( self::is_done() ) : ?>
						<span class="description"><?php esc_html_e( 'این راهنما قبلاً تکمیل شده است.', 'emzagar' ); ?></span>
					<?php endif; ?>
				</p>
			</section>

			<footer class="emz-wiz-nav">
				<button type="button" class="button" id="emz-prev"><?php esc_html_e( '‹ قبلی', 'emzagar' ); ?></button>
				<span id="emz-pos" aria-live="polite"></span>
				<button type="button" class="button button-primary" id="emz-next"><?php esc_html_e( 'بعدی ›', 'emzagar' ); ?></button>
				<a class="emz-skip" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_onboard_done' ), 'emzagar_onboard_done' ) ); ?>"><?php esc_html_e( 'رد کردن راهنما', 'emzagar' ); ?></a>
			</footer>
		</div>
		<?php
	}

	/** نوار یادآوری روی صفحه‌ی تنظیمات تا وقتی راهنما کامل نشده */
	public static function banner() {
		if ( self::is_done() ) {
			return;
		}
		printf(
			'<div class="notice notice-info"><p><strong>%s</strong> %s <a class="button button-primary button-small" href="%s">%s</a></p></div>',
			esc_html__( 'تازه شروع کرده‌اید؟', 'emzagar' ),
			esc_html__( 'راهنمای ۵ قدمی کانبان، اتوماسیون و فرم‌ها را ببینید.', 'emzagar' ),
			esc_url( self::url() ),
			esc_html__( 'شروع راهنما', 'emzagar' )
		);
	}
}
