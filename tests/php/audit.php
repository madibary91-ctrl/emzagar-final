<?php
/**
 * آزمون‌های «ممیزی افزونه‌ی وردپرس» (فاز ۲۹) — اجرا:  php tests/php/audit.php
 *
 * بدون وردپرس واقعی اجرا می‌شود: استاب‌های موجود (stubs.php، دست‌نخورده) بارگذاری می‌شوند و چند تابع/کلاس که برای این
 * سناریوها باید «قابل کنترل» باشند (HTTP، کرون، WP_Error کامل، دیتابیس صف) با نسخه‌ی غنی‌تر جایگزین می‌شوند.
 * خروجی: PASS/FAIL برای هر مورد و در پایان «TOTAL FAIL: n».
 */
error_reporting( E_ALL & ~E_DEPRECATED );

// ───────────── استاب‌ها: نسخه‌ی موجود را می‌خوانیم و فقط نام توابعِ قابل‌کنترل را عوض می‌کنیم ─────────────
$src = preg_replace( '/^<\?php/', '', file_get_contents( __DIR__ . '/stubs.php' ), 1 );
foreach ( array( 'add_query_arg', 'wp_remote_request', 'wp_remote_retrieve_response_code', 'wp_schedule_single_event', 'wp_next_scheduled', 'current_user_can', 'wp_create_nonce', 'wp_get_current_user', 'is_wp_error' ) as $fn ) {
	$src = str_replace( "function $fn(", "function _stub_$fn(", $src, $n );
	if ( ! $n ) {
		fwrite( STDERR, "stub $fn not found\n" );
		exit( 2 );
	}
}
$src = str_replace( 'class WP_Error{', 'class _StubWP_Error{', $src, $n );
if ( ! $n ) {
	exit( 2 );
}
eval( $src );

class WP_Error {
	public $code, $msg, $data;
	public function __construct( $c = '', $m = '', $d = null ) {
		$this->code = $c;
		$this->msg  = $m;
		$this->data = $d;
	}
	public function get_error_message() {
		return $this->msg;
	}
	public function get_error_code() {
		return $this->code;
	}
	public function get_error_data() {
		return $this->data;
	}
}
function is_wp_error( $x ) {
	return $x instanceof WP_Error;
}
function add_query_arg() {
	$a = func_get_args();
	if ( is_array( $a[0] ) ) {
		$url = $a[1] ?? '';
		return $url . ( false === strpos( $url, '?' ) ? '?' : '&' ) . http_build_query( $a[0] );
	}
	$url = $a[2] ?? '';
	return $url . ( false === strpos( $url, '?' ) ? '?' : '&' ) . $a[0] . '=' . $a[1];
}
function wp_create_nonce( $action = '' ) {
	return 'n_' . $action;
}
function wp_verify_nonce( $n, $action = '' ) {
	return $n === 'n_' . $action ? 1 : false;
}
function current_user_can( $cap = '' ) {
	return array_key_exists( 'CAN', $GLOBALS ) ? (bool) $GLOBALS['CAN'] : true;
}
function wp_get_current_user() {
	return (object) array( 'ID' => 7, 'user_email' => 'Buyer@Example.com', 'display_name' => 'Buyer', 'user_login' => 'buyer' );
}
function is_user_logged_in() {
	return ! empty( $GLOBALS['LOGGED'] );
}
function wp_die( $m = '' ) {
	throw new RuntimeException( 'wp_die:' . ( is_string( $m ) ? $m : '' ) );
}
class RedirectSignal extends RuntimeException {}
function wp_safe_redirect( $u ) {
	throw new RedirectSignal( (string) $u );
}
function wp_validate_redirect( $u, $d = '' ) {
	return $u ? $u : $d;
}
function wp_login_url( $r = '' ) {
	return 'https://shop.example.com/wp-login.php';
}
function update_user_meta( $u, $k, $v ) {
	$GLOBALS['UM'][ $u ][ $k ] = $v;
	return true;
}
function get_user_meta( $u, $k, $single = false ) {
	return $GLOBALS['UM'][ $u ][ $k ] ?? '';
}
function get_the_ID() {
	return $GLOBALS['POST_ID'] ?? 0;
}
function get_post( $id ) {
	return (object) array( 'ID' => $id, 'post_type' => 'post' );
}
function get_post_meta( $id, $k, $single = true ) {
	return $GLOBALS['PM'][ $id ][ $k ] ?? '';
}
function doing_filter( $f ) {
	return in_array( $f, (array) ( $GLOBALS['FILTERS'] ?? array() ), true );
}
function is_singular() {
	return false;
}
function wp_remote_retrieve_body( $r ) {
	return $r['body'];
}
function wp_remote_retrieve_response_code( $r ) {
	return $r['response']['code'];
}
function wp_remote_request( $url, $args = array() ) {
	$GLOBALS['HTTP_LOG'][] = array( $args['method'] ?? 'GET', $url, $args );
	$h                     = $GLOBALS['HTTP'];
	$r                     = $h( $args['method'] ?? 'GET', $url, $args );
	if ( $r instanceof WP_Error ) {
		return $r;
	}
	return array( 'response' => array( 'code' => $r[0] ), 'body' => is_string( $r[1] ) ? $r[1] : json_encode( $r[1] ) );
}
function wp_schedule_single_event( $ts, $hook, $args = array() ) {
	$GLOBALS['CRON'][] = array( $hook, $ts, $args );
	return true;
}
function wp_next_scheduled( $hook, $args = array() ) {
	foreach ( (array) ( $GLOBALS['CRON'] ?? array() ) as $e ) {
		if ( $e[0] === $hook && $e[2] === $args ) {
			return $e[1];
		}
	}
	return false;
}
function wp_unschedule_hook() {}
function get_user_by() {
	return false;
}
function wc_get_order( $id ) {
	return $GLOBALS['ORDERS'][ $id ] ?? false;
}
function wc_get_product( $id ) {
	return $GLOBALS['PRODUCTS'][ $id ] ?? false;
}

