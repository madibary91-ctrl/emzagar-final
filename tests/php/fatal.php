<?php
// آزمون «سپر ایمنی»: خطای مرگبار داخل فایل یک ماژول ⇒ فقط همان ماژول خودکار خاموش می‌شود.
// اجرا: php tests/php/fatal.php   (باید «CIRCUIT BREAKER OK» چاپ کند)
require __DIR__ . '/boot.php';
function add_shortcode() {}
function register_rest_route() {}
@mkdir( EMZ_DIR . 'includes', 0777, true );
file_put_contents( EMZ_DIR . 'includes/class-emzagar-palette.php', '<?php undefined_function_boom();' );
Emzagar_Modules::boot(); // ثبت نگهبان shutdown
register_shutdown_function(
	function () {
		$ok = 'auto' === Emzagar_Modules::state( 'palette' ) && 'on' === Emzagar_Modules::state( 'hub' ) && 'on' === Emzagar_Modules::state( 'forms' );
		echo "\n" . ( $ok ? 'CIRCUIT BREAKER OK' : 'CIRCUIT BREAKER FAIL' ) . "\n";
	}
);
include EMZ_DIR . 'includes/class-emzagar-palette.php';
