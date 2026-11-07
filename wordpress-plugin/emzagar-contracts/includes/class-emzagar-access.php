<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * «دروازه‌ی قرارداد» — امضای قرارداد، کلید دسترسی سایت می‌شود.
 *
 *  • قفل قرارداد روی هر صفحه، نوشته، محصول و بخشی از محتوا ([emzagar_gate])
 *  • خرید محصول فقط پس از امضا (ووکامرس)
 *  • نقش وردپرس خودکار پس از امضا (و بازپس‌گیری پس از لغو)
 *  • شاخص محلی امضاها: حتی اگر ابر لحظه‌ای در دسترس نباشد، مشتریانِ امضاکرده بیرون نمی‌مانند
 *  • کارت مشتری در پروفایل کاربر + ستون «قرارداد» در فهرست کاربران
 *  • API توسعه‌دهنده: emzagar_user_has_signed() و هوک‌های emzagar_user_signed / emzagar_contract_signed_for_email
 */
class Emzagar_Access {

	const OPT_INDEX = 'emzagar_sig_index';
	const OPT_STATS = 'emzagar_hub_stats';
	const META_GATE = '_emz_gate';
	const META_MSG  = '_emz_gate_msg';
	const MAX_INDEX = 5000;

	/** شمارنده‌های درون‌حافظه که یک‌بار در پایان درخواست ذخیره می‌شوند */
	private static $bumps = array();

	public static function init() {
		add_action( 'add_meta_boxes', array( __CLASS__, 'meta_box' ) );
		add_action( 'save_post', array( __CLASS__, 'save_box' ), 10, 2 );
		add_filter( 'the_content', array( __CLASS__, 'gate_content' ), 7 );
		add_shortcode( 'emzagar_gate', array( __CLASS__, 'shortcode' ) );
		add_action( 'rest_api_init', array( __CLASS__, 'rest_hooks' ) );
		add_action( 'wp_login', array( __CLASS__, 'on_login' ), 10, 2 );
		add_action( 'user_register', array( __CLASS__, 'on_register' ), 10, 1 );
		add_action( 'shutdown', array( __CLASS__, 'flush_bumps' ) );
		add_action( 'admin_init', array( __CLASS__, 'ensure_role' ) );

		if ( class_exists( 'WooCommerce' ) ) {
			add_filter( 'woocommerce_add_to_cart_validation', array( __CLASS__, 'wc_validate_add' ), 10, 2 );
			add_action( 'woocommerce_check_cart_items', array( __CLASS__, 'wc_check_cart' ) );
		}
		if ( is_admin() ) {
			add_action( 'edit_user_profile', array( __CLASS__, 'profile_box' ) );
			add_filter( 'manage_users_columns', array( __CLASS__, 'user_column' ) );
			add_filter( 'manage_users_custom_column', array( __CLASS__, 'user_column_value' ), 10, 3 );
		}
	}

	/* ───────────── شاخص محلی امضاها ───────────── */

	private static function key( $email ) {
		return md5( strtolower( trim( (string) $email ) ) );
	}

	public static function index() {
		$i = get_option( self::OPT_INDEX, array() );
		return is_array( $i ) ? $i : array();
	}

	/** ثبت وضعیت یک قرارداد در شاخص. @return array|false [email, entry] */
	public static function record( $data ) {
		$email = isset( $data['customer']['email'] ) ? sanitize_email( (string) $data['customer']['email'] ) : '';
		$cid   = isset( $data['contractId'] ) ? (int) $data['contractId'] : 0;
		if ( ! $email || ! $cid || ! is_email( $email ) ) {
			return false;
		}
		$entry = array(
			't' => isset( $data['templateId'] ) ? (int) $data['templateId'] : 0,
			's' => isset( $data['status'] ) ? sanitize_key( (string) $data['status'] ) : '',
			'n' => isset( $data['number'] ) ? sanitize_text_field( (string) $data['number'] ) : '',
			'a' => ! empty( $data['signedAt'] ) ? (int) strtotime( (string) $data['signedAt'] ) : 0,
			'e' => ! empty( $data['termEndsAt'] ) ? (int) strtotime( (string) $data['termEndsAt'] ) : 0,
			'u' => time(),
		);
		$k     = self::key( $email );
		$idx   = self::index();
		$mine  = isset( $idx[ $k ] ) && is_array( $idx[ $k ] ) ? $idx[ $k ] : array();
		$mine[ $cid ] = $entry;
		unset( $idx[ $k ] );
		$idx[ $k ] = $mine; // آخرین به‌روز‌شده در انتهای فهرست
		if ( count( $idx ) > self::MAX_INDEX ) {
			$idx = array_slice( $idx, -self::MAX_INDEX, null, true );
		}
		update_option( self::OPT_INDEX, $idx, false );
		return array( $email, $entry );
	}