// ───────────── دیتابیس جعلی با جدول صف و قفل اتمیک ─────────────
class AuditDB extends FakeDB {
	public $q = array(), $seq = 0, $rows_affected = 0;
	public function insert( $table, $data, $fmt = null ) {
		$row = (object) array_merge( array( 'snapshot' => null, 'attempts' => 0, 'next_at' => 0, 'created_at' => 0, 'ref_id' => 0 ), $data );
		$row->id = ++$this->seq;
		$this->q[ $row->id ] = $row;
		return 1;
	}
	public function update( $table, $data, $where, $f = null, $wf = null ) {
		$id = (int) $where['id'];
		if ( isset( $this->q[ $id ] ) ) {
			foreach ( $data as $k => $v ) {
				$this->q[ $id ]->$k = $v;
			}
			return 1;
		}
		return 0;
	}
	public function delete( $table, $where, $f = null ) {
		if ( isset( $where['id'] ) ) {
			unset( $this->q[ (int) $where['id'] ] );
		} elseif ( isset( $where['option_name'] ) ) {
			unset( $GLOBALS['O'][ $where['option_name'] ] );
		}
		return 1;
	}
	public function get_var( $sql ) {
		if ( preg_match( '/SELECT COUNT\(\*\) FROM wp_emzagar_queue/', $sql ) ) {
			return count( $this->q );
		}
		if ( preg_match( "/SELECT id FROM wp_emzagar_queue WHERE type = '([^']+)' AND ref_id = (\d+) AND snapshot IS NULL/", $sql, $m ) ) {
			foreach ( $this->q as $r ) {
				if ( $r->type === $m[1] && (int) $r->ref_id === (int) $m[2] && null === $r->snapshot ) {
					return $r->id;
				}
			}
			return null;
		}
		return parent::get_var( $sql );
	}
	public function get_results( $sql = '', $o = null ) {
		if ( preg_match( '/FROM wp_emzagar_queue WHERE next_at <= (\d+) ORDER BY id ASC LIMIT (\d+)/', $sql, $m ) ) {
			$out = array();
			foreach ( $this->q as $r ) {
				if ( (int) $r->next_at <= (int) $m[1] ) {
					$out[] = clone $r;
				}
			}
			return array_slice( $out, 0, (int) $m[2] );
		}
		return array();
	}
	public function query( $sql ) {
		if ( preg_match( "/^DELETE FROM wp_options WHERE option_name = '([^']+)' AND CAST\(option_value AS UNSIGNED\) < (\d+)/", $sql, $m ) ) {
			if ( isset( $GLOBALS['O'][ $m[1] ] ) && (int) $GLOBALS['O'][ $m[1] ] < (int) $m[2] ) {
				unset( $GLOBALS['O'][ $m[1] ] );
				return 1;
			}
			return 0;
		}
		if ( preg_match( "/^INSERT IGNORE INTO wp_options \(option_name, option_value, autoload\) VALUES \('([^']+)', '([^']*)', 'no'\)/", $sql, $m ) ) {
			if ( array_key_exists( $m[1], $GLOBALS['O'] ) ) {
				return 0;
			}
			$GLOBALS['O'][ $m[1] ] = $m[2];
			return 1;
		}
		return parent::query( $sql );
	}
}
$GLOBALS['wpdb'] = new AuditDB();

