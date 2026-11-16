<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * هویت بصری «امضاگیر» در پیشخوان وردپرس: همان رنگ‌ها (مرکب #102c31، نعنایی #41e4ad) و فونت (وزیرمتن) پنل Next.js.
 *  - بارگذاری brand.css آخر از همه (فقط روی صفحه‌هایی که یکی از شیوه‌نامه‌های امضاگیر را دارند)
 *  - نوار برند بالای صفحه‌های افزونه
 *  - آیکون SVG منوی کناری
 */
class Emzagar_Brand {

	/** همه‌ی شناسه‌های شیوه‌نامه‌ی افزونه؛ brand.css بعد از آن‌ها می‌آید تا بتواند بازنویسی کند */
	private static $handles = array( 'emzagar-admin', 'emzagar-control', 'emzagar-hub', 'emzagar-workspace', 'emzagar-inbox' );

	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ), 99 );
		add_action( 'in_admin_header', array( __CLASS__, 'bar' ) );
	}

	/** آیکون منوی کناری (تک‌رنگ؛ وردپرس خودش با طرح رنگی مدیر رنگ‌آمیزی می‌کند) */
	public static function menu_icon() {
		$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#a7aaad"><path d="M4 20.5c3.2 0 4.2-1.2 5.6-3.2l.9-1.3c.9-1.3 1.6-2.2 2.6-2.2 1.2 0 1.1 1.7 2.7 1.7 1.3 0 2-1 3.2-2.7l-1.5-1.1c-.8 1.2-1.2 1.7-1.7 1.7-.9 0-1-1.7-2.7-1.7-1.8 0-2.8 1.5-3.8 3l-.9 1.3C7.1 18.8 6.5 19 4 19v1.5zM16.6 3.3l4.1 4.1-8.5 8.5-4.9.8.8-4.9 8.5-8.5z"/></svg>';
		return 'data:image/svg+xml;base64,' . base64_encode( $svg ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- آیکون ثابت منو
	}

	/** آیا صفحه‌ی جاری مربوط به امضاگیر است؟ */
	private static function is_ours() {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		return $screen && isset( $screen->id ) && false !== strpos( (string) $screen->id, 'emzagar' );
	}

	public static function assets() {
		$deps = array();
		foreach ( self::$handles as $h ) {
			if ( wp_style_is( $h, 'enqueued' ) ) {
				$deps[] = $h;
			}
		}
		if ( empty( $deps ) && ! self::is_ours() ) {
			return;
		}
		wp_enqueue_style( 'emzagar-brand', EMZ_URL . 'assets/css/brand.css', $deps, EMZ_VERSION );
	}

	/** نوار برند بالای صفحه‌های افزونه */
	public static function bar() {
		if ( ! self::is_ours() ) {
			return;
		}
		?>
		<div class="emz-brandbar" role="banner">
			<span class="emz-brandbar-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 20.5c3.2 0 4.2-1.2 5.6-3.2l.9-1.3c.9-1.3 1.6-2.2 2.6-2.2 1.2 0 1.1 1.7 2.7 1.7 1.3 0 2-1 3.2-2.7l-1.5-1.1c-.8 1.2-1.2 1.7-1.7 1.7-.9 0-1-1.7-2.7-1.7-1.8 0-2.8 1.5-3.8 3l-.9 1.3C7.1 18.8 6.5 19 4 19v1.5zM16.6 3.3l4.1 4.1-8.5 8.5-4.9.8.8-4.9 8.5-8.5z"/></svg></span>
			<span>
				<b><?php esc_html_e( 'امضاگیر', 'emzagar' ); ?></b>
				<small><?php esc_html_e( 'قرارداد و امضای آنلاین برای وردپرس و ووکامرس', 'emzagar' ); ?></small>
			</span>
			<span class="emz-brandbar-ver">v<?php echo esc_html( EMZ_VERSION ); ?></span>
		</div>
		<?php
	}
}