	/** آیا در شاخص محلی قرارداد امضاشده‌ی معتبر هست؟ (بدون تماس با ابر) */
	public static function local_check( $email, $templates = array() ) {
		$idx = self::index();
		$k   = self::key( $email );
		if ( empty( $idx[ $k ] ) || ! is_array( $idx[ $k ] ) ) {
			return false;
		}
		foreach ( $idx[ $k ] as $e ) {
			if ( ! is_array( $e ) || 'signed' !== $e['s'] ) {
				continue;
			}
			if ( ! empty( $e['e'] ) && (int) $e['e'] < time() ) {
				continue; // مدت قرارداد تمام شده
			}
			if ( empty( $templates ) || in_array( (int) $e['t'], $templates, true ) ) {
				return true;
			}
		}
		return false;
	}

	/** وضعیت دسترسی یک ایمیل: ابتدا شاخص محلی، سپس ابر (با کش کوتاه). */
	public static function status_for( $email, $templates = array() ) {
		$email     = strtolower( trim( (string) $email ) );
		$templates = array_values( array_filter( array_map( 'intval', (array) $templates ) ) );
		if ( ! is_email( $email ) ) {
			return array( 'allowed' => false, 'reason' => 'email_invalid' );
		}
		if ( self::local_check( $email, $templates ) ) {
			return array( 'allowed' => true, 'reason' => 'signed' );
		}
		if ( ! Emzagar_API::is_configured() ) {
			return array( 'allowed' => (bool) apply_filters( 'emzagar_gate_fail_open', false ), 'reason' => 'offline' );
		}
		$ck  = 'emz_acc_' . md5( $email . '|' . implode( ',', $templates ) );
		$hit = get_transient( $ck );
		if ( false !== $hit && is_array( $hit ) ) {
			return $hit;
		}
		$res = Emzagar_API::request( 'POST', '/api/v1/hub/access', array(), array( 'email' => $email, 'templateIds' => $templates ) );
		if ( is_wp_error( $res ) ) {
			$out = array( 'allowed' => (bool) apply_filters( 'emzagar_gate_fail_open', false ), 'reason' => 'offline' );
			set_transient( $ck, $out, 20 );
			return $out;
		}
		$out = array(
			'allowed' => ! empty( $res['allowed'] ),
			'reason'  => isset( $res['reason'] ) ? sanitize_key( (string) $res['reason'] ) : 'none',
		);
		if ( ! empty( $res['pending']['signUrl'] ) ) {
			$out['pending'] = array(
				'title'   => isset( $res['pending']['title'] ) ? sanitize_text_field( (string) $res['pending']['title'] ) : '',
				'signUrl' => esc_url_raw( (string) $res['pending']['signUrl'] ),
			);
		}
		if ( $out['allowed'] && ! empty( $res['contract'] ) && is_array( $res['contract'] ) ) {
			self::record(
				array(
					'customer'   => array( 'email' => $email ),
					'contractId' => (int) $res['contract']['id'],
					'status'     => 'signed',
					'number'     => isset( $res['contract']['number'] ) ? $res['contract']['number'] : '',
					'templateId' => isset( $res['contract']['templateId'] ) ? $res['contract']['templateId'] : 0,
					'signedAt'   => isset( $res['contract']['signedAt'] ) ? $res['contract']['signedAt'] : '',
					'termEndsAt' => isset( $res['contract']['termEndsAt'] ) ? $res['contract']['termEndsAt'] : '',
				)
			);
		}
		set_transient( $ck, $out, $out['allowed'] ? HOUR_IN_SECONDS : 45 );
		return $out;
	}