$dir = dirname( __DIR__, 2 ) . '/wordpress-plugin/emzagar-contracts/includes/';
foreach ( array( 'api', 'connect', 'sync', 'settings', 'access', 'hub', 'inbox', 'shortcodes', 'woocommerce', 'order-ui', 'modules', 'limits', 'updater', 'health', 'onboarding' ) as $f ) {
	require_once $dir . "class-emzagar-$f.php";
}
$fail = 0;
function t( $name, $cond ) {
	global $fail;
	echo ( $cond ? 'PASS' : 'FAIL' ) . " $name\n";
	if ( ! $cond ) {
		++$fail;
	}
}
function reset_world() {
	$GLOBALS['O']        = array();
	$GLOBALS['T']        = array();
	$GLOBALS['CRON']     = array();
	$GLOBALS['HTTP_LOG'] = array();
	$GLOBALS['wpdb']->q  = array();
	update_option( 'emzagar_options', array( 'base_url' => 'https://cloud.example.com', 'api_key' => 'emz_' . str_repeat( 'a', 48 ), 'connected_at' => 0, 'wc_enabled' => 'yes', 'wc_all_orders' => 'no', 'default_template' => 0, 'wc_expiry_days' => 14, 'sync_orders' => 'yes', 'sync_customers' => 'yes' ) );
	update_option( Emzagar_Sync::OPT_SECRET, str_repeat( 'a', 64 ) );
}
function http( $fn ) {
	$GLOBALS['HTTP']     = $fn;
	$GLOBALS['HTTP_LOG'] = array();
}
function add_row( $type, $ref, $payload = null ) {
	$GLOBALS['wpdb']->insert( 'wp_emzagar_queue', array( 'event_id' => 'evt_' . $type . $ref, 'type' => $type, 'ref_id' => $ref, 'snapshot' => json_encode( $payload ?? array( 'orderId' => $ref ) ) ) );
}
function rows() {
	return array_values( $GLOBALS['wpdb']->q );
}

// ═════════ ۱) کلاینت API: HTTPS اجباری، قطع‌کننده‌ی مدار، باطل‌سازی کش ═════════
reset_world();
t( 'transport: https ok', Emzagar_API::transport_ok( 'https://x.example' ) );
t( 'transport: http remote rejected', ! Emzagar_API::transport_ok( 'http://x.example' ) );
t( 'transport: http localhost ok', Emzagar_API::transport_ok( 'http://localhost:3000' ) && Emzagar_API::transport_ok( 'http://127.0.0.1' ) );
update_option( 'emzagar_options', array( 'base_url' => 'http://cloud.example.com', 'api_key' => 'emz_' . str_repeat( 'a', 48 ) ) );
http( fn() => array( 200, array( 'ok' => true ) ) );
$r = Emzagar_API::request( 'GET', '/api/v1/stats' );
t( 'api key never sent over plain http', is_wp_error( $r ) && 'emzagar_insecure' === $r->get_error_code() && 0 === count( $GLOBALS['HTTP_LOG'] ) );

reset_world();
http( fn() => new WP_Error( 'http_request_failed', 'timeout' ) );
$r1 = Emzagar_API::request( 'GET', '/api/v1/stats' );
$n1 = count( $GLOBALS['HTTP_LOG'] );
$r2 = Emzagar_API::request( 'GET', '/api/v1/stats' );
t( 'breaker: first failure hits network', is_wp_error( $r1 ) && 1 === $n1 );
t( 'breaker: second call fails fast (no network wait)', is_wp_error( $r2 ) && 1 === count( $GLOBALS['HTTP_LOG'] ) && 'emzagar_http' === $r2->get_error_code() );
t( 'breaker error is classified transient (status 0)', 0 === $r2->get_error_data()['status'] );
$b = Emzagar_API::breaker_state();
update_option( Emzagar_API::BREAKER, array( 'until' => time() - 1, 'fails' => $b['fails'], 'at' => 0 ) );
http( fn() => array( 404, array( 'ok' => false, 'error' => 'not_found' ) ) );
Emzagar_API::request( 'GET', '/api/v1/x' );
t( 'breaker: probe after cool-down reaches cloud and closes circuit', 1 === count( $GLOBALS['HTTP_LOG'] ) && ! Emzagar_API::breaker_open() && 0 === (int) Emzagar_API::breaker_state()['fails'] );
$g1 = (int) get_option( Emzagar_API::OPT_GEN, 1 );
Emzagar_API::flush_cache();
t( 'flush_cache bumps cache generation (works with object cache)', (int) get_option( Emzagar_API::OPT_GEN ) === $g1 + 1 );
update_option( Emzagar_API::BREAKER, array( 'until' => time() + 100, 'fails' => 3, 'at' => time() ) );
Emzagar_API::flush_cache();
t( 'flush_cache keeps breaker state', Emzagar_API::breaker_open() );

