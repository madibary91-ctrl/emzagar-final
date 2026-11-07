<?php define('ARRAY_A','ARRAY_A');
define('ABSPATH','/tmp/'); define('EMZ_VERSION','2.3.0'); define('EMZ_FILE','/tmp/p/emzagar-contracts/emzagar-contracts.php'); define('EMZ_DIR','/tmp/p/emzagar-contracts/'); define('EMZ_URL','http://x/'); define('EMZ_OPTION','emzagar_options');
define('DAY_IN_SECONDS',86400); define('HOUR_IN_SECONDS',3600); define('MINUTE_IN_SECONDS',60); define('WEEK_IN_SECONDS',604800); define('MB_IN_BYTES',1048576);
$GLOBALS['O']=[]; $GLOBALS['T']=[]; $GLOBALS['hooks']=[];
function __($s,$d=null){return $s;} function esc_html__($s){return $s;} function esc_html_e($s){echo $s;} function esc_html($s){return htmlspecialchars((string)$s);} function esc_attr($s){return htmlspecialchars((string)$s);} function esc_attr__($s){return $s;} function esc_url($s){return $s;} function esc_js($s){return $s;}
function get_option($k,$d=false){return array_key_exists($k,$GLOBALS['O'])?$GLOBALS['O'][$k]:$d;}
function update_option($k,$v,$a=null){$GLOBALS['O'][$k]=$v;return true;} function add_option($k,$v='',$d='',$a='yes'){if(!array_key_exists($k,$GLOBALS['O']))$GLOBALS['O'][$k]=$v;return true;} function delete_option($k){unset($GLOBALS['O'][$k]);return true;}
function get_transient($k){return $GLOBALS['T'][$k]??false;} function set_transient($k,$v,$e=0){$GLOBALS['T'][$k]=$v;return true;} function delete_transient($k){unset($GLOBALS['T'][$k]);}
function wp_parse_args($a,$d){return array_merge($d,(array)$a);} function wp_date($f,$t=null){return date($f,$t??time());}
function apply_filters($t,$v){return $v;} function add_action($t,$cb=null){$GLOBALS['hooks'][$t][]=$cb;} function add_filter($t,$cb=null){$GLOBALS['hooks'][$t][]=$cb;} function do_action(){}
function sanitize_key($k){return preg_replace('/[^a-z0-9_\-]/','',strtolower((string)$k));} function sanitize_text_field($s){return trim(strip_tags((string)$s));} function sanitize_textarea_field($s){return trim(strip_tags((string)$s));} function sanitize_email($s){return trim($s);} function is_email($e){return (bool)filter_var($e,FILTER_VALIDATE_EMAIL);}
function wp_unslash($v){return is_array($v)?array_map('wp_unslash',$v):stripslashes((string)$v);} function wp_slash($v){return is_array($v)?array_map('wp_slash',$v):addslashes((string)$v);}
function absint($n){return abs((int)$n);} function esc_url_raw($u,$p=null){return filter_var($u,FILTER_VALIDATE_URL)?$u:'';} function wp_strip_all_tags($s){return strip_tags((string)$s);}
function wp_generate_password($n=12){return substr(str_shuffle('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),0,$n);} function wp_json_encode($d,$f=0){return json_encode($d,$f);}
function wp_schedule_single_event(){} function wp_next_scheduled(){return time()+3600;} function wp_clear_scheduled_hook(){}
function home_url($p=''){return 'https://shop.example.com'.$p;} function get_bloginfo($k){return $k==='version'?'6.6':'Shop';} function get_permalink($id){return 'https://shop.example.com/?p='.$id;}
function wp_get_current_user(){return new class{public $user_login='admin';public $ID=1; function exists(){return true;}};}
function human_time_diff($a,$b=0){return '5 دقیقه';} function wp_convert_hr_to_bytes($v){return 256*1048576;} function is_ssl(){return true;}
function wp_mail(){return true;} function get_users(){return [];} function admin_url($p=''){return 'https://shop.example.com/wp-admin/'.$p;} function add_query_arg(){ $a=func_get_args(); if(is_array($a[0])) return $a[2].'?'.http_build_query($a[0]); return $a[2].'?'.$a[0].'='.$a[1];}
function wp_create_nonce(){return 'n';} function wp_nonce_url($u){return $u.'&_wpnonce=n';} function rest_url($p=''){return 'https://shop.example.com/wp-json/'.$p;} function wp_parse_url($u,$c=-1){return parse_url($u,$c);} function untrailingslashit($s){return rtrim($s,'/');}
function class_exists_stub(){} function is_admin(){return !empty($GLOBALS['IS_ADMIN']);} function current_user_can(){return true;} function get_locale(){return 'fa_IR';}
class WP_Error{ public $m; function __construct($c='',$m=''){$this->m=$m;} function get_error_message(){return $this->m;} } function is_wp_error($x){return $x instanceof WP_Error;}
class FakeDB{ public $prefix='wp_',$options='wp_options',$postmeta='wp_postmeta',$posts='wp_posts';
 function prepare($q,...$a){ if(count($a)==1&&is_array($a[0]))$a=$a[0]; $i=0; return preg_replace_callback('/%[sd]/',function($m)use(&$i,$a){$v=$a[$i++];return $m[0]=='%d'?(int)$v:"'".addslashes($v)."'";},$q);}
 function esc_like($s){return addcslashes($s,'_%\\');}
 function query($sql){ if(preg_match("/SET option_value = GREATEST\(0, CAST\(option_value AS SIGNED\) \+ (-?\d+)\) WHERE option_name = '([^']+)'/",$sql,$m)){ $k=$m[2]; $GLOBALS['O'][$k]=max(0,(int)$GLOBALS['O'][$k]+(int)$m[1]); return 1;} return 0;}
 function get_var($sql){ if(preg_match("/SELECT option_value FROM wp_options WHERE option_name = '([^']+)'/",$sql,$m)) return $GLOBALS['O'][$m[1]]??null; return 0;}
 function get_results(){return [];}
}
$GLOBALS['wpdb']=new FakeDB();
function wp_cache_delete(){} 
function emzagar_options(){ return wp_parse_args(get_option('emzagar_options',[]),['base_url'=>'https://cloud.example.com','api_key'=>'emz_'.str_repeat('a',48),'connection'=>'auto','cloud_url'=>'','workspace'=>'W','verified'=>'yes','sso'=>'no','page_id'=>0,'cache_minutes'=>2,'default_template'=>0,'wc_enabled'=>'yes','wc_trigger'=>'processing','wc_all_orders'=>'no','wc_expiry_days'=>14,'sync_orders'=>'yes','sync_customers'=>'yes','wc_hold_until_signed'=>'no','wc_on_signed'=>'none','wc_on_reject'=>'none','wc_gate_downloads'=>'no','accent'=>'#0f766e','pairing_used'=>'']);}
function plugin_basename($f){return 'emzagar-contracts/emzagar-contracts.php';}
function sanitize_hex_color($c){return preg_match('/^#[0-9a-f]{6}$/i',$c)?$c:'';} function add_settings_error(){} function get_role($r){return null;} function set_time_limit_stub(){}
function emzagar_packaged_config(){return ['cloud_url'=>'https://cloud.example.com'];}
function checked($a,$b=true){ if($a==$b) echo ' checked="checked"'; } function selected($a,$b){ if($a==$b) echo ' selected="selected"'; } function disabled($a,$b=true){ if($a==$b) echo ' disabled="disabled"'; }
function submit_button(){echo '<button>save</button>';} function wp_nonce_field(){echo '<input type=hidden name=_wpnonce>';} function is_rtl(){return true;} function settings_errors(){} function esc_html_x($s){return $s;}
function self_admin_url($p=''){return 'https://shop.example.com/wp-admin/'.$p;} function number_format_i18n($n){return number_format($n);} function get_post_status(){return 'publish';} function wp_list_pluck($a,$k){return array_column($a,$k);} function get_current_screen(){return null;}
function esc_attr_e($s){echo $s;} function wp_remote_request(){return new WP_Error('x','offline');} function wp_remote_get(){return new WP_Error('x','offline');} function wp_remote_retrieve_response_code(){return 0;}
