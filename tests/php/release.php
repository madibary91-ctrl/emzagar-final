<?php
/**
 * آزمون راستی‌آزمایی امضای انتشار افزونه (CR-05) — اجرای PHP واقعی روی بسته‌هایی که Node ساخته است.
 * استفاده:  php tests/php/release.php <cases.json>      (توسط tests/unit/wp-release.test.ts اجرا می‌شود)
 * اگر sodium بومی نبود، sodium_compat همراه وردپرس (همان که وردپرس خودش بارگذاری می‌کند) از SODIUM_COMPAT_DIR می‌آید.
 */
define( 'ABSPATH', __DIR__ . '/' );
class WP_Error {
	public $code;
	public $msg;
	public function __construct( $code = '', $msg = '' ) {
		$this->code = $code;
		$this->msg  = $msg;
	}
}
function is_wp_error( $x ) {
	return $x instanceof WP_Error;
}
function __( $s ) {
	return $s;
}
if ( ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
	$d = getenv( 'SODIUM_COMPAT_DIR' );
	if ( $d && is_readable( $d . '/autoload.php' ) ) {
		require_once $d . '/autoload.php';
	}
}
require_once dirname( __DIR__, 2 ) . '/wordpress-plugin/emzagar-contracts/includes/class-emzagar-release.php';

$cases = json_decode( file_get_contents( $argv[1] ), true );
$out   = array();
foreach ( $cases as $c ) {
	$keys = $c['keys'];
	if ( 'zip' === $c['kind'] ) {
		$r = Emzagar_Release::verify_zip( $c['path'], $c['expect'], $c['current'], $c['origins'], $keys );
	} else {
		$r = Emzagar_Release::verify_dir( $c['path'], $c['expect'], $c['current'], $c['origins'], $keys );
	}
	$out[ $c['name'] ] = is_wp_error( $r ) ? $r->code : 'ok';
}
echo json_encode( $out );