// ═════════ ۲) صف همگام‌سازی: قطعی ابر داده را نمی‌سوزاند ═════════
reset_world();
add_row( 'order.upserted', 11 );
add_row( 'order.upserted', 12 );
http( fn() => new WP_Error( 'http_request_failed', 'cloud down' ) );
for ( $i = 0; $i < 30; $i++ ) {
	Emzagar_API::breaker_reset();
	Emzagar_Sync::flush( 4, true );
}
$rs = rows();
t( 'outage: 30 failed flushes keep every event (previously dropped after 10)', 2 === count( $rs ) && 0 === (int) $rs[0]->attempts && 0 === (int) $rs[1]->attempts );
http( fn() => array( 200, array( 'ok' => true, 'results' => array( array( 'id' => 'evt_order.upserted11', 'status' => 'ok' ), array( 'id' => 'evt_order.upserted12', 'status' => 'ok' ) ) ) ) );
Emzagar_API::breaker_reset();
$sent = Emzagar_Sync::flush( 4, true );
t( 'outage: events delivered after recovery', 2 === $sent && 0 === count( rows() ) && 0 === (int) Emzagar_Sync::state()['flush_fails'] );

reset_world();
add_row( 'order.upserted', 21 );
http( fn() => array( 423, array( 'ok' => false, 'error' => 'sync_paused' ) ) );
Emzagar_Sync::flush();
$st = Emzagar_Sync::state();
t( 'sync_paused: attempts not consumed', 0 === (int) rows()[0]->attempts );
t( 'sync_paused: flush deferred ~15 minutes', (int) $st['flush_block_until'] >= time() + 800 );
$calls = count( $GLOBALS['HTTP_LOG'] );
Emzagar_Sync::flush();
t( 'deferred flush does not hammer the cloud', count( $GLOBALS['HTTP_LOG'] ) === $calls );
Emzagar_Sync::flush( 4, true );
t( 'forced flush ("now" button) ignores the deferral', count( $GLOBALS['HTTP_LOG'] ) === $calls + 1 );

reset_world();
add_row( 'order.upserted', 31 );
http( fn() => array( 401, array( 'ok' => false, 'error' => 'stale_timestamp' ) ) );
Emzagar_Sync::flush();
t( 'clock skew (stale_timestamp) is a global failure, not a per-event one', 0 === (int) rows()[0]->attempts );

reset_world();
add_row( 'order.upserted', 41 );
add_row( 'order.upserted', 42 );
http( fn( $m, $u, $a ) => array( 200, array( 'ok' => true, 'results' => array( array( 'id' => 'evt_order.upserted41', 'status' => 'ok' ), array( 'id' => 'evt_order.upserted42', 'status' => 'error' ) ) ) ) );
Emzagar_Sync::flush();
$rs = rows();
t( 'per-event rejection only burns that event attempt', 1 === count( $rs ) && 42 === (int) $rs[0]->ref_id && 1 === (int) $rs[0]->attempts && (int) $rs[0]->next_at > time() );

reset_world();
add_row( 'order.upserted', 51 );
add_row( 'order.upserted', 52 );
add_row( 'order.upserted', 53 );
http(
	function ( $m, $u, $a ) {
		$ev  = json_decode( $a['body'], true )['events'];
		$bad = array_filter( $ev, fn( $e ) => 'evt_order.upserted52' === $e['id'] );
		if ( $bad ) {
			return array( 400, array( 'ok' => false, 'error' => 'invalid_payload' ) );
		}
		return array( 200, array( 'ok' => true, 'results' => array_map( fn( $e ) => array( 'id' => $e['id'], 'status' => 'ok' ), $ev ) ) );
	}
);
$sent = Emzagar_Sync::flush();
$rs   = rows();
t( 'poison event isolated: healthy neighbours delivered', 2 === $sent && 1 === count( $rs ) && 52 === (int) $rs[0]->ref_id && 1 === (int) $rs[0]->attempts );
t( 'poison isolation did not mark an outage', 0 === (int) Emzagar_Sync::state()['flush_fails'] );

