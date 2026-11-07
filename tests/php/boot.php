<?php
require __DIR__.'/stubs.php';
$dir=dirname(__DIR__,2).'/wordpress-plugin/emzagar-contracts/includes/';
foreach(['api','connect','sync','settings','access','hub','inbox','workspace','palette','automations','forms','shortcodes','woocommerce','order-ui','elementor','modules','limits','export','updater','health','onboarding'] as $f){ require_once $dir."class-emzagar-$f.php"; }
