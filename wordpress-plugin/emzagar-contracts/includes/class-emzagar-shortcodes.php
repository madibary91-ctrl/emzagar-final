<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * شورت‌کدها: [emzagar_dashboard]  [emzagar_stats]  [emzagar_request_contract]
 * متدهای render_* مستقیماً توسط ویجت‌های المنتور هم استفاده می‌شوند.
 */
class Emzagar_Shortcodes {

	const STATUSES = array(
		'sent'      => 'ارسال شده',
		'signed'    => 'امضا شده',
		'rejected'  => 'رد شده',
		'expired'   => 'منقضی شده',
		'cancelled' => 'لغو شده',
	);

	public static function init() {
		add_shortcode( 'emzagar_dashboard', array( __CLASS__, 'dashboard' ) );
		add_shortcode( 'emzagar_stats', array( __CLASS__, 'stats' ) );
		add_shortcode( 'emzagar_request_contract', array( __CLASS__, 'request_form' ) );
		add_action( 'admin_post_emzagar_request', array( __CLASS__, 'handle_request' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'register_assets' ) );
	}

	public static function register_assets() {
		wp_register_style( 'emzagar', EMZ_URL . 'assets/css/emzagar.css', array(), EMZ_VERSION );
	}

	/** استایل فقط در صفحاتی که شورت‌کد دارند بارگذاری می‌شود (در المنتور هم کار می‌کند) */
	private static function enqueue() {
		if ( ! wp_style_is( 'emzagar', 'registered' ) ) {
			self::register_assets();
		}
		wp_enqueue_style( 'emzagar' );
	}

	private static function wrap( $inner, $class = '' ) {
		$o = emzagar_options();
		return sprintf(
			'<div class="emz-wrap %s" dir="%s" style="--emz-accent:%s">%s</div>',
			esc_attr( $class ),
			is_rtl() ? 'rtl' : 'ltr',
			esc_attr( $o['accent'] ),
			$inner
		);
	}

	private static function notice( $text, $type = 'info' ) {
		self::enqueue();
		return self::wrap( '<p class="emz-notice emz-' . esc_attr( $type ) . '" role="status">' . wp_kses_post( $text ) . '</p>' );
	}

	/** ایمیلی که باید قراردادهایش نمایش داده شود، یا WP_Error/متن راهنما */
	private static function resolve_scope( $scope ) {
		if ( ! Emzagar_API::is_configured() ) {
			return current_user_can( 'manage_options' )
				? array( 'error' => esc_html__( 'امضاگیر هنوز وصل نشده است؛ از منوی «امضاگیر» در پیشخوان وردپرس وضعیت اتصال را ببینید.', 'emzagar' ) )
				: array( 'error' => esc_html__( 'این بخش موقتاً در دسترس نیست.', 'emzagar' ) );
		}
		if ( 'all' === $scope ) {
			if ( ! current_user_can( 'manage_options' ) ) {
				return array( 'error' => esc_html__( 'دسترسی به این بخش فقط برای مدیر سایت ممکن است.', 'emzagar' ) );
			}
			return array( 'email' => '' );
		}
		if ( ! is_user_logged_in() ) {
			$url = wp_login_url( self::current_url() );
			return array( 'error' => sprintf( '%s <a href="%s">%s</a>', esc_html__( 'برای مشاهده‌ی قراردادهای خود وارد حساب کاربری شوید.', 'emzagar' ), esc_url( $url ), esc_html__( 'ورود', 'emzagar' ) ) );
		}
		$user = wp_get_current_user();
		return array( 'email' => strtolower( $user->user_email ) );
	}

	private static function current_url() {
		global $wp;
		return isset( $wp ) ? home_url( add_query_arg( array(), $wp->request ) ) : home_url( '/' );
	}

	/* ───────────── [emzagar_dashboard] ───────────── */

	public static function dashboard( $atts = array() ) {
		return self::render_dashboard( $atts );
	}