reset_world();
update_option( 'emzagar_options', array_merge( emzagar_options(), array( 'sync_orders' => 'no' ) ) );
add_row( 'order.upserted', 61 );
add_row( 'customer.upserted', 62, array( 'customerId' => 62 ) );
http( fn() => array( 200, array( 'ok' => true, 'results' => array() ) ) );
Emzagar_Sync::flush();
$left = array_map( fn( $r ) => $r->type, rows() );
t( 'sync_orders=no: queued orders are dropped, never sent', 0 === count( array_filter( $GLOBALS['HTTP_LOG'], fn( $c ) => false !== strpos( $c[2]['body'] ?? '', 'order.upserted' ) ) ) && ! in_array( 'order.upserted', $left, true ) );

// ═════════ ۳) هم‌زمانی Push/Pull: قفل اتمیک و ایدمپوتنسی ═════════
reset_world();
$ev = array( array( 'id' => 'evt_a', 'type' => 'sync.ping', 'data' => array() ) );
t( 'lock: first acquire wins', Emzagar_Sync::lock_acquire( 'apply', 30 ) );
t( 'lock: second acquire loses (atomic)', ! Emzagar_Sync::lock_acquire( 'apply', 30 ) );
$res = Emzagar_Sync::apply_events( $ev );
t( 'concurrent apply: busy lock → event reported as error so the cloud re-delivers (not applied twice, not lost)', 'error' === $res[0]['status'] && ! isset( get_option( Emzagar_Sync::OPT_SEEN, array() )['evt_a'] ) );
Emzagar_Sync::lock_release( 'apply' );
$res = Emzagar_Sync::apply_events( $ev );
t( 'apply after release works', 'ok' === $res[0]['status'] );
$res = Emzagar_Sync::apply_events( $ev );
t( 'duplicate id is deduped', 'duplicate' === $res[0]['status'] );
t( 'apply releases its lock', Emzagar_Sync::lock_acquire( 'apply', 30 ) );
Emzagar_Sync::lock_release( 'apply' );
$GLOBALS['O']['emzagar_lock_apply'] = (string) ( time() - 5 );
t( 'stale lock from a crashed process is reclaimed', Emzagar_Sync::lock_acquire( 'apply', 30 ) );
Emzagar_Sync::lock_release( 'apply' );

// ═════════ ۴) ترمیم چرخشی قراردادهای باز ═════════
reset_world();
$open = array();
for ( $i = 1; $i <= 230; $i++ ) {
	$open[ $i ] = array( 'o' => 1, 't' => time() );
}
update_option( Emzagar_Sync::OPT_OPEN, $open );
$asked = array();
http(
	function ( $m, $u ) use ( &$asked ) {
		parse_str( (string) parse_url( $u, PHP_URL_QUERY ), $q );
		foreach ( explode( ',', $q['ids'] ?? '' ) as $id ) {
			$asked[ (int) $id ] = true;
		}
		return array( 200, array( 'ok' => true, 'items' => array() ) );
	}
);
Emzagar_Sync::reconcile();
t( 'reconcile: up to 200 contracts per run (was 50)', 200 === count( $asked ) );
Emzagar_Sync::reconcile();
t( 'reconcile: rotating cursor covers all 230 contracts across runs', 230 === count( $asked ) );

// ═════════ ۵) اتصال: backoff، هم‌مبدأ‌بودن SSO، HTTPS ═════════
reset_world();
update_option( 'emzagar_options', array( 'base_url' => '', 'api_key' => '' ) );
define( 'EMZAGAR_CLOUD_URL', 'https://cloud.example.com' );
update_option( Emzagar_Connect::OPT_NEXT, time() + 240 );
Emzagar_Connect::cron_connect();
$sch = array_filter( $GLOBALS['CRON'], fn( $e ) => Emzagar_Connect::HOOK_RETRY === $e[0] );
t( 'connect: cron firing before backoff expiry re-arms itself (chain no longer dies)', 1 === count( $sch ) && reset( $sch )[1] >= time() + 238 );
t( 'sso origin: same origin ok', Emzagar_Connect::same_origin( 'https://cloud.example.com/sso?t=1', 'https://cloud.example.com' ) );
t( 'sso origin: scheme downgrade rejected', ! Emzagar_Connect::same_origin( 'http://cloud.example.com/sso', 'https://cloud.example.com' ) );
t( 'sso origin: other port rejected', ! Emzagar_Connect::same_origin( 'https://cloud.example.com:8443/sso', 'https://cloud.example.com' ) );
t( 'sso origin: relative / empty base rejected', ! Emzagar_Connect::same_origin( '/login', '' ) && ! Emzagar_Connect::same_origin( '/login', 'https://cloud.example.com' ) );
t( 'sso origin: userinfo trick rejected', ! Emzagar_Connect::same_origin( 'https://cloud.example.com@evil.example/x', 'https://cloud.example.com' ) );
define( 'WP_DEBUG', true );
t( 'cloud url: WP_DEBUG alone no longer allows plain http to remote hosts', ! Emzagar_Connect::is_acceptable_cloud( 'http://cloud.example.com' ) );
t( 'cloud url: https and localhost stay valid', Emzagar_Connect::is_acceptable_cloud( 'https://cloud.example.com' ) && Emzagar_Connect::is_acceptable_cloud( 'http://localhost:3000' ) );

