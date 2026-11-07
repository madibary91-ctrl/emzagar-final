<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * «صندوق فعالیت» زنده داخل وردپرس.
 *
 *  • هر رویداد مهم قرارداد (امضا، رد، انقضا، لغو، صدور از فرم) و هر «وظیفه»ی ساخته‌شده توسط اتوماسیون‌ها اینجا جمع می‌شود
 *  • زنگ اعلان روی نوار مدیریت با تعداد خوانده‌نشده
 *  • اعلان لحظه‌ای (Toast) در همه‌ی صفحه‌های پیشخوان با WordPress Heartbeat — بدون رفرش
 */
class Emzagar_Inbox {

	const OPT  = 'emzagar_feed';
	const MAX  = 100;
	const SEEN = '_emz_feed_seen';

	public static function init() {
		add_action( 'emzagar_contract_event', array( __CLASS__, 'on_event' ), 20, 2 );
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 95 );
		add_action( 'admin_head', array( __CLASS__, 'bar_style' ) );
		add_action( 'wp_head', array( __CLASS__, 'bar_style' ) );
		if ( is_admin() ) {
			add_filter( 'heartbeat_received', array( __CLASS__, 'heartbeat' ), 10, 2 );
			add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
			add_action( 'wp_ajax_emzagar_feed_seen', array( __CLASS__, 'ajax_seen' ) );
		}
	}

	public static function enabled() {
		$h = Emzagar_Hub::opts();
		return 'yes' === $h['live'] && Emzagar_API::is_configured() && current_user_can( 'manage_options' );
	}

	/* ───────────── ذخیره‌سازی ───────────── */

	public static function items() {
		$f = get_option( self::OPT, array() );
		return is_array( $f ) ? $f : array();
	}

	/**
	 * افزودن یک مورد به صندوق.
	 *
	 * @param string $kind  signed|rejected|expired|cancelled|issued|task|info
	 * @param string $title عنوان کوتاه
	 * @param string $text  توضیح
	 * @param int    $cid   شناسه‌ی قرارداد (۰ = بدون قرارداد)
	 */
	public static function add( $kind, $title, $text = '', $cid = 0 ) {
		$items = self::items();
		$key   = $cid ? $cid . ':' . $kind : '';
		if ( '' !== $key && 'task' !== $kind ) {
			foreach ( array_slice( $items, 0, 15 ) as $it ) {
				if ( isset( $it['k'] ) && $it['k'] === $key ) {
					return false; // رویداد تکراری (مثلاً signed و completed)
				}
			}
		}
		$id = (int) round( microtime( true ) * 1000 );
		if ( ! empty( $items ) && isset( $items[0]['id'] ) && (int) $items[0]['id'] >= $id ) {
			$id = (int) $items[0]['id'] + 1;
		}
		array_unshift(
			$items,
			array(
				'id'   => $id,
				'k'    => $key,
				'kind' => sanitize_key( $kind ),
				'ts'   => time(),
				'ti'   => mb_substr( wp_strip_all_tags( (string) $title ), 0, 160 ),
				'tx'   => mb_substr( wp_strip_all_tags( (string) $text ), 0, 300 ),
				'cid'  => (int) $cid,
			)
		);
		update_option( self::OPT, array_slice( $items, 0, self::MAX ), false );
		return $id;
	}

	public static function on_event( $type, $data ) {
		$d      = is_array( $data ) ? $data : array();
		$cid    = isset( $d['contractId'] ) ? (int) $d['contractId'] : 0;
		$num    = isset( $d['number'] ) ? (string) $d['number'] : '';
		$cust   = isset( $d['customer']['name'] ) && '' !== $d['customer']['name'] ? (string) $d['customer']['name'] : ( isset( $d['customer']['email'] ) ? (string) $d['customer']['email'] : '' );
		$title  = isset( $d['title'] ) ? (string) $d['title'] : $num;
		$who    = '' !== $cust ? ' — ' . $cust : '';
		$pend   = isset( $d['pendingSigners'] ) ? (int) $d['pendingSigners'] : 0;
		$status = isset( $d['status'] ) ? (string) $d['status'] : '';
		$kind   = '';
		$label  = '';
		if ( 'contract.completed' === $type || ( 'contract.signed' === $type && ( 'signed' === $status || 0 === $pend ) ) ) {
			$kind  = 'signed';
			$label = __( 'قرارداد امضا شد ✓', 'emzagar' );
		} elseif ( 'contract.signed' === $type ) {
			$kind  = 'partial';
			$label = __( 'یکی از طرفین امضا کرد', 'emzagar' );
		} elseif ( 'contract.rejected' === $type ) {
			$kind  = 'rejected';
			$label = __( 'قرارداد رد شد', 'emzagar' );
		} elseif ( 'contract.expired' === $type ) {
			$kind  = 'expired';
			$label = __( 'مهلت امضا تمام شد', 'emzagar' );
		} elseif ( 'contract.cancelled' === $type ) {
			$kind  = 'cancelled';
			$label = __( 'قرارداد لغو شد', 'emzagar' );
		}
		if ( '' === $kind || ! $cid ) {
			return;
		}
		self::add( $kind, $label, $title . ' (' . $num . ')' . $who, $cid );
	}

	/* ───────────── خوانده/نخوانده ───────────── */

	public static function last_id() {
		$i = self::items();
		return empty( $i ) ? 0 : (int) $i[0]['id'];
	}

	public static function unread( $user_id = 0 ) {
		$uid  = $user_id ? $user_id : get_current_user_id();
		$seen = (int) get_user_meta( $uid, self::SEEN, true );
		$n    = 0;
		foreach ( self::items() as $it ) {
			if ( (int) $it['id'] > $seen && 'partial' !== $it['kind'] ) {
				++$n;
			}
		}
		return $n;
	}

	public static function mark_seen( $user_id = 0 ) {
		$uid = $user_id ? $user_id : get_current_user_id();
		update_user_meta( $uid, self::SEEN, self::last_id() );
	}

	public static function ajax_seen() {
		check_ajax_referer( 'emzagar_feed', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( null, 403 );
		}
		self::mark_seen();
		wp_send_json_success();
	}

	public static function icon( $kind ) {
		$m = array(
			'signed'    => '✅',
			'partial'   => '✍️',
			'rejected'  => '⛔',
			'expired'   => '⏰',
			'cancelled' => '🚫',
			'issued'    => '📨',
			'task'      => '📌',
			'info'      => 'ℹ️',
		);
		return isset( $m[ $kind ] ) ? $m[ $kind ] : '•';
	}

	/* ───────────── نوار مدیریت ───────────── */

	public static function bar_style() {
		if ( ! is_admin_bar_showing() || ! current_user_can( 'manage_options' ) ) {
			return;
		}
		echo '<style>#wp-admin-bar-emzagar-feed .emz-feed-count{display:inline-block;min-width:18px;padding:0 6px;margin-inline-start:4px;border-radius:99px;background:#dc2626;color:#fff;font-size:11px;line-height:18px;text-align:center}#wp-admin-bar-emzagar-feed .emz-feed-count.is-zero{display:none}#wp-admin-bar-emzagar-feed .ab-item{white-space:normal!important;height:auto!important;line-height:1.5!important}#wp-admin-bar-emzagar-search .ab-item kbd{background:rgba(255,255,255,.15);border-radius:4px;padding:0 5px;font-size:10px;margin-inline-start:4px}</style>';
	}

	public static function admin_bar( $bar ) {
		if ( ! self::enabled() ) {
			return;
		}
		$n = self::unread();
		$bar->add_node(
			array(
				'id'    => 'emzagar-feed',
				'title' => '<span class="ab-icon dashicons dashicons-bell" style="margin-top:2px"></span><span class="emz-feed-count' . ( 0 === $n ? ' is-zero' : '' ) . '">' . esc_html( number_format_i18n( $n ) ) . '</span>',
				'href'  => Emzagar_Workspace::url( array( 'tab' => 'activity' ) ),
				'meta'  => array( 'title' => esc_attr__( 'فعالیت‌های امضاگیر', 'emzagar' ) ),
			)
		);
		$shown = 0;
		foreach ( self::items() as $it ) {
			if ( $shown >= 6 ) {
				break;
			}
			++$shown;
			$href = ! empty( $it['cid'] ) ? Emzagar_Workspace::url( array( 'contract' => (int) $it['cid'] ) ) : Emzagar_Workspace::url( array( 'tab' => 'activity' ) );
			$bar->add_node(
				array(
					'parent' => 'emzagar-feed',
					'id'     => 'emzagar-feed-' . (int) $it['id'],
					'title'  => esc_html( self::icon( $it['kind'] ) . ' ' . $it['ti'] ) . '<br><small style="opacity:.75">' . esc_html( $it['tx'] ) . '</small>',
					'href'   => $href,
				)
			);
		}
		if ( 0 === $shown ) {
			$bar->add_node(
				array(
					'parent' => 'emzagar-feed',
					'id'     => 'emzagar-feed-empty',
					'title'  => esc_html__( 'هنوز فعالیتی ثبت نشده است.', 'emzagar' ),
					'href'   => Emzagar_Workspace::url( array( 'tab' => 'activity' ) ),
				)
			);
		}
	}

	/* ───────────── Heartbeat + Toast ───────────── */

	public static function assets() {
		if ( ! self::enabled() ) {
			return;
		}
		wp_enqueue_script( 'emzagar-inbox', EMZ_URL . 'assets/js/inbox.js', array( 'heartbeat' ), EMZ_VERSION, true );
		wp_localize_script(
			'emzagar-inbox',
			'EmzagarInbox',
			array(
				'lastId' => self::last_id(),
				'nonce'  => wp_create_nonce( 'emzagar_feed' ),
				'ajax'   => admin_url( 'admin-ajax.php' ),
				'open'   => esc_url_raw( Emzagar_Workspace::url( array( 'tab' => 'activity' ) ) ),
				'base'   => esc_url_raw( Emzagar_Workspace::url() ),
			)
		);
		wp_enqueue_style( 'emzagar-inbox', EMZ_URL . 'assets/css/inbox.css', array(), EMZ_VERSION );
	}

	public static function heartbeat( $response, $data ) {
		if ( ! isset( $data['emz_feed'] ) || ! current_user_can( 'manage_options' ) ) {
			return $response;
		}
		$since = (int) $data['emz_feed'];
		$new   = array();
		foreach ( self::items() as $it ) {
			if ( (int) $it['id'] <= $since ) {
				break;
			}
			if ( 'partial' === $it['kind'] ) {
				continue;
			}
			$new[] = array(
				'id'   => (int) $it['id'],
				'icon' => self::icon( $it['kind'] ),
				'ti'   => $it['ti'],
				'tx'   => $it['tx'],
				'cid'  => (int) $it['cid'],
			);
			if ( count( $new ) >= 3 ) {
				break;
			}
		}
		$c                    = Emzagar_Hub::cached();
		$response['emz_feed'] = array(
			'lastId'  => self::last_id(),
			'unread'  => self::unread(),
			'pending' => $c && isset( $c['data']['kpi']['pending'] ) ? (int) $c['data']['kpi']['pending'] : null,
			'items'   => array_reverse( $new ),
		);
		return $response;
	}

	/* ───────────── نمایش در میز کار ───────────── */

	public static function render_feed() {
		$items = self::items();
		$seen  = (int) get_user_meta( get_current_user_id(), self::SEEN, true );
		if ( empty( $items ) ) {
			echo '<p class="emz-h-empty">' . esc_html__( 'هنوز فعالیتی ثبت نشده است. با امضا، رد یا انقضای قراردادها اینجا به‌صورت زنده پر می‌شود.', 'emzagar' ) . '</p>';
			return;
		}
		echo '<ul class="emz-feed">';
		foreach ( $items as $it ) {
			$fresh = (int) $it['id'] > $seen;
			echo '<li class="emz-feed-item' . ( $fresh ? ' is-new' : '' ) . '"><span class="emz-feed-ico">' . esc_html( self::icon( $it['kind'] ) ) . '</span><div><b>' . esc_html( $it['ti'] ) . '</b><br><small>' . esc_html( $it['tx'] ) . '</small></div><span class="emz-feed-time">' . esc_html( sprintf( /* translators: %s: relative time */ __( '%s پیش', 'emzagar' ), human_time_diff( (int) $it['ts'], time() ) ) ) . '</span>';
			if ( ! empty( $it['cid'] ) ) {
				echo '<a class="button button-small" href="' . esc_url( Emzagar_Workspace::url( array( 'contract' => (int) $it['cid'] ) ) ) . '">' . esc_html__( 'باز کردن', 'emzagar' ) . '</a>';
			}
			echo '</li>';
		}
		echo '</ul>';
		self::mark_seen();
	}
}