	/** API توسعه‌دهنده: آیا کاربر/ایمیل قرارداد امضاشده دارد؟ */
	public static function has_signed( $who, $templates = array() ) {
		$email = is_numeric( $who ) ? ( get_userdata( (int) $who ) ? get_userdata( (int) $who )->user_email : '' ) : (string) $who;
		$st    = self::status_for( $email, (array) $templates );
		return ! empty( $st['allowed'] );
	}

	/* ───────────── رویدادهای ابر ───────────── */

	/** از Emzagar_Sync::apply_one فراخوانی می‌شود. @return bool آیا بر شاخص اعمال شد */
	public static function on_event( $type, $data ) {
		unset( $type );
		$rec = self::record( is_array( $data ) ? $data : array() );
		if ( ! $rec ) {
			return false;
		}
		list( $email, $entry ) = $rec;
		if ( 'signed' === $entry['s'] ) {
			self::grant( $email, $data );
			do_action( 'emzagar_contract_signed_for_email', $email, $data );
		} elseif ( in_array( $entry['s'], array( 'cancelled', 'expired', 'rejected' ), true ) ) {
			self::maybe_revoke( $email );
		}
		return true;
	}

	/* ───────────── نقش خودکار ───────────── */

	public static function ensure_role() {
		if ( get_option( 'emzagar_role_ready' ) ) {
			return;
		}
		if ( ! get_role( 'emz_signed_client' ) ) {
			add_role( 'emz_signed_client', __( 'مشتری امضاکننده (امضاگیر)', 'emzagar' ), array( 'read' => true ) );
		}
		update_option( 'emzagar_role_ready', 1, false );
	}

	private static function role_slug() {
		$h = Emzagar_Hub::opts();
		$r = (string) $h['grant_role'];
		return ( '' !== $r && 'administrator' !== $r && get_role( $r ) ) ? $r : '';
	}

	private static function grant( $email, $data = array() ) {
		$user = get_user_by( 'email', $email );
		if ( ! $user ) {
			return;
		}
		update_user_meta( $user->ID, '_emz_signed_at', time() );
		$role = self::role_slug();
		if ( '' !== $role && ! user_can( $user, 'manage_options' ) && ! in_array( $role, (array) $user->roles, true ) ) {
			$user->add_role( $role );
			update_user_meta( $user->ID, '_emz_role_granted', $role );
		}
		do_action( 'emzagar_user_signed', $user->ID, $data );
	}

	private static function maybe_revoke( $email ) {
		$user = get_user_by( 'email', $email );
		if ( ! $user || self::local_check( $email ) ) {
			return;
		}
		$granted = (string) get_user_meta( $user->ID, '_emz_role_granted', true );
		if ( '' !== $granted ) {
			$user->remove_role( $granted );
			delete_user_meta( $user->ID, '_emz_role_granted' );
		}
		delete_user_meta( $user->ID, '_emz_signed_at' );
		do_action( 'emzagar_user_unsigned', $user->ID );
	}

	public static function on_login( $login, $user ) {
		unset( $login );
		if ( $user instanceof WP_User && self::local_check( $user->user_email ) ) {
			self::grant( $user->user_email );
		}
	}

	public static function on_register( $user_id ) {
		$u = get_userdata( (int) $user_id );
		if ( $u && self::local_check( $u->user_email ) ) {
			self::grant( $u->user_email );
		}
	}

	/* ───────────── آمار استفاده ───────────── */

	private static function bump( $k ) {
		self::$bumps[ $k ] = ( isset( self::$bumps[ $k ] ) ? self::$bumps[ $k ] : 0 ) + 1;
	}

	public static function flush_bumps() {
		if ( empty( self::$bumps ) ) {
			return;
		}
		$s = get_option( self::OPT_STATS, array() );
		$s = is_array( $s ) ? $s : array();
		foreach ( self::$bumps as $k => $n ) {
			$s[ $k ] = ( isset( $s[ $k ] ) ? (int) $s[ $k ] : 0 ) + $n;
		}
		update_option( self::OPT_STATS, $s, false );
		self::$bumps = array();
	}

