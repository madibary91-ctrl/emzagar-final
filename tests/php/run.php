<?php
require __DIR__.'/stubs.php';
$dir=dirname(__DIR__,2).'/wordpress-plugin/emzagar-contracts/includes/';
foreach(['api','connect','sync','settings','access','hub','inbox','workspace','palette','automations','forms','shortcodes','woocommerce','order-ui','elementor','modules','limits','export','updater','health','onboarding'] as $f){ require_once $dir."class-emzagar-$f.php"; }
$fail=0; function t($name,$cond){ global $fail; echo ($cond?"PASS":"FAIL")." $name\n"; if(!$cond)$fail++; }

// --- Modules
t('all modules on by default', count(Emzagar_Modules::active_ids())===count(Emzagar_Modules::registry()));
Emzagar_Modules::apply(['hub','sync']);
t('apply turns others off', !Emzagar_Modules::on('forms') && Emzagar_Modules::on('hub'));
t('state off', Emzagar_Modules::state('forms')==='off');
Emzagar_Modules::trip('forms','Boom','/tmp/p/emzagar-contracts/includes/class-emzagar-forms.php',12,true);
t('trip -> auto state', Emzagar_Modules::state('forms')==='auto');
Emzagar_Modules::apply(array_keys(Emzagar_Modules::registry()));
t('re-enable clears error', empty(Emzagar_Modules::errors()) && Emzagar_Modules::state('forms')!=='auto');
t('unknown id is core/on', Emzagar_Modules::on('connect')===true);

// --- Limits
update_option(Emzagar_Limits::OPT, Emzagar_Limits::sanitize(['daily_cap'=>3,'ip_hour'=>0,'email_day'=>2,'burst'=>0]));
$_SERVER['REMOTE_ADDR']='203.0.113.9';
$g1=Emzagar_Limits::check('form','a@x.com'); $g2=Emzagar_Limits::check('form','a@x.com'); $g3=Emzagar_Limits::check('form','a@x.com');
t('email cap: 2 ok then block', $g1['ok'] && $g2['ok'] && !$g3['ok'] && $g3['code']==='email');
$g4=Emzagar_Limits::check('form','b@x.com'); $g5=Emzagar_Limits::check('form','c@x.com');
t('daily cap reached at 3', $g4['ok'] && !$g5['ok'] && $g5['code']==='daily');
Emzagar_Limits::release($g4);
$g6=Emzagar_Limits::check('form','d@x.com');
t('release gives quota back', $g6['ok']);
$st=Emzagar_Limits::stats(); t('stats counts issued/blocked', $st['issuedToday']===3 && $st['blockedToday']>=2);
// ip cap
update_option(Emzagar_Limits::OPT, Emzagar_Limits::sanitize(['daily_cap'=>0,'ip_hour'=>2,'email_day'=>0,'burst'=>0]));
$GLOBALS['O']=array_filter($GLOBALS['O'],fn($k)=>strpos($k,'emzagar_rl_')!==0,ARRAY_FILTER_USE_KEY);
$_SERVER['REMOTE_ADDR']='198.51.100.1';
$r=[Emzagar_Limits::check('form','1@x.com')['ok'],Emzagar_Limits::check('form','2@x.com')['ok'],Emzagar_Limits::check('form','3@x.com')['ok']];
t('ip/hour cap blocks 3rd', $r===[true,true,false]);
// burst auto lockdown
update_option(Emzagar_Limits::OPT, Emzagar_Limits::sanitize(['daily_cap'=>0,'ip_hour'=>0,'email_day'=>0,'burst'=>5,'lock_minutes'=>30]));
$GLOBALS['O']=array_filter($GLOBALS['O'],fn($k)=>strpos($k,'emzagar_rl_')!==0,ARRAY_FILTER_USE_KEY);
$res=[]; for($i=0;$i<8;$i++){ $res[]=Emzagar_Limits::check('form',"u$i@x.com")['ok']; }
t('burst: 5 ok then lock', array_slice($res,0,5)===[true,true,true,true,true] && !$res[5] && !$res[7]);
t('auto lock active', Emzagar_Limits::is_locked() && Emzagar_Limits::lock_state()['mode']==='auto');
Emzagar_Limits::unlock(); t('unlock works', !Emzagar_Limits::is_locked());
Emzagar_Limits::lock('manual','test',0,'admin'); $c=Emzagar_Limits::check('form','z@x.com'); t('manual lockdown denies', !$c['ok'] && $c['code']==='lockdown'); Emzagar_Limits::unlock();
update_option('emzagar_lockdown',['mode'=>'auto','until'=>time()-5,'reason'=>'','at'=>0,'by'=>'']); t('expired auto lock inactive', !Emzagar_Limits::is_locked());
$s=Emzagar_Limits::sanitize(['daily_cap'=>-5,'lock_minutes'=>1,'ip_hour'=>'abc']); t('sanitize clamps', $s['daily_cap']===0 && $s['lock_minutes']===5 && $s['ip_hour']===0);

// --- CSV
$csv=Emzagar_Export::to_csv([['a'=>'=HYPERLINK("x")','b'=>'ok, "q"','c'=>'سلام'],['a'=>'-5','b'=>'@sum','c'=>'+98']]);
t('csv BOM', substr($csv,0,3)==="\xEF\xBB\xBF");
t('csv formula guard', strpos($csv,"\"'=HYPERLINK")!==false && strpos($csv,"\"'@sum\"")!==false && strpos($csv,'"-5"')!==false);
t('csv quoting', strpos($csv,'"ok, ""q"""')!==false);
t('csv empty', strpos(Emzagar_Export::to_csv([]),'(empty)')!==false);