// ═════════ ۶) ووکامرس: صدور، یادداشت‌ها، قفل دانلود ═════════
class FakeProduct {
	public $id, $parent, $meta;
	public function __construct( $id, $tpl = 0, $parent = 0 ) {
		$this->id     = $id;
		$this->parent = $parent;
		$this->meta   = $tpl ? array( '_emzagar_template_id' => $tpl ) : array();
	}
	public function get_parent_id() {
		return $this->parent;
	}
	public function get_id() {
		return $this->id;
	}
	public function get_meta( $k ) {
		return $this->meta[ $k ] ?? '';
	}
}
class FakeItem {
	public $p;
	public function __construct( $p ) {
		$this->p = $p;
	}
	public function get_product() {
		return $this->p;
	}
	public function get_name() {
		return 'Item ' . $this->p->id;
	}
}
class FakeOrder {
	public $id, $status = 'processing', $email, $phone, $items = array(), $meta = array(), $notes = array(), $saves = 0;
	public function __construct( $id, $email, $phone, $items ) {
		$this->id    = $id;
		$this->email = $email;
		$this->phone = $phone;
		$this->items = $items;
	}
	public function get_id() {
		return $this->id;
	}
	public function get_meta( $k ) {
		return $this->meta[ $k ] ?? '';
	}
	public function update_meta_data( $k, $v ) {
		$this->meta[ $k ] = $v;
	}
	public function delete_meta_data( $k ) {
		unset( $this->meta[ $k ] );
	}
	public function save() {
		++$this->saves;
	}
	public function add_order_note( $m ) {
		$this->notes[] = $m;
	}
	public function get_billing_email() {
		return $this->email;
	}
	public function get_formatted_billing_full_name() {
		return 'Ali Test';
	}
	public function get_billing_phone( $c = 'view' ) {
		return $this->phone;
	}
	public function get_shipping_phone() {
		return '';
	}
	public function get_customer_id() {
		return 0;
	}
	public function get_items() {
		return $this->items;
	}
	public function get_order_number() {
		return (string) $this->id;
	}
	public function get_status() {
		return $this->status;
	}
	public function has_status( $s ) {
		return in_array( $this->status, (array) $s, true );
	}
	public function get_date_created() {
		return new class() {
			public function getTimestamp() {
				return time() - 500;
			}
		};
	}
	public function update_status( $s, $n = '' ) {
		$this->status = $s;
	}
}
function make_order( $id, $email, $phone, $products ) {
	$items = array();
	foreach ( $products as $p ) {
		$GLOBALS['PRODUCTS'][ $p->id ] = $p;
		$items[]                       = new FakeItem( $p );
	}
	return $GLOBALS['ORDERS'][ $id ] = new FakeOrder( $id, $email, $phone, $items );
}

reset_world();
http( fn() => array( 200, array( 'ok' => true, 'id' => 1 ) ) );
$o1 = make_order( 100, '', '', array( new FakeProduct( 5, 0 ) ) );
$r  = Emzagar_WooCommerce::maybe_issue( 100 );
t( 'order without contract products + missing email/phone: no noise, no save, no API call', empty( $o1->notes ) && 0 === $o1->saves && 0 === $r['issued'] && 0 === count( $GLOBALS['HTTP_LOG'] ) && in_array( 'no_template', $r['reasons'], true ) && ! in_array( 'no_phone', $r['reasons'], true ) );

