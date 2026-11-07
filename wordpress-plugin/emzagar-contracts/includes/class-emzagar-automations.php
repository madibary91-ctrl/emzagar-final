<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * موتور اتوماسیون «اگر ... آنگاه» برای قراردادها (بدون کدنویسی).
 *
 *  اگر [قرارداد امضا شد / رد شد / منقضی شد / لغو شد / صادر شد] (+ شرط قالب و حداقل ارزش)
 *  آنگاه [نقش بده، ایمیل بزن، وضعیت سفارش را عوض کن، یادداشت بگذار، وب‌هوک بزن، وظیفه بساز، قرارداد بعدی را بفرست]
 *
 *  • دستورهای آماده (Recipes) با یک کلیک
 *  • اجرای آزمایشی امن، گزارش اجرا و شمارنده‌ی ارزش‌آفرینی
 *  • اتصال فرم‌های سایت به صدور قرارداد (تب «فرم‌ها»)
 */
class Emzagar_Automations {

	const OPT_RULES = 'emzagar_auto_rules';
	const OPT_LOG   = 'emzagar_auto_log';
	const PAGE      = 'emzagar-automations';
	const MAX_RULES = 50;
	const MAX_LOG   = 100;

	public static function init() {
		// اجرای قوانین فقط وقتی ماژول «اتوماسیون» روشن است
		add_action( 'emzagar_contract_event', array( __CLASS__, 'on_event' ), 30, 2 );
		self::init_ui();
	}

	private static $ui_ready = false;

	/**
	 * صفحه‌ی مدیریت و کنش‌های admin-post. برای تب «فرم‌ها» هم لازم است؛
	 * پس ماژول «فرم‌ها» هم آن را صدا می‌زند (حتی وقتی ماژول اتوماسیون خاموش است).
	 */
	public static function init_ui() {
		if ( self::$ui_ready || ! is_admin() ) {
			return;
		}
		self::$ui_ready = true;
		add_action( 'admin_menu', array( __CLASS__, 'menu' ), 13 );
		add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
		foreach ( array( 'save', 'toggle', 'delete', 'recipe', 'test', 'clearlog' ) as $a ) {
			add_action( 'admin_post_emzagar_auto_' . $a, array( __CLASS__, 'act_' . $a ) );
		}
	}

	public static function url( $args = array() ) {
		return add_query_arg( array_merge( array( 'page' => self::PAGE ), $args ), admin_url( 'admin.php' ) );
	}

	/* ───────────── تعاریف ───────────── */

	public static function triggers() {
		return array(
			'signed'    => __( 'قرارداد کاملاً امضا شد', 'emzagar' ),
			'rejected'  => __( 'مشتری قرارداد را رد کرد', 'emzagar' ),
			'expired'   => __( 'مهلت امضا تمام شد (منقضی)', 'emzagar' ),
			'cancelled' => __( 'قرارداد لغو شد', 'emzagar' ),
			'issued'    => __( 'قرارداد صادر شد', 'emzagar' ),
		);
	}

	public static function actions() {
		return array(
			'task'           => __( 'ساختن وظیفه در صندوق فعالیت', 'emzagar' ),
			'email_admin'    => __( 'ایمیل به مدیر/تیم', 'emzagar' ),
			'email_customer' => __( 'ایمیل به مشتری', 'emzagar' ),
			'grant_role'     => __( 'دادن نقش کاربری به مشتری', 'emzagar' ),
			'order_status'   => __( 'تغییر وضعیت سفارش ووکامرس', 'emzagar' ),
			'order_note'     => __( 'ثبت یادداشت روی سفارش ووکامرس', 'emzagar' ),
			'issue_contract' => __( 'ارسال قرارداد بعدی (زنجیره‌ی قرارداد)', 'emzagar' ),
			'webhook'        => __( 'فراخوانی وب‌هوک (Zapier، Make، n8n …)', 'emzagar' ),
		);
	}

	/** راهنمای فیلدهای هر کنش (برای رابط) */
	public static function hints() {
		return array(
			'task'           => array(
				'p'  => __( 'عنوان وظیفه', 'emzagar' ),
				'p2' => __( 'توضیح (اختیاری)', 'emzagar' ),
			),
			'email_admin'    => array(
				'p'  => __( 'ایمیل گیرنده (خالی = ایمیل مدیر سایت)', 'emzagar' ),
				'p2' => __( 'متن ایمیل', 'emzagar' ),
			),
			'email_customer' => array(
				'p'  => __( 'موضوع ایمیل', 'emzagar' ),
				'p2' => __( 'متن ایمیل', 'emzagar' ),
			),
			'grant_role'     => array(
				'p'  => __( 'شناسه‌ی نقش (مثلاً customer یا emz_signed_client)', 'emzagar' ),
				'p2' => '',
			),
			'order_status'   => array(
				'p'  => __( 'وضعیت جدید (processing، completed، on-hold، cancelled)', 'emzagar' ),
				'p2' => '',
			),
			'order_note'     => array(
				'p'  => __( 'متن یادداشت', 'emzagar' ),
				'p2' => '',
			),
			'issue_contract' => array(
				'p'  => __( 'شناسه‌ی قالب قرارداد بعدی', 'emzagar' ),
				'p2' => '',
			),
			'webhook'        => array(
				'p'  => __( 'آدرس وب‌هوک (https://…)', 'emzagar' ),
				'p2' => '',
			),
		);
	}