	public static function stats() {
		$s = get_option( self::OPT_STATS, array() );
		$s = is_array( $s ) ? $s : array();
		return array(
			'checks'  => isset( $s['checks'] ) ? (int) $s['checks'] : 0,
			'allowed' => isset( $s['allowed'] ) ? (int) $s['allowed'] : 0,
			'denied'  => isset( $s['denied'] ) ? (int) $s['denied'] : 0,
		);
	}

	/* ───────────── تصمیم دسترسی ───────────── */

	/** نیاز قفل یک نوشته: '' | 'any' | شناسه‌ی قالب */
	public static function requirement( $post_id ) {
		$v = get_post_meta( (int) $post_id, self::META_GATE, true );
		if ( 'any' === $v ) {
			return 'any';
		}
		return (int) $v > 0 ? (int) $v : '';
	}

	/** @return array{allowed:bool,state:string,pending?:array} */
	private static function decision( $req, $allow_remote = true ) {
		if ( current_user_can( 'manage_options' ) ) {
			return array( 'allowed' => true, 'state' => 'admin' );
		}
		if ( ! is_user_logged_in() ) {
			self::bump( 'checks' );
			self::bump( 'denied' );
			return array( 'allowed' => false, 'state' => 'guest' );
		}
		$u         = wp_get_current_user();
		$templates = 'any' === $req ? array() : array( (int) $req );
		self::bump( 'checks' );
		if ( ! $allow_remote ) {
			$ok = self::local_check( $u->user_email, $templates );
			self::bump( $ok ? 'allowed' : 'denied' );
			return array( 'allowed' => $ok, 'state' => $ok ? 'signed' : 'none' );
		}
		$st = self::status_for( $u->user_email, $templates );
		self::bump( ! empty( $st['allowed'] ) ? 'allowed' : 'denied' );
		if ( ! empty( $st['allowed'] ) ) {
			return array( 'allowed' => true, 'state' => 'signed' );
		}
		$out = array( 'allowed' => false, 'state' => 'offline' === $st['reason'] ? 'offline' : ( 'pending' === $st['reason'] ? 'pending' : 'none' ) );
		if ( ! empty( $st['pending'] ) ) {
			$out['pending'] = $st['pending'];
		}
		return $out;
	}

	private static function template_title( $id ) {
		foreach ( Emzagar_Settings::templates() as $t ) {
			if ( (int) $t['id'] === (int) $id ) {
				return (string) $t['title'];
			}
		}
		return '';
	}

	private static function current_url() {
		global $wp;
		return home_url( add_query_arg( array(), isset( $wp->request ) ? $wp->request : '' ) );
	}