	public static function render_dashboard( $atts = array() ) {
		$a = shortcode_atts(
			array(
				'status'     => '',
				'per_page'   => 10,
				'show_stats' => 'yes',
				'scope'      => 'mine',
				'title'      => '',
			),
			(array) $atts,
			'emzagar_dashboard'
		);
		self::enqueue();
		$scope = 'all' === $a['scope'] ? 'all' : 'mine';
		$ctx   = self::resolve_scope( $scope );
		if ( isset( $ctx['error'] ) ) {
			return self::notice( $ctx['error'], 'warn' );
		}

		// فیلتر و صفحه از آدرس (فقط مقدارهای مجاز)
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		$status = isset( $_GET['emz_status'] ) ? sanitize_key( wp_unslash( $_GET['emz_status'] ) ) : sanitize_key( $a['status'] );
		$page   = isset( $_GET['emz_page'] ) ? max( 1, (int) $_GET['emz_page'] ) : 1;
		// phpcs:enable
		if ( $status && ! isset( self::STATUSES[ $status ] ) ) {
			$status = '';
		}
		$per = max( 1, min( 50, (int) $a['per_page'] ) );

		$q = array( 'page' => $page, 'limit' => $per );
		if ( $ctx['email'] ) {
			$q['email'] = $ctx['email'];
		}
		if ( $status ) {
			$q['status'] = $status;
		}
		$res = Emzagar_API::request( 'GET', '/api/v1/contracts', $q, null, true );
		if ( is_wp_error( $res ) ) {
			return self::notice( esc_html( $res->get_error_message() ), 'error' );
		}

		$html = '';
		if ( $a['title'] ) {
			$html .= '<h3 class="emz-title">' . esc_html( $a['title'] ) . '</h3>';
		}
		if ( 'no' !== $a['show_stats'] ) {
			$html .= self::stats_cards( $ctx['email'] );
		}
		$html .= self::filters( $status );
		$html .= self::table( $res['items'] );
		$html .= self::pagination( (int) $res['page'], (int) ceil( max( 1, (int) $res['total'] ) / $per ) );
		return self::wrap( $html, 'emz-dashboard' );
	}

	private static function stats_cards( $email ) {
		$count = function ( $status ) use ( $email ) {
			$q = array( 'limit' => 1 );
			if ( $email ) {
				$q['email'] = $email;
			}
			if ( $status ) {
				$q['status'] = $status;
			}
			$r = Emzagar_API::request( 'GET', '/api/v1/contracts', $q, null, true );
			return is_wp_error( $r ) ? 0 : (int) $r['total'];
		};
		$total   = $count( '' );
		$signed  = $count( 'signed' );
		$pending = $count( 'sent' );
		$rate    = $total > 0 ? round( $signed / $total * 100 ) : 0;
		return self::cards(
			array(
				array( __( 'کل قراردادها', 'emzagar' ), number_format_i18n( $total ) ),
				array( __( 'امضا شده', 'emzagar' ), number_format_i18n( $signed ) ),
				array( __( 'در انتظار امضا', 'emzagar' ), number_format_i18n( $pending ) ),
				array( __( 'نرخ تکمیل', 'emzagar' ), number_format_i18n( $rate ) . '٪' ),
			)
		);
	}

	private static function cards( $items ) {
		$h = '<div class="emz-cards">';
		foreach ( $items as $c ) {
			$h .= '<div class="emz-card"><span class="emz-card-label">' . esc_html( $c[0] ) . '</span><b class="emz-card-value">' . esc_html( $c[1] ) . '</b></div>';
		}
		return $h . '</div>';
	}

