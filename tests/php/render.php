<?php
require __DIR__.'/boot.php';
$_GET=['page'=>'emzagar'];
$fail=0;
foreach([
 'modules'=>fn()=>Emzagar_Modules::render_tab(),
 'limits'=>fn()=>Emzagar_Limits::render_tab(),
 'data'=>fn()=>Emzagar_Export::render_tab(),
 'license'=>fn()=>Emzagar_Updater::render_tab(),
 'health'=>fn()=>Emzagar_Health::render(),
 'welcome'=>fn()=>Emzagar_Onboarding::render(),
] as $n=>$f){ ob_start(); try{ $f(); $o=ob_get_clean(); echo "RENDER $n: ".strlen($o)." bytes ".(strlen($o)>500?'OK':'SHORT')."\n"; }catch(Throwable $e){ ob_end_clean(); echo "RENDER $n FAIL: ".$e->getMessage()." @".basename($e->getFile()).":".$e->getLine()."\n"; $fail++; } }
// forced-off modules via filter-free path: simulate update info with license
update_option('emz_update_info',['checked'=>time(),'version'=>'2.4.0','package'=>'https://cloud.example.com/api/wordpress/plugin','changelog'=>"- a\n- b",'license'=>['state'=>'active','plan'=>'گسترده','customer'=>'علی','domain'=>'cloud.example.com','maxDomains'=>3,'usedDomains'=>1,'expiresAt'=>'2030-01-01T00:00:00Z']]);
ob_start(); Emzagar_Updater::render_tab(); $o=ob_get_clean(); echo "license tab shows update btn: ".(strpos($o,'به‌روزرسانی به 2.4.0')!==false?'yes':'NO')."\n";
ob_start(); Emzagar_Health::render(); $o=ob_get_clean(); echo "health shows update warn: ".(strpos($o,'2.4.0')!==false?'yes':'NO')."\n";
echo "FAILS: $fail\n";