	/** رابط «قفل»: ورود ← امضا ← دریافت قرارداد */
	private static function lock_html( $req, $d, $custom = '', $redirect = '' ) {
		if ( ! wp_style_is( 'emzagar', 'registered' ) ) {
			wp_register_style( 'emzagar', EMZ_URL . 'assets/css/emzagar.css', array(), EMZ_VERSION );
		}
		wp_enqueue_style( 'emzagar' );
		$o       = emzagar_options();
		$redir   = '' !== $redirect ? $redirect : self::current_url();
		$title   = 'any' === $req ? '' : self::template_title( $req );
		$default = '' !== $title
			/* translators: %s: contract template title */
			? sprintf( __( 'دسترسی به این بخش پس از امضای «%s» باز می‌شود.', 'emzagar' ), $title )
			: __( 'دسترسی به این بخش پس از امضای قرارداد باز می‌شود.', 'emzagar' );
		$msg     = '' !== $custom ? $custom : $default;

		$html = '<div class="emz-lock"><span class="emz-lock-ico" aria-hidden="true">🔒</span><p class="emz-lock-msg">' . esc_html( $msg ) . '</p>';
		// پیام بازگشت از فرم درخواست
		$flash = isset( $_GET['emz_msg'] ) ? sanitize_key( wp_unslash( $_GET['emz_msg'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$notes = array(
			'ok'     => __( 'قرارداد برای شما صادر شد؛ لینک امضا به ایمیل/پیامک شما ارسال می‌شود. پس از امضا همین صفحه را تازه کنید.', 'emzagar' ),
			'mobile' => __( 'شماره‌ی موبایل معتبر وارد کنید.', 'emzagar' ),
			'rate'   => __( 'درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید.', 'emzagar' ),
			'err'    => __( 'صدور قرارداد ممکن نشد؛ لطفاً با مدیر سایت تماس بگیرید.', 'emzagar' ),
		);
		if ( isset( $notes[ $flash ] ) ) {
			$html .= '<p class="emz-notice" role="status">' . esc_html( $notes[ $flash ] ) . '</p>';
		}
		switch ( $d['state'] ) {
			case 'guest':
				$html .= '<a class="emz-btn emz-btn-primary" href="' . esc_url( wp_login_url( $redir ) ) . '">' . esc_html__( 'ورود به حساب کاربری', 'emzagar' ) . '</a>';
				break;
			case 'pending':
				if ( ! empty( $d['pending']['signUrl'] ) ) {
					$html .= '<a class="emz-btn emz-btn-primary" href="' . esc_url( $d['pending']['signUrl'] ) . '" rel="noopener">' . esc_html__( 'مشاهده و امضای قرارداد', 'emzagar' ) . '</a>';
				}
				$html .= '<p class="emz-lock-sub">' . esc_html__( 'قرارداد شما منتظر امضاست. پس از امضا همین صفحه را تازه کنید.', 'emzagar' ) . '</p>';
				break;
			case 'offline':
				$html .= '<p class="emz-lock-sub">' . esc_html__( 'در حال حاضر بررسی وضعیت قرارداد ممکن نیست؛ چند دقیقه دیگر تلاش کنید.', 'emzagar' ) . '</p>';
				break;
			default:
				if ( 'any' !== $req && Emzagar_API::is_configured() ) {
					$u      = wp_get_current_user();
					$mobile = (string) get_user_meta( $u->ID, 'emzagar_mobile', true );
					$html  .= '<form method="post" class="emz-lock-form" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
					$html  .= '<input type="hidden" name="action" value="emzagar_request"><input type="hidden" name="template_id" value="' . (int) $req . '">';
					$html  .= '<input type="hidden" name="redirect" value="' . esc_url( $redir ) . '"><input type="hidden" name="name" value="' . esc_attr( $u->display_name ) . '">';
					$html  .= '<input type="hidden" name="_emznonce" value="' . esc_attr( wp_create_nonce( 'emzagar_request' ) ) . '">';
					$html  .= '<label>' . esc_html__( 'موبایل (برای کد تایید امضا)', 'emzagar' ) . ' <input type="tel" name="mobile" dir="ltr" required value="' . esc_attr( $mobile ) . '" placeholder="09123456789"></label>';
					$html  .= '<button type="submit" class="emz-btn emz-btn-primary">' . esc_html__( 'دریافت قرارداد برای امضا', 'emzagar' ) . '</button></form>';
				} else {
					$html .= '<p class="emz-lock-sub">' . esc_html__( 'قراردادی برای حساب شما ثبت نشده است؛ با مدیر سایت تماس بگیرید.', 'emzagar' ) . '</p>';
				}
		}
		$html .= '</div>';
		return sprintf( '<div class="emz-wrap" dir="%s" style="--emz-accent:%s">%s</div>', is_rtl() ? 'rtl' : 'ltr', esc_attr( $o['accent'] ), $html );
	}

	/* ───────────── محتوا ───────────── */

	public static function gate_content( $content ) {
		$id = get_the_ID();
		if ( ! $id || doing_filter( 'get_the_excerpt' ) ) {
			return $content;
		}
		$post = get_post( $id );
		if ( ! $post || 'product' === $post->post_type ) { // محصول: فقط خرید قفل می‌شود
			return $content;
		}
		$req = self::requirement( $id );
		if ( '' === $req || current_user_can( 'edit_post', $id ) ) {
			return $content;
		}
		$d = self::decision( $req, is_singular() );
		if ( $d['allowed'] ) {
			return $content;
		}
		return self::lock_html( $req, $d, (string) get_post_meta( $id, self::META_MSG, true ), is_singular() ? '' : get_permalink( $id ) );
	}

	/** [emzagar_gate template_id="12" message="…"] محتوای محافظت‌شده [/emzagar_gate] */
	public static function shortcode( $atts, $content = '' ) {
		$a   = shortcode_atts( array( 'template_id' => 'any', 'message' => '' ), $atts, 'emzagar_gate' );
		$req = 'any' === $a['template_id'] || '' === $a['template_id'] ? 'any' : max( 0, (int) $a['template_id'] );
		if ( 0 === $req ) {
			$req = 'any';
		}
		$d = self::decision( $req, true );
		if ( $d['allowed'] ) {
			return do_shortcode( $content );
		}
		return self::lock_html( $req, $d, sanitize_text_field( $a['message'] ) );
	}

	public static function rest_hooks() {
		foreach ( get_post_types( array( 'public' => true, 'show_in_rest' => true ) ) as $pt ) {
			if ( 'product' !== $pt && 'attachment' !== $pt ) {
				add_filter( 'rest_prepare_' . $pt, array( __CLASS__, 'rest_prepare' ), 10, 2 );
			}
		}
	}

	/** محتوای قفل‌شده از طریق REST هم نشت نمی‌کند */
	public static function rest_prepare( $response, $post ) {
		$req = self::requirement( $post->ID );
		if ( '' === $req || current_user_can( 'edit_post', $post->ID ) ) {
			return $response;
		}
		$d = self::decision( $req, false );
		if ( $d['allowed'] ) {
			return $response;
		}
		$data = $response->get_data();
		if ( isset( $data['content'] ) && is_array( $data['content'] ) ) {
			$data['content']['rendered']  = '';
			$data['content']['protected'] = true;
		}
		if ( isset( $data['excerpt'] ) && is_array( $data['excerpt'] ) ) {
			$data['excerpt']['rendered'] = '';
		}
		$response->set_data( $data );
		return $response;
	}

	/* ───────────── ووکامرس: خرید پس از امضا ───────────── */

	private static function blocked_message( $product_id, $req, $d ) {
		$title = get_the_title( $product_id );
		if ( 'guest' === $d['state'] ) {
			/* translators: 1: product title, 2: login url */
			return sprintf( __( 'خرید «%1$s» نیازمند امضای قرارداد است؛ ابتدا <a href="%2$s">وارد حساب کاربری</a> شوید.', 'emzagar' ), esc_html( $title ), esc_url( wp_login_url( get_permalink( $product_id ) ) ) );
		}
		if ( ! empty( $d['pending']['signUrl'] ) ) {
			/* translators: 1: product title, 2: sign url */
			return sprintf( __( 'خرید «%1$s» پس از امضای قرارداد ممکن است؛ <a href="%2$s">قرارداد خود را امضا کنید</a> و دوباره تلاش کنید.', 'emzagar' ), esc_html( $title ), esc_url( $d['pending']['signUrl'] ) );
		}
		$tpl = 'any' === $req ? '' : self::template_title( $req );
		/* translators: 1: product title, 2: template title */
		return '' !== $tpl ? sprintf( __( 'خرید «%1$s» نیازمند امضای «%2$s» است. ابتدا از حساب کاربری خود قرارداد را دریافت و امضا کنید.', 'emzagar' ), esc_html( $title ), esc_html( $tpl ) ) : sprintf( /* translators: %s: product title */ __( 'خرید «%s» نیازمند امضای قرارداد است.', 'emzagar' ), esc_html( $title ) );
	}

	public static function wc_validate_add( $ok, $product_id ) {
		$req = self::requirement( $product_id );
		if ( '' === $req ) {
			return $ok;
		}
		$d = self::decision( $req, true );
		if ( $d['allowed'] ) {
			return $ok;
		}
		wc_add_notice( self::blocked_message( $product_id, $req, $d ), 'error' );
		return false;
	}

	public static function wc_check_cart() {
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return;
		}
		foreach ( WC()->cart->get_cart() as $item ) {
			$pid = isset( $item['product_id'] ) ? (int) $item['product_id'] : 0;
			$req = $pid ? self::requirement( $pid ) : '';
			if ( '' === $req ) {
				continue;
			}
			$d = self::decision( $req, true );
			if ( ! $d['allowed'] ) {
				wc_add_notice( self::blocked_message( $pid, $req, $d ), 'error' );
			}
		}
	}

	/* ───────────── کادر ویرایش ───────────── */

	public static function meta_box() {
		$types = array_diff( array_values( get_post_types( array( 'public' => true ) ) ), array( 'attachment' ) );
		add_meta_box( 'emzagar_gate', __( 'قفل قرارداد (امضاگیر)', 'emzagar' ), array( __CLASS__, 'render_box' ), $types, 'side', 'default' );
	}

	public static function render_box( $post ) {
		wp_nonce_field( 'emzagar_gate_save', '_emz_gate_nonce' );
		$cur = get_post_meta( $post->ID, self::META_GATE, true );
		$msg = (string) get_post_meta( $post->ID, self::META_MSG, true );
		echo '<p><label for="emz_gate"><b>' . esc_html__( 'این مورد فقط برای کسانی باز شود که:', 'emzagar' ) . '</b></label></p>';
		echo '<select id="emz_gate" name="emz_gate" style="width:100%">';
		echo '<option value="">' . esc_html__( '— قفل نیست (همه) —', 'emzagar' ) . '</option>';
		echo '<option value="any"' . selected( $cur, 'any', false ) . '>' . esc_html__( 'هر قرارداد امضاشده‌ای دارند', 'emzagar' ) . '</option>';
		foreach ( Emzagar_Settings::templates() as $t ) {
			echo '<option value="' . (int) $t['id'] . '"' . selected( (string) $cur, (string) (int) $t['id'], false ) . '>' . esc_html( sprintf( /* translators: %s: template title */ __( 'قرارداد «%s» را امضا کرده‌اند', 'emzagar' ), $t['title'] ) ) . '</option>';
		}
		echo '</select>';
		echo '<p><label for="emz_gate_msg">' . esc_html__( 'پیام دلخواه برای دیگران (اختیاری)', 'emzagar' ) . '</label><textarea id="emz_gate_msg" name="emz_gate_msg" rows="2" style="width:100%">' . esc_textarea( $msg ) . '</textarea></p>';
		if ( 'product' === $post->post_type ) {
			echo '<p class="description">' . esc_html__( 'برای محصول: افزودن به سبد و پرداخت فقط پس از امضا ممکن است.', 'emzagar' ) . '</p>';
		} else {
			echo '<p class="description">' . esc_html__( 'کاربر وارد‌نشده به ورود، و بدون قرارداد به دریافت و امضای قرارداد هدایت می‌شود.', 'emzagar' ) . '</p>';
		}
	}

	public static function save_box( $post_id, $post ) {
		if ( ! isset( $_POST['_emz_gate_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['_emz_gate_nonce'] ) ), 'emzagar_gate_save' ) ) {
			return;
		}
		if ( ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) || wp_is_post_revision( $post_id ) || ! current_user_can( 'edit_post', $post_id ) ) {
			return;
		}
		unset( $post );
		$v = isset( $_POST['emz_gate'] ) ? sanitize_text_field( wp_unslash( $_POST['emz_gate'] ) ) : '';
		if ( 'any' === $v || (int) $v > 0 ) {
			update_post_meta( $post_id, self::META_GATE, 'any' === $v ? 'any' : (string) (int) $v );
		} else {
			delete_post_meta( $post_id, self::META_GATE );
		}
		$m = isset( $_POST['emz_gate_msg'] ) ? sanitize_textarea_field( wp_unslash( $_POST['emz_gate_msg'] ) ) : '';
		if ( '' !== $m ) {
			update_post_meta( $post_id, self::META_MSG, mb_substr( $m, 0, 300 ) );
		} else {
			delete_post_meta( $post_id, self::META_MSG );
		}
		if ( class_exists( 'Emzagar_Hub' ) ) {
			Emzagar_Hub::invalidate();
		}
	}

	/** فهرست محتوای قفل‌شده (برای مرکز فرماندهی) */
	public static function gated_items( $limit = 30 ) {
		$q = new WP_Query(
			array(
				'post_type'      => 'any',
				'post_status'    => array( 'publish', 'draft', 'pending', 'private' ),
				'posts_per_page' => (int) $limit,
				'meta_query'     => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					array(
						'key'     => self::META_GATE,
						'value'   => '',
						'compare' => '!=',
					),
				),
				'no_found_rows'  => true,
			)
		);
		return $q->posts;
	}

	/* ───────────── پروفایل کاربر و ستون کاربران ───────────── */

	public static function user_column( $cols ) {
		$cols['emz_contracts'] = __( 'قرارداد', 'emzagar' );
		return $cols;
	}

	public static function user_column_value( $value, $column, $user_id ) {
		if ( 'emz_contracts' !== $column ) {
			return $value;
		}
		$u = get_userdata( (int) $user_id );
		if ( ! $u ) {
			return '—';
		}
		$idx = self::index();
		$k   = self::key( $u->user_email );
		if ( empty( $idx[ $k ] ) ) {
			return '—';
		}
		$signed  = 0;
		$pending = 0;
		foreach ( $idx[ $k ] as $e ) {
			if ( 'signed' === $e['s'] ) {
				++$signed;
			} elseif ( 'sent' === $e['s'] ) {
				++$pending;
			}
		}
		$out = '';
		if ( $signed ) {
			/* translators: %s: count */
			$out .= '<span class="emz-badge emz-badge-signed">' . esc_html( sprintf( __( '%s امضاشده', 'emzagar' ), number_format_i18n( $signed ) ) ) . '</span> ';
		}
		if ( $pending ) {
			/* translators: %s: count */
			$out .= '<span class="emz-badge emz-badge-pending">' . esc_html( sprintf( __( '%s در انتظار', 'emzagar' ), number_format_i18n( $pending ) ) ) . '</span>';
		}
		return '' !== $out ? $out : '—';
	}

	public static function profile_box( $user ) {
		if ( ! current_user_can( 'manage_options' ) || ! Emzagar_API::is_configured() || ! class_exists( 'Emzagar_Hub' ) ) {
			return;
		}
		$card = Emzagar_Hub::customer_card( $user->user_email );
		echo '<h2>' . esc_html__( 'امضاگیر — کارت مشتری', 'emzagar' ) . '</h2>';
		if ( is_wp_error( $card ) || empty( $card['customer'] ) ) {
			echo '<p>' . esc_html__( 'اطلاعات مشتری در دسترس نیست.', 'emzagar' ) . '</p>';
			return;
		}
		$c = $card['customer'];
		$t = $c['totals'];
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th>' . esc_html__( 'خلاصه', 'emzagar' ) . '</th><td>';
		/* translators: 1: signed count, 2: pending count, 3: orders count */
		echo esc_html( sprintf( __( '%1$s قرارداد امضاشده • %2$s در انتظار • %3$s سفارش', 'emzagar' ), number_format_i18n( (int) $t['signed'] ), number_format_i18n( (int) $t['pending'] ), number_format_i18n( (int) $t['orders'] ) ) );
		if ( ! empty( $t['lifetimeSpend'] ) ) {
			echo ' • ' . esc_html( sprintf( /* translators: %s: amount */ __( 'مجموع خرید: %s', 'emzagar' ), number_format_i18n( (float) $t['lifetimeSpend'] ) ) );
		}
		echo '</td></tr>';
		if ( ! empty( $c['contracts'] ) ) {
			echo '<tr><th>' . esc_html__( 'قراردادها', 'emzagar' ) . '</th><td>';
			$labels = Emzagar_WooCommerce::status_labels();
			foreach ( array_slice( $c['contracts'], 0, 8 ) as $r ) {
				$st = Emzagar_WooCommerce::map_status( $r['status'] );
				echo '<div style="margin-bottom:4px"><span class="emz-badge emz-badge-' . esc_attr( $st ) . '">' . esc_html( isset( $labels[ $st ] ) ? $labels[ $st ] : $st ) . '</span> ';
				echo esc_html( $r['number'] . ' — ' . $r['title'] );
				if ( isset( $r['termDays'] ) && null !== $r['termDays'] && 'signed' === $r['status'] ) {
					echo ' <em>(' . esc_html( $r['termDays'] >= 0 ? sprintf( /* translators: %s: days */ __( '%s روز تا پایان مدت', 'emzagar' ), number_format_i18n( (int) $r['termDays'] ) ) : __( 'مدت تمام شده', 'emzagar' ) ) . ')</em>';
				}
				echo '</div>';
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
	}
}

/** API عمومی توسعه‌دهندگان و افزونه‌های دیگر (عضویت، LMS، رزرو …) */
function emzagar_user_has_signed( $user_or_email, $template_id = 0 ) {
	return Emzagar_Access::has_signed( $user_or_email, $template_id ? array( (int) $template_id ) : array() );
}
