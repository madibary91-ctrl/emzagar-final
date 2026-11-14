<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * «میز کار قراردادها» — مدیریت کامل قراردادها بدون خروج از وردپرس.
 *
 *  • کانبان زنده (ارسال‌شده ← مشاهده‌شده ← امضاشده / ردشده / منقضی)
 *  • فهرست قراردادها با جستجو، فیلتر و صفحه‌بندی
 *  • کشوی جزئیات: امضاکنندگان، خط زمانی، لینک امضا، یادآوری، لغو، دانلود PDF، پیوند به سفارش ووکامرس و پروفایل کاربر
 *  • صدور قرارداد جدید با جستجوی کاربران/مشتریان وردپرس (پرکردن خودکار نام، ایمیل، موبایل)
 *  • فعالیت زنده (صندوق فعالیت)
 *  • اقدام «ارسال قرارداد» در فهرست کاربران (تکی و گروهی)
 */
class Emzagar_Workspace {

	const PAGE = 'emzagar-workspace';

	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 12 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		foreach ( array( 'pipeline', 'list', 'detail', 'remind', 'cancel', 'issue', 'people' ) as $a ) {
			add_action( 'wp_ajax_emzagar_ws_' . $a, array( __CLASS__, 'ajax_' . $a ) );
		}
		add_action( 'admin_post_emzagar_ws_pdf', array( __CLASS__, 'act_pdf' ) );
		add_filter( 'user_row_actions', array( __CLASS__, 'user_row_action' ), 10, 2 );
		add_filter( 'bulk_actions-users', array( __CLASS__, 'bulk_actions' ) );
		add_filter( 'handle_bulk_actions-users', array( __CLASS__, 'handle_bulk' ), 10, 3 );
		add_action( 'admin_notices', array( __CLASS__, 'bulk_notice' ) );
	}

	/* ───────────── ابزارهای مشترک ───────────── */

	public static function url( $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::PAGE ), $args ), admin_url( 'admin.php' ) );
	}

	/** شمارنده‌ی کنش‌هایی که مدیر بدون خروج از وردپرس انجام داده (برای نمایش ارزش‌آفرینی) */
	public static function bump( $n = 1 ) {
		update_option( 'emzagar_actions', (int) get_option( 'emzagar_actions', 0 ) + (int) $n, false );
	}

	private static function ready() {
		return current_user_can( 'manage_options' ) && Emzagar_API::is_configured();
	}

	public static function menu() {
		add_submenu_page( 'emzagar', __( 'میز کار قراردادها', 'emzagar' ), __( 'میز کار قراردادها', 'emzagar' ), 'manage_options', self::PAGE, array( __CLASS__, 'render' ), 1 );
	}

	public static function assets( $hook ) {
		unset( $hook );
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( self::PAGE !== $page ) {
			return;
		}
		wp_enqueue_style( 'emzagar-hub', EMZ_URL . 'assets/css/hub.css', array(), EMZ_VERSION );
		wp_enqueue_style( 'emzagar-workspace', EMZ_URL . 'assets/css/workspace.css', array(), EMZ_VERSION );
		wp_enqueue_script( 'emzagar-workspace', EMZ_URL . 'assets/js/workspace.js', array(), EMZ_VERSION, true );
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'board'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$open = isset( $_GET['contract'] ) ? absint( $_GET['contract'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$q    = isset( $_GET['q'] ) ? sanitize_text_field( wp_unslash( $_GET['q'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		wp_localize_script(
			'emzagar-workspace',
			'EmzagarWS',
			array(
				'ajax'  => admin_url( 'admin-ajax.php' ),
				'nonce' => wp_create_nonce( 'emzagar_ws' ),
				'pdf'   => wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_ws_pdf' ), 'emzagar_ws_pdf' ),
				'tab'   => $tab,
				'open'  => $open,
				'q'     => $q,
				'rtl'   => is_rtl(),
				't'     => array(
					'loading'     => __( 'در حال بارگذاری…', 'emzagar' ),
					'empty'       => __( 'موردی نیست', 'emzagar' ),
					'error'       => __( 'ارتباط با امضاگیر برقرار نشد.', 'emzagar' ),
					'remind'      => __( 'یادآوری امضا', 'emzagar' ),
					'reminded'    => __( 'یادآوری ارسال شد ✓', 'emzagar' ),
					'cancel'      => __( 'لغو قرارداد', 'emzagar' ),
					'cancelAsk'   => __( 'این قرارداد لغو شود؟ لینک امضا باطل می‌شود و این کار قابل بازگشت نیست.', 'emzagar' ),
					'cancelled'   => __( 'قرارداد لغو شد.', 'emzagar' ),
					'copy'        => __( 'کپی لینک امضا', 'emzagar' ),
					'copied'      => __( 'لینک کپی شد ✓', 'emzagar' ),
					'pdf'         => __( 'دانلود PDF رسمی', 'emzagar' ),
					'order'       => __( 'سفارش ووکامرس', 'emzagar' ),
					'user'        => __( 'پروفایل کاربر', 'emzagar' ),
					'signers'     => __( 'امضاکنندگان', 'emzagar' ),
					'timeline'    => __( 'خط زمانی', 'emzagar' ),
					'next'        => __( 'نوبت امضا', 'emzagar' ),
					'value'       => __( 'ارزش', 'emzagar' ),
					'expires'     => __( 'مهلت امضا', 'emzagar' ),
					'issued'      => __( 'صدور', 'emzagar' ),
					'toman'       => __( 'تومان', 'emzagar' ),
					'days'        => __( 'روز', 'emzagar' ),
					'hours'       => __( 'ساعت', 'emzagar' ),
					'prev'        => __( 'قبلی', 'emzagar' ),
					'nextPage'    => __( 'بعدی', 'emzagar' ),
					'close'       => __( 'بستن', 'emzagar' ),
					'issuing'     => __( 'در حال صدور…', 'emzagar' ),
					'issueOk'     => __( 'قرارداد صادر شد و برای مشتری ارسال گردید ✓', 'emzagar' ),
					'signLink'    => __( 'لینک امضا', 'emzagar' ),
					'openList'    => __( 'مشاهده در فهرست', 'emzagar' ),
					'more'        => __( 'مورد دیگر', 'emzagar' ),
					'ageDays'     => __( 'روز پیش', 'emzagar' ),
					'expSoon'     => __( 'مهلت رو به پایان', 'emzagar' ),
					'expired'     => __( 'مهلت گذشته', 'emzagar' ),
					'pending'     => __( 'در انتظار', 'emzagar' ),
					'signed'      => __( 'امضا شد', 'emzagar' ),
					'rejected'    => __( 'رد کرد', 'emzagar' ),
					'tplRequired' => __( 'قالب قرارداد را انتخاب کنید.', 'emzagar' ),
					'noMatches'   => __( 'کاربری پیدا نشد', 'emzagar' ),
				),
			)
		);
	}

	/* ───────────── AJAX ───────────── */

	private static function guard() {
		check_ajax_referer( 'emzagar_ws', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( array( 'message' => __( 'دسترسی ندارید.', 'emzagar' ) ), 403 );
		}
	}

	private static function respond( $res ) {
		if ( is_wp_error( $res ) ) {
			$d = $res->get_error_data();
			wp_send_json_error(
				array(
					'message' => $res->get_error_message(),
					'code'    => is_array( $d ) && isset( $d['error'] ) ? $d['error'] : '',
				)
			);
		}
		wp_send_json_success( $res );
	}

	private static function post_id() {
		return isset( $_POST['id'] ) ? absint( $_POST['id'] ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing -- در guard بررسی شده
	}

	public static function ajax_pipeline() {
		self::guard();
		self::respond( Emzagar_API::request( 'GET', '/api/v1/hub/pipeline', array( 'per' => 8 ) ) );
	}

	public static function ajax_list() {
		self::guard();
		$q      = array(
			'page'  => isset( $_POST['page'] ) ? max( 1, absint( $_POST['page'] ) ) : 1, // phpcs:ignore WordPress.Security.NonceVerification.Missing
			'limit' => 15,
		);
		$status = isset( $_POST['status'] ) ? sanitize_key( wp_unslash( $_POST['status'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$search = isset( $_POST['q'] ) ? sanitize_text_field( wp_unslash( $_POST['q'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		if ( in_array( $status, array( 'sent', 'signed', 'rejected', 'expired', 'cancelled' ), true ) ) {
			$q['status'] = $status;
		}
		if ( mb_strlen( $search ) >= 2 ) {
			$q['q'] = mb_substr( $search, 0, 80 );
		}
		self::respond( Emzagar_API::request( 'GET', '/api/v1/contracts', $q ) );
	}

	public static function ajax_detail() {
		self::guard();
		$id = self::post_id();
		if ( ! $id ) {
			wp_send_json_error( array( 'message' => 'id' ), 400 );
		}
		$res = Emzagar_API::request( 'GET', '/api/v1/hub/contract/' . $id );
		if ( ! is_wp_error( $res ) && isset( $res['contract'] ) ) {
			$c                       = $res['contract'];
			$res['contract']['links'] = array(
				'order' => '',
				'user'  => '',
			);
			if ( ! empty( $c['orderId'] ) && function_exists( 'wc_get_order' ) ) {
				$order = wc_get_order( (int) $c['orderId'] );
				if ( $order && method_exists( $order, 'get_edit_order_url' ) ) {
					$res['contract']['links']['order'] = $order->get_edit_order_url();
				}
			}
			$email = isset( $c['customer']['email'] ) ? (string) $c['customer']['email'] : '';
			$u     = $email ? get_user_by( 'email', $email ) : false;
			if ( $u && current_user_can( 'edit_user', $u->ID ) ) {
				$res['contract']['links']['user'] = get_edit_user_link( $u->ID );
			}
		}
		self::respond( $res );
	}

	public static function ajax_remind() {
		self::guard();
		$id  = self::post_id();
		$res = $id ? Emzagar_API::request( 'POST', '/api/v1/contracts/' . $id . '/remind' ) : new WP_Error( 'emzagar_id', 'id' );
		if ( ! is_wp_error( $res ) ) {
			self::bump();
		}
		self::respond( $res );
	}

	public static function ajax_cancel() {
		self::guard();
		$id  = self::post_id();
		$why = isset( $_POST['reason'] ) ? sanitize_text_field( wp_unslash( $_POST['reason'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$res = $id ? Emzagar_API::request( 'POST', '/api/v1/contracts/' . $id . '/cancel', array(), array( 'reason' => $why ) ) : new WP_Error( 'emzagar_id', 'id' );
		if ( ! is_wp_error( $res ) ) {
			self::bump();
			Emzagar_API::flush_cache();
			Emzagar_Hub::invalidate();
		}
		self::respond( $res );
	}

	public static function ajax_issue() {
		self::guard();
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- در guard بررسی شده
		$tpl    = isset( $_POST['template'] ) ? absint( $_POST['template'] ) : 0;
		$name   = isset( $_POST['name'] ) ? sanitize_text_field( wp_unslash( $_POST['name'] ) ) : '';
		$email  = isset( $_POST['email'] ) ? sanitize_email( wp_unslash( $_POST['email'] ) ) : '';
		$mobile = isset( $_POST['mobile'] ) ? Emzagar_API::normalize_mobile( sanitize_text_field( wp_unslash( $_POST['mobile'] ) ) ) : '';
		$title  = isset( $_POST['title'] ) ? sanitize_text_field( wp_unslash( $_POST['title'] ) ) : '';
		$exp    = ( isset( $_POST['expiry'] ) && '' !== $_POST['expiry'] ) ? max( 0, min( 3650, absint( $_POST['expiry'] ) ) ) : null;
		// phpcs:enable
		if ( ! $tpl ) {
			wp_send_json_error( array( 'message' => __( 'قالب قرارداد را انتخاب کنید.', 'emzagar' ) ) );
		}
		if ( ! is_email( $email ) ) {
			wp_send_json_error( array( 'message' => __( 'ایمیل مشتری معتبر نیست.', 'emzagar' ) ) );
		}
		$res = Emzagar_API::issue_contract( $tpl, $name, $email, $mobile, $title, $exp );
		if ( ! is_wp_error( $res ) ) {
			self::bump();
			Emzagar_Hub::invalidate();
			if ( ! empty( $res['id'] ) ) {
				Emzagar_Inbox::add( 'issued', __( 'قرارداد صادر شد', 'emzagar' ), ( '' !== $name ? $name : $email ) . ( '' !== $title ? ' — ' . $title : '' ), (int) $res['id'] );
			}
		}
		self::respond( $res );
	}

	public static function ajax_people() {
		self::guard();
		$q = isset( $_POST['q'] ) ? sanitize_text_field( wp_unslash( $_POST['q'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		if ( mb_strlen( $q ) < 2 ) {
			wp_send_json_success( array( 'items' => array() ) );
		}
		$users = get_users(
			array(
				'search'         => '*' . $q . '*',
				'search_columns' => array( 'user_login', 'user_email', 'display_name', 'user_nicename' ),
				'number'         => 8,
				'orderby'        => 'registered',
				'order'          => 'DESC',
			)
		);
		$out   = array();
		foreach ( $users as $u ) {
			$out[] = self::person( $u );
		}
		wp_send_json_success( array( 'items' => $out ) );
	}

	/** نام/ایمیل/موبایل یک کاربر وردپرس (با خواندن فیلدهای ووکامرس و رایج) */
	public static function person( $u ) {
		$mobile = '';
		foreach ( array( 'billing_phone', 'mobile', 'phone', 'digits_phone', 'billing_mobile' ) as $k ) {
			$m = Emzagar_API::normalize_mobile( (string) get_user_meta( $u->ID, $k, true ) );
			if ( '' !== $m ) {
				$mobile = $m;
				break;
			}
		}
		$name = trim( (string) get_user_meta( $u->ID, 'billing_first_name', true ) . ' ' . (string) get_user_meta( $u->ID, 'billing_last_name', true ) );
		if ( '' === $name ) {
			$name = trim( $u->first_name . ' ' . $u->last_name );
		}
		if ( '' === $name ) {
			$name = $u->display_name;
		}
		return array(
			'id'     => (int) $u->ID,
			'name'   => $name,
			'email'  => $u->user_email,
			'mobile' => $mobile,
		);
	}

	/* ───────────── دانلود PDF (پراکسی امن؛ کلید API هرگز به مرورگر نمی‌رسد) ───────────── */

	public static function act_pdf() {
		if ( ! current_user_can( 'manage_options' ) || ! Emzagar_API::is_configured() ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( 'emzagar_ws_pdf' );
		$id = isset( $_GET['id'] ) ? absint( $_GET['id'] ) : 0;
		if ( ! $id ) {
			wp_die( esc_html__( 'شناسه نامعتبر است.', 'emzagar' ) );
		}
		$o   = emzagar_options();
		$res = wp_remote_get(
			Emzagar_API::clean_base_url( $o['base_url'] ) . '/api/v1/contracts/' . $id . '/pdf',
			array(
				'timeout'     => 40,
				'redirection' => 0,
				'headers'     => array(
					'Authorization' => 'Bearer ' . $o['api_key'],
					'Accept'        => 'application/pdf',
					'User-Agent'    => 'EmzagarWP/' . EMZ_VERSION . '; ' . home_url(),
				),
			)
		);
		$ct  = is_wp_error( $res ) ? '' : (string) wp_remote_retrieve_header( $res, 'content-type' );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) || false === stripos( $ct, 'application/pdf' ) ) {
			wp_die( esc_html__( 'دریافت PDF ممکن نشد؛ فقط قراردادهای امضاشده PDF دارند.', 'emzagar' ), '', array( 'back_link' => true ) );
		}
		$body = wp_remote_retrieve_body( $res );
		$cd   = (string) wp_remote_retrieve_header( $res, 'content-disposition' );
		$name = ( preg_match( '/filename="([A-Za-z0-9._-]{1,80})"/', $cd, $m ) ) ? $m[1] : 'contract-' . $id . '.pdf';
		self::bump();
		nocache_headers();
		header( 'Content-Type: application/pdf' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Content-Length: ' . strlen( $body ) );
		echo $body; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- فایل PDF دودویی
		exit;
	}

	/* ───────────── فهرست کاربران: ارسال قرارداد ───────────── */

	public static function user_row_action( $actions, $user ) {
		if ( self::ready() && $user instanceof WP_User ) {
			$actions['emzagar'] = '<a href="' . esc_url( self::url( array( 'tab' => 'new', 'user' => (int) $user->ID ) ) ) . '">' . esc_html__( 'ارسال قرارداد', 'emzagar' ) . '</a>';
		}
		return $actions;
	}

	public static function bulk_actions( $actions ) {
		if ( self::ready() ) {
			$actions['emzagar_issue'] = __( 'ارسال قرارداد پیش‌فرض (امضاگیر)', 'emzagar' );
		}
		return $actions;
	}

	public static function handle_bulk( $redirect, $action, $user_ids ) {
		if ( 'emzagar_issue' !== $action || ! self::ready() ) {
			return $redirect;
		}
		$o   = emzagar_options();
		$tpl = (int) $o['default_template'];
		if ( ! $tpl ) {
			return add_query_arg( 'emz_bulk_err', 'no_template', $redirect );
		}
		$ok   = 0;
		$fail = 0;
		foreach ( array_slice( array_map( 'absint', (array) $user_ids ), 0, 20 ) as $uid ) {
			$u = get_userdata( $uid );
			if ( ! $u || user_can( $u, 'manage_options' ) ) {
				continue;
			}
			$p   = self::person( $u );
			$res = Emzagar_API::issue_contract( $tpl, $p['name'], $p['email'], $p['mobile'], '', null );
			if ( is_wp_error( $res ) ) {
				++$fail;
			} else {
				++$ok;
			}
		}
		if ( $ok ) {
			self::bump( $ok );
			Emzagar_Hub::invalidate();
		}
		return add_query_arg(
			array(
				'emz_bulk_ok'   => $ok,
				'emz_bulk_fail' => $fail,
			),
			$redirect
		);
	}

	public static function bulk_notice() {
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		if ( isset( $_GET['emz_bulk_err'] ) ) {
			echo '<div class="notice notice-error is-dismissible"><p>' . esc_html__( 'برای ارسال گروهی ابتدا «قالب پیش‌فرض» را در تنظیمات امضاگیر انتخاب کنید.', 'emzagar' ) . '</p></div>';
		}
		if ( isset( $_GET['emz_bulk_ok'] ) ) {
			$ok   = absint( $_GET['emz_bulk_ok'] );
			$fail = isset( $_GET['emz_bulk_fail'] ) ? absint( $_GET['emz_bulk_fail'] ) : 0;
			/* translators: 1: sent 2: failed */
			$msg = sprintf( __( 'قرارداد برای %1$s کاربر ارسال شد. ناموفق: %2$s (معمولاً شماره‌ی موبایل معتبر ندارند).', 'emzagar' ), number_format_i18n( $ok ), number_format_i18n( $fail ) );
			echo '<div class="notice notice-' . ( $fail ? 'warning' : 'success' ) . ' is-dismissible"><p>' . esc_html( $msg ) . '</p></div>';
		}
		// phpcs:enable
	}

	/* ───────────── صفحه ───────────── */

	private static function tabs() {
		return array(
			'board'    => __( 'کانبان', 'emzagar' ),
			'list'     => __( 'همه‌ی قراردادها', 'emzagar' ),
			'new'      => __( 'صدور قرارداد جدید', 'emzagar' ),
			'activity' => __( 'فعالیت زنده', 'emzagar' ),
		);
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		update_option( 'emzagar_ws_used', 1, false );
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'board'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$tabs = self::tabs();
		if ( ! isset( $tabs[ $tab ] ) ) {
			$tab = 'board';
		}
		?>
		<div class="wrap emz-hub emz-ws" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>">
			<h1><?php esc_html_e( 'امضاگیر — میز کار قراردادها', 'emzagar' ); ?> <span class="emz-ws-hint"><kbd>Ctrl</kbd>+<kbd>K</kbd> <?php esc_html_e( 'جستجوی همه‌چیز', 'emzagar' ); ?></span></h1>
			<?php if ( ! Emzagar_API::is_configured() ) : ?>
				<div class="notice notice-warning"><p><?php esc_html_e( 'امضاگیر هنوز متصل نشده است.', 'emzagar' ); ?> <a href="<?php echo esc_url( admin_url( 'admin.php?page=emzagar' ) ); ?>"><?php esc_html_e( 'بررسی اتصال', 'emzagar' ); ?></a></p></div>
			</div>
				<?php
				return;
			endif;
			?>
			<h2 class="nav-tab-wrapper">
				<?php foreach ( $tabs as $k => $label ) : ?>
					<a class="nav-tab <?php echo $k === $tab ? 'nav-tab-active' : ''; ?>" href="<?php echo esc_url( self::url( array( 'tab' => $k ) ) ); ?>"><?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
			</h2>
			<div id="emz-ws-flash" class="emz-ws-flash" role="status" aria-live="polite" hidden></div>
			<?php
			if ( 'board' === $tab ) {
				echo '<div id="emz-ws-board" class="emz-board" aria-busy="true"></div>';
			} elseif ( 'list' === $tab ) {
				self::render_list();
			} elseif ( 'new' === $tab ) {
				self::render_new();
			} else {
				echo '<section class="emz-h-box">';
				Emzagar_Inbox::render_feed();
				echo '</section>';
			}
			?>
			<aside id="emz-ws-drawer" class="emz-drawer" aria-hidden="true" hidden>
				<div class="emz-drawer-scrim" data-emz-close></div>
				<div class="emz-drawer-panel" role="dialog" aria-modal="true" aria-label="<?php esc_attr_e( 'جزئیات قرارداد', 'emzagar' ); ?>">
					<button type="button" class="emz-drawer-x" data-emz-close aria-label="<?php esc_attr_e( 'بستن', 'emzagar' ); ?>">×</button>
					<div id="emz-ws-drawer-body"></div>
				</div>
			</aside>
		</div>
		<?php
	}

	private static function render_list() {
		?>
		<div class="emz-h-toolbar">
			<input type="search" id="emz-ws-q" class="regular-text" placeholder="<?php esc_attr_e( 'جستجوی عنوان، شماره، نام یا ایمیل مشتری…', 'emzagar' ); ?>">
			<select id="emz-ws-status">
				<option value=""><?php esc_html_e( 'همه‌ی وضعیت‌ها', 'emzagar' ); ?></option>
				<option value="sent"><?php esc_html_e( 'در انتظار امضا', 'emzagar' ); ?></option>
				<option value="signed"><?php esc_html_e( 'امضاشده', 'emzagar' ); ?></option>
				<option value="rejected"><?php esc_html_e( 'ردشده', 'emzagar' ); ?></option>
				<option value="expired"><?php esc_html_e( 'منقضی', 'emzagar' ); ?></option>
				<option value="cancelled"><?php esc_html_e( 'لغوشده', 'emzagar' ); ?></option>
			</select>
		</div>
		<section class="emz-h-box"><div id="emz-ws-list" aria-busy="true"></div><div id="emz-ws-pager" class="emz-pager"></div></section>
		<?php
	}

	private static function render_new() {
		$tpls = Emzagar_API::request( 'GET', '/api/v1/templates', array(), null, true );
		$pre  = array(
			'name'   => '',
			'email'  => '',
			'mobile' => '',
		);
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		if ( isset( $_GET['user'] ) && get_userdata( absint( $_GET['user'] ) ) ) {
			$pre = self::person( get_userdata( absint( $_GET['user'] ) ) );
		} elseif ( isset( $_GET['email'] ) ) {
			$pre['email'] = sanitize_email( wp_unslash( $_GET['email'] ) );
		}
		$sel = isset( $_GET['template'] ) ? absint( $_GET['template'] ) : (int) emzagar_options()['default_template'];
		// phpcs:enable
		?>
		<section class="emz-h-box emz-ws-new">
			<h2><?php esc_html_e( 'صدور قرارداد جدید', 'emzagar' ); ?></h2>
			<?php if ( is_wp_error( $tpls ) ) : ?>
				<p class="emz-h-empty"><?php echo esc_html( $tpls->get_error_message() ); ?></p>
			<?php else : ?>
				<form id="emz-ws-issue" autocomplete="off">
					<table class="form-table" role="presentation"><tbody>
						<tr><th><label for="emz-f-tpl"><?php esc_html_e( 'قالب قرارداد', 'emzagar' ); ?></label></th><td>
							<select id="emz-f-tpl" name="template" required>
								<option value=""><?php esc_html_e( '— انتخاب کنید —', 'emzagar' ); ?></option>
								<?php foreach ( (array) $tpls['items'] as $t ) : ?>
									<option value="<?php echo (int) $t['id']; ?>" <?php selected( $sel, (int) $t['id'] ); ?>><?php echo esc_html( $t['title'] ); ?></option>
								<?php endforeach; ?>
							</select>
						</td></tr>
						<tr><th><label for="emz-f-find"><?php esc_html_e( 'مشتری از وردپرس', 'emzagar' ); ?></label></th><td>
							<div class="emz-ac">
								<input type="search" id="emz-f-find" class="regular-text" placeholder="<?php esc_attr_e( 'جستجوی کاربر یا مشتری ووکامرس (نام/ایمیل)…', 'emzagar' ); ?>">
								<ul id="emz-f-people" class="emz-ac-list" hidden></ul>
							</div>
						</td></tr>
						<tr><th><label for="emz-f-name"><?php esc_html_e( 'نام مشتری', 'emzagar' ); ?></label></th><td><input type="text" id="emz-f-name" name="name" class="regular-text" value="<?php echo esc_attr( $pre['name'] ); ?>"></td></tr>
						<tr><th><label for="emz-f-email"><?php esc_html_e( 'ایمیل', 'emzagar' ); ?></label></th><td><input type="email" id="emz-f-email" name="email" class="regular-text" dir="ltr" required value="<?php echo esc_attr( $pre['email'] ); ?>"></td></tr>
						<tr><th><label for="emz-f-mobile"><?php esc_html_e( 'موبایل', 'emzagar' ); ?></label></th><td><input type="text" id="emz-f-mobile" name="mobile" class="regular-text" dir="ltr" placeholder="09123456789" value="<?php echo esc_attr( $pre['mobile'] ); ?>"><p class="description"><?php esc_html_e( 'برای مشتری جدید الزامی است (کد تایید پیامکی امضا).', 'emzagar' ); ?></p></td></tr>
						<tr><th><label for="emz-f-title"><?php esc_html_e( 'عنوان (اختیاری)', 'emzagar' ); ?></label></th><td><input type="text" id="emz-f-title" name="title" class="regular-text"></td></tr>
						<tr><th><label for="emz-f-exp"><?php esc_html_e( 'مهلت امضا (روز)', 'emzagar' ); ?></label></th><td><input type="number" id="emz-f-exp" name="expiry" min="0" max="3650" class="small-text" placeholder="14"></td></tr>
					</tbody></table>
					<p><button type="submit" class="button button-primary" id="emz-f-submit"><?php esc_html_e( 'صدور و ارسال برای مشتری', 'emzagar' ); ?></button></p>
					<div id="emz-f-result"></div>
				</form>
			<?php endif; ?>
		</section>
		<?php
	}
}