	public static function recipes() {
		return array(
			'role_after_sign'   => array(
				'name' => __( 'پس از امضا، نقش «مشتری امضاکننده» بده', 'emzagar' ),
				'desc' => __( 'مشتری با حساب وردپرسی بلافاصله پس از امضا به بخش‌های ویژه دسترسی پیدا می‌کند.', 'emzagar' ),
				'rule' => array( 'trigger' => 'signed', 'action' => 'grant_role', 'p' => 'emz_signed_client', 'p2' => '' ),
			),
			'mail_admin_signed' => array(
				'name' => __( 'پس از امضا، به من ایمیل بزن', 'emzagar' ),
				'desc' => __( 'خبر امضا فوراً به ایمیل مدیر می‌رسد.', 'emzagar' ),
				'rule' => array( 'trigger' => 'signed', 'action' => 'email_admin', 'p' => '', 'p2' => "✅ قرارداد «{title}» ({number}) توسط {customer} امضا شد.\nارزش: {value} تومان\nمشاهده: {link}" ),
			),
			'welcome_customer'  => array(
				'name' => __( 'پس از امضا، ایمیل خوش‌آمد به مشتری', 'emzagar' ),
				'desc' => __( 'تجربه‌ی حرفه‌ای: تشکر و گام بعدی را خودکار برای مشتری بفرستید.', 'emzagar' ),
				'rule' => array( 'trigger' => 'signed', 'action' => 'email_customer', 'p' => 'از امضای قرارداد شما سپاسگزاریم', 'p2' => "{customer} عزیز،\nقرارداد «{title}» با موفقیت امضا شد. نسخه‌ی رسمی در پروفایل شما موجود است.\nبا سپاس — {site}" ),
			),
			'task_on_reject'    => array(
				'name' => __( 'پس از رد قرارداد، وظیفه‌ی پیگیری بساز', 'emzagar' ),
				'desc' => __( 'هیچ رد شدنی بدون پیگیری نمی‌ماند؛ وظیفه در صندوق فعالیت و زنگ نوار مدیریت می‌آید.', 'emzagar' ),
				'rule' => array( 'trigger' => 'rejected', 'action' => 'task', 'p' => 'پیگیری رد قرارداد {number} — {customer}', 'p2' => 'با مشتری تماس بگیرید و دلیل رد را بپرسید.' ),
			),
			'task_on_expire'    => array(
				'name' => __( 'پس از انقضا، وظیفه‌ی صدور مجدد بساز', 'emzagar' ),
				'desc' => __( 'قراردادهای بی‌پاسخ منقضی‌شده را دوباره صادر کنید.', 'emzagar' ),
				'rule' => array( 'trigger' => 'expired', 'action' => 'task', 'p' => 'صدور مجدد قرارداد {number} — {customer}', 'p2' => '' ),
			),
			'order_complete'    => array(
				'name' => __( 'پس از امضا، سفارش ووکامرس را تکمیل کن', 'emzagar' ),
				'desc' => __( 'سفارش‌های دارای قرارداد پس از امضا خودکار «تکمیل‌شده» می‌شوند.', 'emzagar' ),
				'rule' => array( 'trigger' => 'signed', 'action' => 'order_status', 'p' => 'completed', 'p2' => '' ),
				'wc'   => true,
			),
			'order_note_signed' => array(
				'name' => __( 'پس از امضا، روی سفارش یادداشت بگذار', 'emzagar' ),
				'desc' => __( 'تاریخچه‌ی سفارش کامل می‌ماند: «قرارداد … امضا شد».', 'emzagar' ),
				'rule' => array( 'trigger' => 'signed', 'action' => 'order_note', 'p' => 'قرارداد {number} توسط {customer} امضا شد.', 'p2' => '' ),
				'wc'   => true,
			),
			'order_hold_reject' => array(
				'name' => __( 'پس از رد/انقضا، سفارش را در انتظار بررسی نگه دار', 'emzagar' ),
				'desc' => __( 'تا تکلیف قرارداد روشن نشده، سفارش ارسال نمی‌شود.', 'emzagar' ),
				'rule' => array( 'trigger' => 'rejected', 'action' => 'order_status', 'p' => 'on-hold', 'p2' => '' ),
				'wc'   => true,
			),
		);
	}

	/* ───────────── ذخیره‌سازی ───────────── */

	public static function rules() {
		$r = get_option( self::OPT_RULES, array() );
		return is_array( $r ) ? $r : array();
	}

	private static function save_rules( $rules ) {
		update_option( self::OPT_RULES, array_values( array_slice( $rules, 0, self::MAX_RULES ) ), false );
		// میزان ادغام جدید به ابر گزارش می‌شود (عمق یکپارچگی)
		Emzagar_Hub::invalidate();
		wp_schedule_single_event( time() + 3, Emzagar_Hub::HOOK_REFRESH );
	}

	public static function active_count() {
		$n = 0;
		foreach ( self::rules() as $r ) {
			if ( ! empty( $r['on'] ) ) {
				++$n;
			}
		}
		return $n;
	}

	public static function log_items() {
		$l = get_option( self::OPT_LOG, array() );
		return is_array( $l ) ? $l : array();
	}

	private static function log( $rule, $kind, $ref, $ok, $msg ) {
		$l = self::log_items();
		array_unshift(
			$l,
			array(
				'ts'   => time(),
				'rule' => (string) $rule,
				'kind' => (string) $kind,
				'ref'  => (string) $ref,
				'ok'   => (bool) $ok,
				'msg'  => mb_substr( wp_strip_all_tags( (string) $msg ), 0, 200 ),
			)
		);
		update_option( self::OPT_LOG, array_slice( $l, 0, self::MAX_LOG ), false );
	}