$o2 = make_order( 101, 'a@x.com', '', array( new FakeProduct( 6, 12 ) ) );
$r  = Emzagar_WooCommerce::maybe_issue( 101 );
t( 'templated product + invalid phone: explained once', in_array( 'no_phone', $r['reasons'], true ) && 1 === count( $o2->notes ) );
Emzagar_WooCommerce::maybe_issue( 101 );
t( 'the explanation note is not duplicated', 1 === count( $o2->notes ) );

$o3 = make_order( 102, 'a@x.com', '09121234567', array( new FakeProduct( 7, 12 ) ) );
http( fn() => array( 200, array( 'ok' => true, 'id' => 77, 'signUrl' => 'https://cloud.example.com/s/abc', 'status' => 'sent' ) ) );
$r = Emzagar_WooCommerce::maybe_issue( 102 );
$e = Emzagar_WooCommerce::entries( $o3 );
t( 'issue: contract recorded on the order with idempotency key', 1 === $r['issued'] && 77 === (int) $e[7]['id'] && false !== strpos( $GLOBALS['HTTP_LOG'][0][2]['body'], 'wc:102:7' ) );
$r = Emzagar_WooCommerce::maybe_issue( 102 );
t( 'second pass issues nothing (one contract per product per order)', 0 === $r['issued'] && 1 === count( $GLOBALS['HTTP_LOG'] ) );

// قطعی ابر هنگام صدور: تلاش مجدد زمان‌بندی می‌شود، سفارش معطل نمی‌ماند
reset_world();
$o4 = make_order( 103, 'a@x.com', '09121234567', array( new FakeProduct( 8, 12 ), new FakeProduct( 9, 12 ) ) );
http( fn() => new WP_Error( 'http_request_failed', 'timeout' ) );
$r = Emzagar_WooCommerce::maybe_issue( 103 );
t( 'cloud outage: retry scheduled', 1 === (int) $o4->meta['_emzagar_retries'] && false !== wp_next_scheduled( Emzagar_WooCommerce::RETRY, array( 103 ) ) );
t( 'cloud outage: only ONE network wait for a 2-product order (circuit breaker)', 1 === count( $GLOBALS['HTTP_LOG'] ) );
$o4->meta['_emzagar_retries'] = 11;
$GLOBALS['CRON']              = array();
Emzagar_API::breaker_reset();
Emzagar_WooCommerce::maybe_issue( 103 );
t( 'retry budget now covers long outages (12 tries)', 12 === (int) $o4->meta['_emzagar_retries'] && false !== wp_next_scheduled( Emzagar_WooCommerce::RETRY, array( 103 ) ) );

// قفل دانلود: بسته‌شونده در خطا
reset_world();
update_option( 'emzagar_options', array_merge( emzagar_options(), array( 'wc_gate_downloads' => 'yes', 'connected_at' => time() - 3600 ) ) );
$o5 = make_order( 104, 'a@x.com', '09121234567', array( new FakeProduct( 10, 12 ) ) );
t( 'download gate: contract not issued yet (outage) → download blocked', false === Emzagar_WooCommerce::filter_downloads( true, $o5 ) );
$o5->meta[ Emzagar_WooCommerce::META ] = array( 10 => array( 'id' => 5, 'url' => '', 'status' => 'pending', 'pending' => 1 ) );
t( 'download gate: pending signature → blocked', false === Emzagar_WooCommerce::filter_downloads( true, $o5 ) );
$o5->meta[ Emzagar_WooCommerce::META ][10]['status'] = 'signed';
t( 'download gate: signed → permitted', true === Emzagar_WooCommerce::filter_downloads( true, $o5 ) );
$o6 = make_order( 105, 'a@x.com', '09121234567', array( new FakeProduct( 11, 0 ) ) );
t( 'download gate: product without contract is never blocked', true === Emzagar_WooCommerce::filter_downloads( true, $o6 ) );
$o7 = make_order( 106, 'a@x.com', '09121234567', array( new FakeProduct( 12, 12 ) ) );
update_option( 'emzagar_options', array_merge( emzagar_options(), array( 'connected_at' => time() + 3600 ) ) );
t( 'download gate: orders older than the connection are not suddenly locked', true === Emzagar_WooCommerce::filter_downloads( true, $o7 ) );