	private static function filters( $active ) {
		$base = remove_query_arg( array( 'emz_status', 'emz_page' ) );
		$h    = '<nav class="emz-filters" aria-label="' . esc_attr__( 'فیلتر وضعیت', 'emzagar' ) . '">';
		$all  = array( '' => __( 'همه', 'emzagar' ) ) + array_map( 'esc_html', self::STATUSES );
		foreach ( $all as $key => $label ) {
			$url = $key ? add_query_arg( 'emz_status', $key, $base ) : $base;
			$h  .= sprintf( '<a class="emz-chip%s" href="%s"%s>%s</a>', $key === $active ? ' is-active' : '', esc_url( $url ), $key === $active ? ' aria-current="true"' : '', esc_html( $label ) );
		}
		return $h . '</nav>';
	}

	private static function table( $items ) {
		if ( empty( $items ) ) {
			return '<p class="emz-empty">' . esc_html__( 'قراردادی برای نمایش وجود ندارد.', 'emzagar' ) . '</p>';
		}
		$h  = '<div class="emz-table-wrap"><table class="emz-table"><thead><tr>';
		$h .= '<th>' . esc_html__( 'شماره', 'emzagar' ) . '</th><th>' . esc_html__( 'عنوان', 'emzagar' ) . '</th><th>' . esc_html__( 'تاریخ صدور', 'emzagar' ) . '</th><th>' . esc_html__( 'وضعیت', 'emzagar' ) . '</th><th></th>';
		$h .= '</tr></thead><tbody>';
		foreach ( $items as $c ) {
			$status = isset( $c['status'] ) ? sanitize_key( $c['status'] ) : '';
			$label  = isset( $c['statusLabel'] ) ? $c['statusLabel'] : $status;
			$date   = ! empty( $c['issuedAt'] ) ? wp_date( get_option( 'date_format' ), strtotime( $c['issuedAt'] ) ) : '—';
			$link   = '';
			if ( ! empty( $c['shortUrl'] ) ) {
				$cta  = 'sent' === $status ? __( 'مشاهده و امضا', 'emzagar' ) : __( 'مشاهده', 'emzagar' );
				$link = '<a class="emz-btn" href="' . esc_url( $c['shortUrl'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $cta ) . '</a>';
			}
			$h .= '<tr>';
			$h .= '<td data-label="' . esc_attr__( 'شماره', 'emzagar' ) . '" dir="ltr">' . esc_html( $c['number'] ) . '</td>';
			$h .= '<td data-label="' . esc_attr__( 'عنوان', 'emzagar' ) . '">' . esc_html( $c['title'] ) . '</td>';
			$h .= '<td data-label="' . esc_attr__( 'تاریخ صدور', 'emzagar' ) . '">' . esc_html( $date ) . '</td>';
			$h .= '<td data-label="' . esc_attr__( 'وضعیت', 'emzagar' ) . '"><span class="emz-badge emz-s-' . esc_attr( $status ) . '">' . esc_html( $label ) . '</span></td>';
			$h .= '<td>' . $link . '</td></tr>';
		}
		return $h . '</tbody></table></div>';
	}

	private static function pagination( $page, $pages ) {
		if ( $pages <= 1 ) {
			return '';
		}
		$h = '<nav class="emz-pager" aria-label="' . esc_attr__( 'صفحه‌بندی', 'emzagar' ) . '">';
		if ( $page > 1 ) {
			$h .= '<a class="emz-chip" href="' . esc_url( add_query_arg( 'emz_page', $page - 1 ) ) . '">' . esc_html__( 'قبلی', 'emzagar' ) . '</a>';
		}
		/* translators: 1: current page, 2: total pages */
		$h .= '<span>' . esc_html( sprintf( __( 'صفحه %1$s از %2$s', 'emzagar' ), number_format_i18n( $page ), number_format_i18n( $pages ) ) ) . '</span>';
		if ( $page < $pages ) {
			$h .= '<a class="emz-chip" href="' . esc_url( add_query_arg( 'emz_page', $page + 1 ) ) . '">' . esc_html__( 'بعدی', 'emzagar' ) . '</a>';
		}
		return $h . '</nav>';
	}

	/* ───────────── [emzagar_stats] ───────────── */

	public static function stats( $atts = array() ) {
		return self::render_stats( $atts );
	}

	public static function render_stats( $atts = array() ) {
		$a = shortcode_atts( array( 'scope' => 'mine' ), (array) $atts, 'emzagar_stats' );
		self::enqueue();
		$ctx = self::resolve_scope( 'all' === $a['scope'] ? 'all' : 'mine' );
		if ( isset( $ctx['error'] ) ) {
			return self::notice( $ctx['error'], 'warn' );
		}
		return self::wrap( self::stats_cards( $ctx['email'] ), 'emz-stats' );
	}

	/* ───────────── [emzagar_request_contract] ───────────── */

	public static function request_form( $atts = array() ) {
		return self::render_request_form( $atts );
	}

	public static function render_request_form( $atts = array() ) {
		$a = shortcode_atts(
			array(
				'template_id' => 0,
				'button'      => '',
				'title'       => '',
			),
			(array) $atts,
			'emzagar_request_contract'
		);
		self::enqueue();
		$o   = emzagar_options();
		$tpl = (int) $a['template_id'] ? (int) $a['template_id'] : (int) $o['default_template'];
		if ( ! Emzagar_API::is_configured() || ! $tpl ) {
			return current_user_can( 'manage_options' )
				? self::notice( esc_html__( 'برای نمایش فرم، شناسه‌ی قالب (template_id) را در شورت‌کد بنویسید یا در «امضاگیر ← تنظیمات» قالب پیش‌فرض را انتخاب کنید.', 'emzagar' ), 'warn' )
				: '';
		}
		if ( ! is_user_logged_in() ) {
			return self::notice( sprintf( '%s <a href="%s">%s</a>', esc_html__( 'برای درخواست قرارداد وارد حساب کاربری شوید.', 'emzagar' ), esc_url( wp_login_url( self::current_url() ) ), esc_html__( 'ورود', 'emzagar' ) ), 'info' );
		}

		$user   = wp_get_current_user();
		$mobile = Emzagar_API::normalize_mobile( get_user_meta( $user->ID, 'billing_phone', true ) );
		if ( ! $mobile ) {
			$mobile = Emzagar_API::normalize_mobile( get_user_meta( $user->ID, 'emzagar_mobile', true ) );
		}
		$msg = '';
		// phpcs:disable WordPress.Security.NonceVerification.Recommended
		if ( isset( $_GET['emz_msg'] ) ) {
			$code = sanitize_key( wp_unslash( $_GET['emz_msg'] ) );
			if ( 'ok' === $code ) {
				$msg = '<p class="emz-notice emz-success" role="status">' . esc_html__( 'قرارداد صادر شد. لینک امضا به ایمیل و پیامک شما ارسال می‌شود.', 'emzagar' ) . '</p>';
			} elseif ( 'rate' === $code ) {
				$msg = '<p class="emz-notice emz-error" role="alert">' . esc_html__( 'درخواست‌های زیاد؛ بعداً دوباره تلاش کنید.', 'emzagar' ) . '</p>';
			} elseif ( 'mobile' === $code ) {
				$msg = '<p class="emz-notice emz-error" role="alert">' . esc_html__( 'شماره‌ی موبایل معتبر نیست (مثال: 09123456789).', 'emzagar' ) . '</p>';
			} else {
				$err = get_transient( 'emz_err_' . $user->ID );
				$msg = '<p class="emz-notice emz-error" role="alert">' . esc_html( $err ? $err : __( 'صدور قرارداد ناموفق بود.', 'emzagar' ) ) . '</p>';
			}
		}
		// phpcs:enable

		$btn = $a['button'] ? $a['button'] : __( 'درخواست قرارداد', 'emzagar' );
		$h   = '';
		if ( $a['title'] ) {
			$h .= '<h3 class="emz-title">' . esc_html( $a['title'] ) . '</h3>';
		}
		$h .= $msg;
		$h .= '<form class="emz-form" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		$h .= '<input type="hidden" name="action" value="emzagar_request" />';
		$h .= '<input type="hidden" name="template_id" value="' . esc_attr( $tpl ) . '" />';
		$h .= '<input type="hidden" name="redirect" value="' . esc_url( self::current_url() ) . '" />';
		$h .= wp_nonce_field( 'emzagar_request', '_emznonce', true, false );
		$h .= '<p class="emz-field"><label for="emz-name">' . esc_html__( 'نام و نام خانوادگی', 'emzagar' ) . '</label><input id="emz-name" name="name" type="text" required maxlength="100" value="' . esc_attr( $user->display_name ) . '" /></p>';
		$h .= '<p class="emz-field"><label for="emz-mobile">' . esc_html__( 'موبایل (برای کد تایید پیامکی)', 'emzagar' ) . '</label><input id="emz-mobile" name="mobile" type="tel" inputmode="numeric" dir="ltr" required placeholder="09123456789" value="' . esc_attr( $mobile ) . '" /></p>';
		$h .= '<p class="emz-field"><label>' . esc_html__( 'ایمیل', 'emzagar' ) . '</label><input type="email" value="' . esc_attr( $user->user_email ) . '" disabled dir="ltr" /></p>';
		$h .= '<button type="submit" class="emz-btn emz-btn-primary">' . esc_html( $btn ) . '</button>';
		$h .= '</form>';
		return self::wrap( $h, 'emz-request' );
	}

	/** پردازش فرم: nonce، ورود کاربر، محدودیت نرخ؛ ایمیل همیشه از حساب کاربر گرفته می‌شود (نه از فرم) */
	public static function handle_request() {
		$back = isset( $_POST['redirect'] ) ? esc_url_raw( wp_unslash( $_POST['redirect'] ) ) : home_url( '/' ); // phpcs:ignore WordPress.Security.NonceVerification
		$back = wp_validate_redirect( $back, home_url( '/' ) );
		if ( ! is_user_logged_in() ) {
			wp_safe_redirect( wp_login_url( $back ) );
			exit;
		}
		if ( ! isset( $_POST['_emznonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['_emznonce'] ) ), 'emzagar_request' ) ) {
			wp_die( esc_html__( 'درخواست نامعتبر است.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		$user = wp_get_current_user();
		// سقف ساعتی هر کاربر + سقف روزانه + قفل اضطراری (Emzagar_Limits)
		$gate = Emzagar_Limits::check_user( $user->ID, $user->user_email );
		if ( ! $gate['ok'] ) {
			wp_safe_redirect( add_query_arg( 'emz_msg', 'rate', $back ) );
			exit;
		}

		$name   = isset( $_POST['name'] ) ? sanitize_text_field( wp_unslash( $_POST['name'] ) ) : $user->display_name;
		$mobile = Emzagar_API::normalize_mobile( isset( $_POST['mobile'] ) ? sanitize_text_field( wp_unslash( $_POST['mobile'] ) ) : '' );
		$tpl    = isset( $_POST['template_id'] ) ? (int) $_POST['template_id'] : 0;
		if ( ! $mobile ) {
			Emzagar_Limits::release( $gate );
			wp_safe_redirect( add_query_arg( 'emz_msg', 'mobile', $back ) );
			exit;
		}
		update_user_meta( $user->ID, 'emzagar_mobile', $mobile );
		$o   = emzagar_options();
		$res = Emzagar_API::issue_contract( $tpl, $name, strtolower( $user->user_email ), $mobile, '', (int) $o['wc_expiry_days'] );
		if ( is_wp_error( $res ) ) {
			Emzagar_Limits::release( $gate );
			set_transient( 'emz_err_' . $user->ID, $res->get_error_message(), 5 * MINUTE_IN_SECONDS );
			wp_safe_redirect( add_query_arg( 'emz_msg', 'err', $back ) );
			exit;
		}
		wp_safe_redirect( add_query_arg( 'emz_msg', 'ok', $back ) );
		exit;
	}
}