	/** تعداد اجرای موفق در ۳۰ روز اخیر (آزمایشی‌ها شمرده نمی‌شوند) */
	public static function runs30() {
		$n   = 0;
		$min = time() - 30 * DAY_IN_SECONDS;
		foreach ( self::log_items() as $e ) {
			if ( ! empty( $e['ok'] ) && (int) $e['ts'] >= $min && 'test' !== $e['kind'] ) {
				++$n;
			}
		}
		return $n;
	}

	/** برای گزارش به ابر یا سایر کلاس‌ها: ثبت یک اجرا (مثلاً از فرم‌ها) */
	public static function record( $name, $kind, $ref, $ok, $msg ) {
		self::log( $name, $kind, $ref, $ok, $msg );
	}

	/* ───────────── اجرا ───────────── */

	private static function kind_of( $type, $d ) {
		$status = isset( $d['status'] ) ? (string) $d['status'] : '';
		$pend   = isset( $d['pendingSigners'] ) ? (int) $d['pendingSigners'] : 0;
		if ( 'contract.completed' === $type || ( 'contract.signed' === $type && ( 'signed' === $status || 0 === $pend ) ) ) {
			return 'signed';
		}
		$map = array(
			'contract.rejected'  => 'rejected',
			'contract.expired'   => 'expired',
			'contract.cancelled' => 'cancelled',
			'contract.issued'    => 'issued',
		);
		return isset( $map[ $type ] ) ? $map[ $type ] : '';
	}

	public static function on_event( $type, $data ) {
		$d    = is_array( $data ) ? $data : array();
		$kind = self::kind_of( (string) $type, $d );
		if ( '' === $kind ) {
			return;
		}
		$cid = isset( $d['contractId'] ) ? (int) $d['contractId'] : 0;
		if ( $cid ) {
			$key = 'emz_auto_' . $cid . '_' . $kind;
			if ( get_transient( $key ) ) {
				return; // رویداد تکراری (signed و completed برای یک قرارداد)
			}
			set_transient( $key, 1, DAY_IN_SECONDS );
		}
		foreach ( self::rules() as $rule ) {
			if ( empty( $rule['on'] ) || $rule['trigger'] !== $kind || ! self::matches( $rule, $d ) ) {
				continue;
			}
			try {
				$res = self::run_action( $rule, $d, false );
			} catch ( \Throwable $e ) { // phpcs:ignore PHPCompatibility.Keywords.NewKeywords.t_throwableFound
				$res = array( 'ok' => false, 'msg' => $e->getMessage() );
			}
			self::log( $rule['name'], $kind, isset( $d['number'] ) ? $d['number'] : '', $res['ok'], $res['msg'] );
		}
	}

	private static function matches( $rule, $d ) {
		if ( ! empty( $rule['tpl'] ) && (int) $rule['tpl'] !== ( isset( $d['templateId'] ) ? (int) $d['templateId'] : 0 ) ) {
			return false;
		}
		if ( ! empty( $rule['min'] ) && ( isset( $d['value'] ) ? (int) $d['value'] : 0 ) < (int) $rule['min'] ) {
			return false;
		}
		return true;
	}

	/** جایگزینی متغیرها در متن */
	private static function expand( $text, $d ) {
		$cust = isset( $d['customer']['name'] ) && '' !== $d['customer']['name'] ? $d['customer']['name'] : ( isset( $d['customer']['email'] ) ? $d['customer']['email'] : '' );
		$map  = array(
			'{customer}' => (string) $cust,
			'{email}'    => isset( $d['customer']['email'] ) ? (string) $d['customer']['email'] : '',
			'{number}'   => isset( $d['number'] ) ? (string) $d['number'] : '',
			'{title}'    => isset( $d['title'] ) ? (string) $d['title'] : '',
			'{value}'    => number_format_i18n( isset( $d['value'] ) ? (int) $d['value'] : 0 ),
			'{order}'    => isset( $d['wcOrderId'] ) && $d['wcOrderId'] ? (string) $d['wcOrderId'] : '',
			'{site}'     => get_bloginfo( 'name' ),
			'{link}'     => ! empty( $d['contractId'] ) ? Emzagar_Workspace::url( array( 'contract' => (int) $d['contractId'] ) ) : '',
		);
		return strtr( (string) $text, $map );
	}