// ═════════ ۷) دروازه‌ی دسترسی ═════════
reset_world();
$sig = array( 'customer' => array( 'email' => 'u@x.com' ), 'contractId' => 9, 'status' => 'signed', 'templateId' => 3, 'signedAt' => '2026-01-01T00:00:00Z' );
Emzagar_Access::on_event( 'contract.signed', $sig );
t( 'access: signed indexed', Emzagar_Access::local_check( 'u@x.com', array( 3 ) ) );
$late           = $sig;
$late['status'] = 'sent';
$ok             = Emzagar_Access::on_event( 'contract.created', $late );
t( 'access: late "sent" event cannot undo a signature (out-of-order delivery)', true === $ok && Emzagar_Access::local_check( 'u@x.com', array( 3 ) ) );
$can           = $sig;
$can['status'] = 'cancelled';
Emzagar_Access::on_event( 'contract.cancelled', $can );
t( 'access: a real cancellation still revokes', ! Emzagar_Access::local_check( 'u@x.com', array( 3 ) ) );

$GLOBALS['POST_ID']             = 50;
$GLOBALS['PM'][50]['_emz_gate'] = 'any';
$GLOBALS['CAN']                 = false;
$GLOBALS['FILTERS']             = array( 'get_the_excerpt' );
t( 'gate: auto-excerpt of locked post does not leak the body', '' === Emzagar_Access::gate_content( 'SECRET BODY TEXT' ) );
$GLOBALS['CAN'] = true;
t( 'gate: editors still see the excerpt source', 'SECRET BODY TEXT' === Emzagar_Access::gate_content( 'SECRET BODY TEXT' ) );
$GLOBALS['CAN']    = false;
$GLOBALS['PM'][50] = array();
t( 'gate: ungated post excerpt untouched', 'PUBLIC' === Emzagar_Access::gate_content( 'PUBLIC' ) );
$GLOBALS['FILTERS'] = array();
unset( $GLOBALS['CAN'] );

// ═════════ ۸) فرم درخواست قرارداد: nonce گره‌خورده به قالب ═════════
reset_world();
$GLOBALS['LOGGED'] = true;
$_POST             = array( 'template_id' => '99', '_emznonce' => 'n_emzagar_request_12', 'mobile' => '09121234567', 'name' => 'X', 'redirect' => 'https://shop.example.com/p' );
$died              = '';
try {
	Emzagar_Shortcodes::handle_request();
} catch ( RuntimeException $e ) {
	$died = $e->getMessage();
}
t( 'request form: nonce issued for template 12 cannot request template 99', 0 === strpos( $died, 'wp_die' ) && 0 === count( $GLOBALS['HTTP_LOG'] ) );
$_POST['_emznonce'] = 'n_emzagar_request_99';
$_POST['name']      = str_repeat( 'ن', 150 );
http( fn() => array( 200, array( 'ok' => true, 'id' => 3 ) ) );
$redir = '';
try {
	Emzagar_Shortcodes::handle_request();
} catch ( RedirectSignal $e ) {
	$redir = $e->getMessage();
}
$sent = json_decode( $GLOBALS['HTTP_LOG'][0][2]['body'] ?? '{}', true );
t( 'request form: matching nonce works and issues that template', 99 === ( $sent['templateId'] ?? 0 ) && false !== strpos( $redir, 'emz_msg=ok' ) );
t( 'request form: name is length-limited', mb_strlen( $sent['customer']['name'] ?? '' ) <= 100 );
$_POST = array( 'template_id' => '0', '_emznonce' => 'n_emzagar_request_0' );
$died  = '';
try {
	Emzagar_Shortcodes::handle_request();
} catch ( RuntimeException $e ) {
	$died = $e->getMessage();
}
t( 'request form: template 0 rejected', 0 === strpos( $died, 'wp_die' ) );
$GLOBALS['LOGGED'] = false;
$_POST             = array();

// ═════════ ۹) IP کلاینت پشت پراکسی ═════════
$_SERVER['REMOTE_ADDR']          = '10.0.0.5';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '1.1.1.1, 198.51.100.7';
t( 'client ip: behind a local proxy the last XFF hop (appended by the proxy) is used', '198.51.100.7' === Emzagar_Limits::client_ip() );
$_SERVER['REMOTE_ADDR'] = '203.0.113.9';
t( 'client ip: forged XFF from a direct public client is ignored', '203.0.113.9' === Emzagar_Limits::client_ip() );
$_SERVER['REMOTE_ADDR']    = '127.0.0.1';
$_SERVER['HTTP_X_REAL_IP'] = '198.51.100.20';
t( 'client ip: X-Real-IP honoured from loopback proxy', '198.51.100.20' === Emzagar_Limits::client_ip() );
unset( $_SERVER['HTTP_X_FORWARDED_FOR'], $_SERVER['HTTP_X_REAL_IP'] );

echo "\nTOTAL FAIL: $fail\n";
exit( $fail ? 1 : 0 );