// --- Import rules
$n=Emzagar_Automations::import_rules([
 ['id'=>'abc123','name'=>'<b>Rule</b>','on'=>true,'trigger'=>'signed','action'=>'webhook','p'=>'javascript:alert(1)','p2'=>'','tpl'=>'5','min'=>'0','recipe'=>'x_y'],
 ['name'=>'N2','on'=>false,'trigger'=>'bogus','act'=>'task','p'=>'T','p2'=>'D'],
 'garbage',
]);
$rules=Emzagar_Automations::rules();
t('import rules count', $n===3-1+0 || $n===2);
t('import sanitizes webhook url', $rules[0]['p']==='' );
t('import keeps id/on/recipe', $rules[0]['id']==='abc123' && $rules[0]['on']===true && $rules[0]['recipe']==='x_y');
t('import normalizes bad trigger', $rules[1]['trigger']==='signed' && $rules[1]['on']===false);
$nf=Emzagar_Forms::import_rules([['provider'=>'cf7','tpl'=>3,'on'=>true,'form'=>'12','expiry'=>99999],['provider'=>'evil','tpl'=>1],['provider'=>'wpforms','tpl'=>0]]);
t('forms import filters invalid', $nf===1 && Emzagar_Forms::rules()[0]['expiry']===3650);
t('add_recipe', Emzagar_Automations::add_recipe('mail_admin_signed')==='added' && Emzagar_Automations::add_recipe('mail_admin_signed')==='exists' && Emzagar_Automations::add_recipe('nope')==='bad');

// --- Restore
$snap=Emzagar_Export::snapshot(); t('snapshot has keys', isset($snap['settings'],$snap['modules'],$snap['limits'],$snap['automations']['rules'],$snap['forms']['rules']));
t('snapshot has no api key', !isset($snap['settings']['api_key']));
$b=Emzagar_Export::bundle(false); t('bundle format+checksum', $b['format']==='emzagar-export' && strpos($b['checksum'],'sha256:')===0 && isset($b['data']['gates']));
$done=Emzagar_Export::restore($snap,array_keys(Emzagar_Export::restore_sets())); t('restore all sets runs', isset($done['automations'],$done['forms'],$done['modules'],$done['limits']));
foreach(array_keys(Emzagar_Export::dataset_defs()) as $set){ if($set==='contracts')continue; $rows=Emzagar_Export::rows($set); if(!is_array($rows)){t("rows $set",false);} }
t('all datasets produce rows arrays', true);

// --- Updater
t('license label', strpos(Emzagar_Updater::license_label(['state'=>'active','plan'=>'گسترده']),'فعال')===0);
t('license unlicensed not required', strpos(Emzagar_Updater::license_label(['state'=>'unlicensed','required'=>false]),'نسخه‌ی آزاد')!==false);
t('available newer', Emzagar_Updater::available(['version'=>'2.4.0','package'=>'https://x/p'])==='2.4.0');
t('available same', Emzagar_Updater::available(['version'=>'2.3.0','package'=>'https://x/p'])==='');
t('available no package', Emzagar_Updater::available(['version'=>'9.0.0','package'=>''])==='');
t('auto_update minor', Emzagar_Updater::auto_update(false,(object)['plugin'=>plugin_basename(EMZ_FILE),'new_version'=>'2.9.1'])===true);
t('auto_update major blocked', Emzagar_Updater::auto_update(true,(object)['plugin'=>plugin_basename(EMZ_FILE),'new_version'=>'3.0.0'])===false);

// --- Health
$r=Emzagar_Health::report(false); t('health report shape', isset($r['overall'],$r['counts'],$r['checks']) && count($r['checks'])>=18);
$ids=array_column($r['checks'],'id'); foreach(['connected','beat','cron','automations','lockdown','modules','license','update','ping','rest'] as $id) t("health has $id", in_array($id,$ids,true));

// --- Boot integration: modules gate hooks
function has_hook($tag,$cls){ foreach(($GLOBALS['hooks'][$tag]??[]) as $cb){ if(is_array($cb)&&$cb[0]===$cls) return true; } return false; }
$GLOBALS['IS_ADMIN']=true;
// Emzagar_Automations::$ui_ready is static; use a fresh process per scenario
function scenario($on){ $code='<?php require "'.__DIR__.'/boot.php"; $GLOBALS["IS_ADMIN"]=true; Emzagar_Modules::apply('.var_export($on,true).'); Emzagar_Modules::boot(); function h($t,$c){foreach(($GLOBALS["hooks"][$t]??[]) as $cb){if(is_array($cb)&&$cb[0]===$c)return 1;}return 0;} echo json_encode(["event"=>h("emzagar_contract_event","Emzagar_Automations"),"menu"=>h("admin_menu","Emzagar_Automations"),"forms"=>h("wpcf7_mail_sent","Emzagar_Forms"),"wc"=>h("init","Emzagar_WooCommerce")]);'; $f=tempnam(sys_get_temp_dir(),'sc'); file_put_contents($f,$code); $o=shell_exec(PHP_BINARY.' '.escapeshellarg($f).' 2>&1'); unlink($f); return json_decode(trim(substr($o,strpos($o,'{'))),true); }
$all=array_keys(Emzagar_Modules::registry());
$a=scenario($all); t('boot all on: automations+forms wired', $a['event']==1 && $a['menu']==1 && $a['forms']==1);
$b=scenario(['forms']); t('only forms: UI page exists, rules engine off', $b['event']==0 && $b['menu']==1 && $b['forms']==1);
$c=scenario(['automations']); t('only automations: engine on, forms off', $c['event']==1 && $c['menu']==1 && $c['forms']==0);
$d=scenario([]); t('safe mode: nothing wired', $d['event']==0 && $d['menu']==0 && $d['forms']==0);
echo "\nTOTAL FAIL: $fail\n";