	/** @return array{ok:bool,msg:string} */
	private static function run_action( $rule, $d, $dry ) {
		$p     = isset( $rule['p'] ) ? (string) $rule['p'] : '';
		$p2    = isset( $rule['p2'] ) ? (string) $rule['p2'] : '';
		$email = isset( $d['customer']['email'] ) ? sanitize_email( (string) $d['customer']['email'] ) : '';
		$oid   = isset( $d['wcOrderId'] ) ? (int) $d['wcOrderId'] : 0;
		$fail  = function ( $m ) {
			return array( 'ok' => false, 'msg' => $m );
		};
		$done  = function ( $m ) {
			return array( 'ok' => true, 'msg' => $m );
		};
		switch ( $rule['action'] ) {
			case 'task':
				if ( $dry ) {
					return $done( __( 'آزمایشی: وظیفه‌ی نمونه ساخته شد.', 'emzagar' ) );
				}
				Emzagar_Inbox::add( 'task', self::expand( $p, $d ), self::expand( $p2, $d ), isset( $d['contractId'] ) ? (int) $d['contractId'] : 0 );
				return $done( __( 'وظیفه ساخته شد.', 'emzagar' ) );

			case 'email_admin':
				$to   = is_email( $p ) ? $p : get_option( 'admin_email' );
				$body = '' !== trim( $p2 ) ? $p2 : "قرارداد «{title}» ({number}) — {customer}\n{link}";
				$ok   = wp_mail( $to, '[' . get_bloginfo( 'name' ) . '] ' . ( $dry ? 'آزمایشی — ' : '' ) . self::expand( '{title} ({number})', $d ), self::expand( $body, $d ) );
				return $ok ? $done( __( 'ایمیل ارسال شد.', 'emzagar' ) ) : $fail( __( 'ارسال ایمیل ناموفق بود.', 'emzagar' ) );

			case 'email_customer':
				if ( ! is_email( $email ) ) {
					return $fail( __( 'ایمیل مشتری نامعتبر است.', 'emzagar' ) );
				}
				$to   = $dry ? get_option( 'admin_email' ) : $email;
				$subj = '' !== trim( $p ) ? $p : 'قرارداد {number}';
				$ok   = wp_mail( $to, self::expand( $subj, $d ), self::expand( $p2, $d ) );
				return $ok ? $done( $dry ? __( 'آزمایشی: ایمیل به مدیر ارسال شد.', 'emzagar' ) : __( 'ایمیل به مشتری ارسال شد.', 'emzagar' ) ) : $fail( __( 'ارسال ایمیل ناموفق بود.', 'emzagar' ) );

			case 'grant_role':
				$role = sanitize_key( $p );
				if ( '' === $role || 'administrator' === $role || ! get_role( $role ) ) {
					return $fail( __( 'نقش نامعتبر است.', 'emzagar' ) );
				}
				if ( $dry ) {
					return $done( __( 'آزمایشی: نقش به کاربر واقعی داده نمی‌شود.', 'emzagar' ) );
				}
				$u = $email ? get_user_by( 'email', $email ) : false;
				if ( ! $u ) {
					return $done( __( 'کاربر وردپرسی با این ایمیل نیست؛ نادیده گرفته شد.', 'emzagar' ) );
				}
				if ( user_can( $u, 'manage_options' ) ) {
					return $done( __( 'مدیران تغییر نمی‌کنند.', 'emzagar' ) );
				}
				$u->add_role( $role );
				return $done( __( 'نقش داده شد.', 'emzagar' ) );

			case 'order_status':
			case 'order_note':
				if ( $dry ) {
					return $done( __( 'آزمایشی: روی سفارش واقعی اعمال نمی‌شود.', 'emzagar' ) );
				}
				if ( ! function_exists( 'wc_get_order' ) || ! $oid ) {
					return $done( __( 'این قرارداد به سفارش ووکامرس وصل نیست؛ نادیده گرفته شد.', 'emzagar' ) );
				}
				$order = wc_get_order( $oid );
				if ( ! $order ) {
					return $fail( __( 'سفارش پیدا نشد.', 'emzagar' ) );
				}
				if ( 'order_note' === $rule['action'] ) {
					$order->add_order_note( self::expand( $p, $d ) );
					return $done( __( 'یادداشت ثبت شد.', 'emzagar' ) );
				}
				$slug     = sanitize_key( str_replace( 'wc-', '', $p ) );
				$statuses = function_exists( 'wc_get_order_statuses' ) ? array_keys( wc_get_order_statuses() ) : array();
				if ( ! in_array( 'wc-' . $slug, $statuses, true ) ) {
					return $fail( __( 'وضعیت سفارش نامعتبر است.', 'emzagar' ) );
				}
				if ( $order->get_status() !== $slug ) {
					$order->update_status( $slug, __( 'امضاگیر (اتوماسیون): ', 'emzagar' ) );
				}
				return $done( __( 'وضعیت سفارش تغییر کرد.', 'emzagar' ) );

			case 'issue_contract':
				$tpl = (int) $p;
				if ( $tpl <= 0 || ! is_email( $email ) ) {
					return $fail( __( 'قالب یا ایمیل مشتری نامعتبر است.', 'emzagar' ) );
				}
				if ( isset( $d['templateId'] ) && (int) $d['templateId'] === $tpl ) {
					return $fail( __( 'برای جلوگیری از چرخه، قالب بعدی باید با قالب فعلی فرق کند.', 'emzagar' ) );
				}
				if ( $dry ) {
					return $done( __( 'آزمایشی: قرارداد واقعی صادر نمی‌شود.', 'emzagar' ) );
				}
				$u      = get_user_by( 'email', $email );
				$mobile = $u ? Emzagar_Workspace::person( $u )['mobile'] : '';
				$name   = isset( $d['customer']['name'] ) ? (string) $d['customer']['name'] : '';
				$res    = Emzagar_API::issue_contract( $tpl, $name, $email, $mobile, '', null );
				if ( is_wp_error( $res ) ) {
					return $fail( $res->get_error_message() );
				}
				Emzagar_Hub::invalidate();
				return $done( __( 'قرارداد بعدی صادر و ارسال شد.', 'emzagar' ) );

			case 'webhook':
				$url = esc_url_raw( $p, array( 'https', 'http' ) );
				if ( '' === $url ) {
					return $fail( __( 'آدرس وب‌هوک نامعتبر است.', 'emzagar' ) );
				}
				$payload = array(
					'source'   => 'emzagar-wp',
					'event'    => $rule['trigger'],
					'test'     => (bool) $dry,
					'site'     => home_url(),
					'contract' => $d,
				);
				$res     = wp_safe_remote_post(
					$url,
					array(
						'timeout'     => 8,
						'redirection' => 0,
						'headers'     => array( 'Content-Type' => 'application/json' ),
						'body'        => wp_json_encode( $payload ),
					)
				);
				if ( is_wp_error( $res ) ) {
					return $fail( $res->get_error_message() );
				}
				$code = (int) wp_remote_retrieve_response_code( $res );
				return ( $code >= 200 && $code < 300 ) ? $done( 'HTTP ' . $code ) : $fail( 'HTTP ' . $code );
		}
		return $fail( __( 'کنش ناشناخته.', 'emzagar' ) );
	}

	/* ───────────── مدیریت (admin-post) ───────────── */

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	private static function back( $code, $tab = 'rules' ) {
		wp_safe_redirect( add_query_arg( 'emz_a', $code, self::url( array( 'tab' => $tab ) ) ) );
		exit;
	}

	private static function clean_rule( $in, $existing_id = '' ) {
		$trig = isset( $in['trigger'] ) ? sanitize_key( $in['trigger'] ) : 'signed';
		$trig = isset( self::triggers()[ $trig ] ) ? $trig : 'signed';
		// فرم از «act» استفاده می‌کند (کلید «action» در admin-post برای نام کنش رزرو است)؛ دستورهای آماده «action» دارند
		$act = isset( $in['act'] ) ? sanitize_key( $in['act'] ) : ( isset( $in['action'] ) ? sanitize_key( $in['action'] ) : 'task' );
		$act = isset( self::actions()[ $act ] ) ? $act : 'task';
		$p    = isset( $in['p'] ) ? sanitize_text_field( wp_unslash( $in['p'] ) ) : '';
		$p2   = isset( $in['p2'] ) ? sanitize_textarea_field( wp_unslash( $in['p2'] ) ) : '';
		if ( 'grant_role' === $act ) {
			$p = sanitize_key( $p );
		} elseif ( 'order_status' === $act ) {
			$p = sanitize_key( str_replace( 'wc-', '', $p ) );
		} elseif ( 'webhook' === $act ) {
			$p = esc_url_raw( $p, array( 'https', 'http' ) );
		} elseif ( 'issue_contract' === $act ) {
			$p = (string) absint( $p );
		} elseif ( 'email_admin' === $act ) {
			$p = is_email( $p ) ? sanitize_email( $p ) : '';
		}
		$name = isset( $in['name'] ) ? sanitize_text_field( wp_unslash( $in['name'] ) ) : '';
		if ( '' === $name ) {
			$name = self::triggers()[ $trig ] . ' ← ' . self::actions()[ $act ];
		}
		return array(
			'id'      => '' !== $existing_id ? $existing_id : wp_generate_password( 10, false ),
			'name'    => mb_substr( $name, 0, 120 ),
			'on'      => true,
			'trigger' => $trig,
			'tpl'     => isset( $in['tpl'] ) ? absint( $in['tpl'] ) : 0,
			'min'     => isset( $in['min'] ) ? absint( $in['min'] ) : 0,
			'action'  => $act,
			'p'       => mb_substr( $p, 0, 300 ),
			'p2'      => mb_substr( $p2, 0, 1000 ),
		);
	}

	/**
	 * ورود قوانین از فایل پشتیبان (با پاک‌سازی کامل هر فیلد).
	 *
	 * @param array $items فهرست قوانین
	 * @return int تعداد قوانین واردشده
	 */
	public static function import_rules( $items ) {
		$out = array();
		foreach ( (array) $items as $it ) {
			if ( ! is_array( $it ) || count( $out ) >= self::MAX_RULES ) {
				continue;
			}
			$id         = isset( $it['id'] ) ? preg_replace( '/[^A-Za-z0-9]/', '', (string) $it['id'] ) : '';
			$rule       = self::clean_rule( wp_slash( $it ), substr( (string) $id, 0, 20 ) );
			$rule['on'] = ! empty( $it['on'] ) && 'no' !== $it['on'];
			if ( ! empty( $it['recipe'] ) ) {
				$rule['recipe'] = sanitize_key( $it['recipe'] );
			}
			$out[] = $rule;
		}
		self::save_rules( $out );
		return count( $out );
	}

	/** افزودن یک دستور آماده (برای ویزارد و CLI). @return string added|exists|bad */
	public static function add_recipe( $key ) {
		$all = self::recipes();
		if ( ! isset( $all[ $key ] ) ) {
			return 'bad';
		}
		$rules = self::rules();
		foreach ( $rules as $r ) {
			if ( isset( $r['recipe'] ) && $r['recipe'] === $key ) {
				return 'exists';
			}
		}
		$rr            = $all[ $key ]['rule'];
		$rr['name']    = $all[ $key ]['name'];
		$new           = self::clean_rule( wp_slash( $rr ) );
		$new['recipe'] = $key;
		if ( 'grant_role' === $new['action'] ) {
			Emzagar_Access::ensure_role();
		}
		$rules[] = $new;
		self::save_rules( $rules );
		return 'added';
	}

	public static function act_save() {
		self::guard( 'emzagar_auto_save' );
		$rules = self::rules();
		if ( count( $rules ) >= self::MAX_RULES ) {
			self::back( 'limit' );
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- در guard بررسی شده
		$rules[] = self::clean_rule( is_array( $_POST ) ? $_POST : array() );
		self::save_rules( $rules );
		self::back( 'saved' );
	}

	public static function act_toggle() {
		self::guard( 'emzagar_auto_toggle' );
		$id    = isset( $_GET['id'] ) ? sanitize_text_field( wp_unslash( $_GET['id'] ) ) : '';
		$rules = self::rules();
		foreach ( $rules as $i => $r ) {
			if ( $r['id'] === $id ) {
				$rules[ $i ]['on'] = empty( $r['on'] );
			}
		}
		self::save_rules( $rules );
		self::back( 'toggled' );
	}

	public static function act_delete() {
		self::guard( 'emzagar_auto_delete' );
		$id    = isset( $_GET['id'] ) ? sanitize_text_field( wp_unslash( $_GET['id'] ) ) : '';
		$rules = array_filter(
			self::rules(),
			function ( $r ) use ( $id ) {
				return $r['id'] !== $id;
			}
		);
		self::save_rules( $rules );
		self::back( 'deleted' );
	}

	public static function act_recipe() {
		self::guard( 'emzagar_auto_recipe' );
		$key = isset( $_GET['key'] ) ? sanitize_key( wp_unslash( $_GET['key'] ) ) : '';
		$all = self::recipes();
		if ( ! isset( $all[ $key ] ) ) {
			self::back( 'bad' );
		}
		$rules = self::rules();
		foreach ( $rules as $r ) {
			if ( isset( $r['recipe'] ) && $r['recipe'] === $key ) {
				self::back( 'exists' );
			}
		}
		$rr           = $all[ $key ]['rule'];
		$rr['name']   = $all[ $key ]['name'];
		$new          = self::clean_rule( wp_slash( $rr ) );
		$new['recipe'] = $key;
		if ( 'grant_role' === $new['action'] ) {
			Emzagar_Access::ensure_role();
		}
		$rules[] = $new;
		self::save_rules( $rules );
		self::back( 'recipe_added' );
	}

	public static function act_test() {
		self::guard( 'emzagar_auto_test' );
		$id = isset( $_GET['id'] ) ? sanitize_text_field( wp_unslash( $_GET['id'] ) ) : '';
		foreach ( self::rules() as $r ) {
			if ( $r['id'] !== $id ) {
				continue;
			}
			$sample = array(
				'contractId' => 0,
				'number'     => 'TEST-0001',
				'title'      => 'قرارداد آزمایشی',
				'templateId' => (int) $r['tpl'],
				'value'      => 1000000,
				'status'     => 'signed',
				'wcOrderId'  => 0,
				'customer'   => array(
					'name'  => 'مشتری آزمایشی',
					'email' => get_option( 'admin_email' ),
				),
			);
			$res    = self::run_action( $r, $sample, true );
			self::log( $r['name'], 'test', 'TEST-0001', $res['ok'], $res['msg'] );
			self::back( $res['ok'] ? 'test_ok' : 'test_fail', 'log' );
		}
		self::back( 'bad' );
	}

	public static function act_clearlog() {
		self::guard( 'emzagar_auto_clearlog' );
		update_option( self::OPT_LOG, array(), false );
		self::back( 'cleared', 'log' );
	}

	/* ───────────── صفحه ───────────── */

	public static function menu() {
		add_submenu_page( 'emzagar', __( 'اتوماسیون‌ها', 'emzagar' ), __( 'اتوماسیون‌ها', 'emzagar' ), 'manage_options', self::PAGE, array( __CLASS__, 'render' ), 2 );
	}

	public static function assets() {
		$page = isset( $_GET['page'] ) ? sanitize_key( wp_unslash( $_GET['page'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( self::PAGE !== $page ) {
			return;
		}
		wp_enqueue_style( 'emzagar-hub', EMZ_URL . 'assets/css/hub.css', array(), EMZ_VERSION );
		wp_enqueue_style( 'emzagar-workspace', EMZ_URL . 'assets/css/workspace.css', array(), EMZ_VERSION );
		wp_enqueue_script( 'emzagar-auto', EMZ_URL . 'assets/js/automations.js', array(), EMZ_VERSION, true );
		wp_localize_script( 'emzagar-auto', 'EmzagarAuto', array( 'hints' => self::hints() ) );
	}

	private static function notice( $code ) {
		$m = array(
			'saved'        => array( 'success', __( 'قانون ذخیره و فعال شد.', 'emzagar' ) ),
			'toggled'      => array( 'success', __( 'وضعیت قانون تغییر کرد.', 'emzagar' ) ),
			'deleted'      => array( 'success', __( 'قانون حذف شد.', 'emzagar' ) ),
			'recipe_added' => array( 'success', __( 'دستور آماده اضافه و فعال شد.', 'emzagar' ) ),
			'exists'       => array( 'info', __( 'این دستور قبلاً اضافه شده است.', 'emzagar' ) ),
			'limit'        => array( 'error', __( 'سقف تعداد قوانین پر شده است.', 'emzagar' ) ),
			'test_ok'      => array( 'success', __( 'اجرای آزمایشی موفق بود؛ نتیجه در «گزارش اجرا» است.', 'emzagar' ) ),
			'test_fail'    => array( 'error', __( 'اجرای آزمایشی خطا داد؛ جزئیات در «گزارش اجرا» است.', 'emzagar' ) ),
			'cleared'      => array( 'success', __( 'گزارش پاک شد.', 'emzagar' ) ),
			'form_saved'   => array( 'success', __( 'اتصال فرم ذخیره شد.', 'emzagar' ) ),
			'form_deleted' => array( 'success', __( 'اتصال فرم حذف شد.', 'emzagar' ) ),
			'bad'          => array( 'error', __( 'درخواست نامعتبر بود.', 'emzagar' ) ),
		);
		return isset( $m[ $code ] ) ? $m[ $code ] : null;
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$tab  = isset( $_GET['tab'] ) ? sanitize_key( wp_unslash( $_GET['tab'] ) ) : 'rules'; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$tabs = array();
		if ( Emzagar_Modules::on( 'automations' ) ) {
			$tabs['rules'] = __( 'قوانین', 'emzagar' );
		}
		if ( Emzagar_Modules::on( 'forms' ) ) {
			$tabs['forms'] = __( 'فرم‌ها ← قرارداد', 'emzagar' );
		}
		$tabs['log'] = __( 'گزارش اجرا', 'emzagar' );
		if ( ! isset( $tabs[ $tab ] ) ) {
			$keys = array_keys( $tabs );
			$tab  = $keys[0];
		}
		$code   = isset( $_GET['emz_a'] ) ? sanitize_text_field( wp_unslash( $_GET['emz_a'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$notice = $code ? self::notice( $code ) : null;
		?>
		<div class="wrap emz-hub emz-auto" dir="<?php echo is_rtl() ? 'rtl' : 'ltr'; ?>">
			<h1><?php esc_html_e( 'امضاگیر — اتوماسیون‌ها', 'emzagar' ); ?></h1>
			<p class="description"><?php esc_html_e( 'کسب‌وکارتان را یک بار تنظیم کنید؛ از آن پس هر امضا، رد یا انقضا خودکار کار درست را انجام می‌دهد.', 'emzagar' ); ?></p>
			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice[0] ); ?> is-dismissible"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>
			<h2 class="nav-tab-wrapper">
				<?php foreach ( $tabs as $k => $label ) : ?>
					<a class="nav-tab <?php echo $k === $tab ? 'nav-tab-active' : ''; ?>" href="<?php echo esc_url( self::url( array( 'tab' => $k ) ) ); ?>"><?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
			</h2>
			<?php
			if ( 'forms' === $tab ) {
				Emzagar_Forms::render_tab();
			} elseif ( 'log' === $tab ) {
				self::render_log();
			} else {
				self::render_rules();
			}
			?>
		</div>
		<?php
	}

	private static function render_rules() {
		$rules   = self::rules();
		$recipes = self::recipes();
		$have    = array();
		foreach ( $rules as $r ) {
			if ( isset( $r['recipe'] ) ) {
				$have[ $r['recipe'] ] = true;
			}
		}
		$tpls = Emzagar_API::is_configured() ? Emzagar_API::request( 'GET', '/api/v1/templates', array(), null, true ) : array( 'items' => array() );
		$tpls = is_wp_error( $tpls ) ? array( 'items' => array() ) : $tpls;
		$wc   = class_exists( 'WooCommerce' );
		?>
		<section class="emz-h-box">
			<h2><?php esc_html_e( 'دستورهای آماده — با یک کلیک روشن کنید', 'emzagar' ); ?></h2>
			<div class="emz-recipes">
				<?php
				foreach ( $recipes as $key => $rc ) :
					if ( ! empty( $rc['wc'] ) && ! $wc ) {
						continue;
					}
					?>
					<div class="emz-recipe">
						<b><?php echo esc_html( $rc['name'] ); ?></b>
						<p><?php echo esc_html( $rc['desc'] ); ?></p>
						<?php if ( isset( $have[ $key ] ) ) : ?>
							<span class="emz-st emz-st-signed">✓ <?php esc_html_e( 'فعال', 'emzagar' ); ?></span>
						<?php else : ?>
							<a class="button button-primary" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_auto_recipe&key=' . $key ), 'emzagar_auto_recipe' ) ); ?>"><?php esc_html_e( 'روشن کن', 'emzagar' ); ?></a>
						<?php endif; ?>
					</div>
				<?php endforeach; ?>
			</div>
		</section>

		<section class="emz-h-box">
			<h2><?php esc_html_e( 'قوانین شما', 'emzagar' ); ?></h2>
			<?php if ( empty( $rules ) ) : ?>
				<p class="emz-h-empty"><?php esc_html_e( 'هنوز قانونی نساخته‌اید. از دستورهای آماده شروع کنید یا پایین قانون دلخواه بسازید.', 'emzagar' ); ?></p>
			<?php else : ?>
				<table class="widefat striped"><thead><tr>
					<th><?php esc_html_e( 'قانون', 'emzagar' ); ?></th><th><?php esc_html_e( 'اگر', 'emzagar' ); ?></th><th><?php esc_html_e( 'آنگاه', 'emzagar' ); ?></th><th><?php esc_html_e( 'وضعیت', 'emzagar' ); ?></th><th></th>
				</tr></thead><tbody>
				<?php foreach ( $rules as $r ) : ?>
					<tr>
						<td><b><?php echo esc_html( $r['name'] ); ?></b></td>
						<td>
							<?php
							echo esc_html( self::triggers()[ $r['trigger'] ] );
							if ( ! empty( $r['tpl'] ) ) {
								echo '<br><small>' . esc_html( sprintf( /* translators: %d: template id */ __( 'فقط قالب #%d', 'emzagar' ), (int) $r['tpl'] ) ) . '</small>';
							}
							if ( ! empty( $r['min'] ) ) {
								echo '<br><small>' . esc_html( sprintf( /* translators: %s: amount */ __( 'ارزش از %s تومان', 'emzagar' ), number_format_i18n( (int) $r['min'] ) ) ) . '</small>';
							}
							?>
						</td>
						<td><?php echo esc_html( self::actions()[ $r['action'] ] ); ?><?php echo '' !== $r['p'] ? '<br><small dir="auto">' . esc_html( mb_substr( $r['p'], 0, 60 ) ) . '</small>' : ''; ?></td>
						<td><a href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_auto_toggle&id=' . rawurlencode( $r['id'] ) ), 'emzagar_auto_toggle' ) ); ?>" class="emz-st <?php echo ! empty( $r['on'] ) ? 'emz-st-signed' : 'emz-st-cancelled'; ?>"><?php echo ! empty( $r['on'] ) ? esc_html__( 'روشن', 'emzagar' ) : esc_html__( 'خاموش', 'emzagar' ); ?></a></td>
						<td style="text-align:end">
							<a class="button button-small" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_auto_test&id=' . rawurlencode( $r['id'] ) ), 'emzagar_auto_test' ) ); ?>"><?php esc_html_e( 'اجرای آزمایشی', 'emzagar' ); ?></a>
							<a class="button button-small button-link-delete" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_auto_delete&id=' . rawurlencode( $r['id'] ) ), 'emzagar_auto_delete' ) ); ?>" onclick="return confirm('<?php echo esc_js( __( 'این قانون حذف شود؟', 'emzagar' ) ); ?>')"><?php esc_html_e( 'حذف', 'emzagar' ); ?></a>
						</td>
					</tr>
				<?php endforeach; ?>
				</tbody></table>
			<?php endif; ?>
		</section>

		<section class="emz-h-box">
			<h2><?php esc_html_e( 'ساخت قانون دلخواه', 'emzagar' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="emzagar_auto_save">
				<?php wp_nonce_field( 'emzagar_auto_save' ); ?>
				<table class="form-table" role="presentation"><tbody>
					<tr><th><label for="emz-r-name"><?php esc_html_e( 'نام (اختیاری)', 'emzagar' ); ?></label></th><td><input type="text" id="emz-r-name" name="name" class="regular-text"></td></tr>
					<tr><th><label for="emz-r-trig"><?php esc_html_e( 'اگر', 'emzagar' ); ?></label></th><td>
						<select id="emz-r-trig" name="trigger">
							<?php foreach ( self::triggers() as $k => $l ) : ?>
								<option value="<?php echo esc_attr( $k ); ?>"><?php echo esc_html( $l ); ?></option>
							<?php endforeach; ?>
						</select>
						&nbsp;<label><?php esc_html_e( 'قالب:', 'emzagar' ); ?>
						<select name="tpl">
							<option value="0"><?php esc_html_e( 'هر قالبی', 'emzagar' ); ?></option>
							<?php foreach ( (array) $tpls['items'] as $t ) : ?>
								<option value="<?php echo (int) $t['id']; ?>"><?php echo esc_html( $t['title'] ); ?></option>
							<?php endforeach; ?>
						</select></label>
						&nbsp;<label><?php esc_html_e( 'حداقل ارزش (تومان):', 'emzagar' ); ?> <input type="number" name="min" min="0" class="small-text" placeholder="0"></label>
					</td></tr>
					<tr><th><label for="emz-r-act"><?php esc_html_e( 'آنگاه', 'emzagar' ); ?></label></th><td>
						<select id="emz-r-act" name="act">
							<?php foreach ( self::actions() as $k => $l ) : ?>
								<option value="<?php echo esc_attr( $k ); ?>"><?php echo esc_html( $l ); ?></option>
							<?php endforeach; ?>
						</select>
					</td></tr>
					<tr><th><label for="emz-r-p" id="emz-r-p-l"><?php esc_html_e( 'پارامتر', 'emzagar' ); ?></label></th><td><input type="text" id="emz-r-p" name="p" class="large-text"></td></tr>
					<tr id="emz-r-p2-row"><th><label for="emz-r-p2" id="emz-r-p2-l"><?php esc_html_e( 'متن', 'emzagar' ); ?></label></th><td><textarea id="emz-r-p2" name="p2" rows="4" class="large-text"></textarea>
						<p class="description"><?php esc_html_e( 'متغیرها: {customer} {email} {number} {title} {value} {order} {site} {link}', 'emzagar' ); ?></p></td></tr>
				</tbody></table>
				<?php submit_button( __( 'ذخیره و فعال‌سازی', 'emzagar' ) ); ?>
			</form>
		</section>
		<?php
	}

	private static function render_log() {
		$log = self::log_items();
		?>
		<section class="emz-h-box">
			<h2><?php esc_html_e( 'گزارش اجرا', 'emzagar' ); ?> <small>(<?php echo esc_html( number_format_i18n( self::runs30() ) ); ?> <?php esc_html_e( 'اجرای موفق در ۳۰ روز', 'emzagar' ); ?>)</small></h2>
			<?php if ( empty( $log ) ) : ?>
				<p class="emz-h-empty"><?php esc_html_e( 'هنوز اجرایی ثبت نشده است.', 'emzagar' ); ?></p>
			<?php else : ?>
				<table class="widefat striped"><thead><tr><th><?php esc_html_e( 'زمان', 'emzagar' ); ?></th><th><?php esc_html_e( 'قانون', 'emzagar' ); ?></th><th><?php esc_html_e( 'مرجع', 'emzagar' ); ?></th><th><?php esc_html_e( 'نتیجه', 'emzagar' ); ?></th></tr></thead><tbody>
				<?php foreach ( $log as $e ) : ?>
					<tr>
						<td><?php echo esc_html( sprintf( /* translators: %s: relative time */ __( '%s پیش', 'emzagar' ), human_time_diff( (int) $e['ts'], time() ) ) ); ?></td>
						<td><?php echo esc_html( $e['rule'] ); ?><?php echo 'test' === $e['kind'] ? ' <span class="emz-st">' . esc_html__( 'آزمایشی', 'emzagar' ) . '</span>' : ''; ?></td>
						<td><code><?php echo esc_html( $e['ref'] ); ?></code></td>
						<td><span class="emz-st <?php echo ! empty( $e['ok'] ) ? 'emz-st-signed' : 'emz-st-cancelled'; ?>"><?php echo ! empty( $e['ok'] ) ? '✓' : '✗'; ?></span> <?php echo esc_html( $e['msg'] ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody></table>
				<p><a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_auto_clearlog' ), 'emzagar_auto_clearlog' ) ); ?>"><?php esc_html_e( 'پاک‌کردن گزارش', 'emzagar' ); ?></a></p>
			<?php endif; ?>
		</section>
		<?php
	}
}
