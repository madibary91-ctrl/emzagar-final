<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * کلاینت API امضاگیر (فقط سمت سرور؛ کلید هرگز به مرورگر بازدیدکننده ارسال نمی‌شود).
 */
class Emzagar_API {

	/** آیا آدرس و کلید تنظیم شده‌اند؟ */
	public static function is_configured() {
		$o = emzagar_options();
		return ! empty( $o['base_url'] ) && ! empty( $o['api_key'] );
	}

	/** پاک‌سازی آدرس پایه: فقط http(s) و بدون اسلش پایانی */
	public static function clean_base_url( $url ) {
		$url = trim( (string) $url );
		$url = esc_url_raw( $url, array( 'https', 'http' ) );
		return untrailingslashit( $url );
	}

	/**
	 * فراخوانی API.
	 *
	 * @param string $method GET|POST
	 * @param string $path   مثل /api/v1/contracts
	 * @param array  $query  پارامترهای کوئری
	 * @param array  $body   بدنه‌ی JSON (برای POST)
	 * @param bool   $cache  کش کوتاه‌مدت برای GET
	 * @param bool   $sign   امضای HMAC بدنه با راز همگام‌سازی (برای مسیرهای /api/v1/sync/events)
	 * @return array|WP_Error
	 */
	public static function request( $method, $path, $query = array(), $body = null, $cache = false, $sign = false ) {
		$o = emzagar_options();
		if ( ! self::is_configured() ) {
			return new WP_Error( 'emzagar_not_configured', __( 'امضاگیر هنوز به سایت شما متصل نشده است.', 'emzagar' ) );
		}
		$base = self::clean_base_url( $o['base_url'] );
		$url  = $base . $path;
		if ( ! empty( $query ) ) {
			$url = add_query_arg( array_map( 'strval', $query ), $url );
		}

		$ttl       = max( 0, (int) $o['cache_minutes'] ) * MINUTE_IN_SECONDS;
		$cache_key = 'emz_' . md5( $method . $url . $o['api_key'] );
		if ( $cache && 'GET' === $method && $ttl > 0 ) {
			$hit = get_transient( $cache_key );
			if ( false !== $hit ) {
				return $hit;
			}
		}

		$args = array(
			'method'      => $method,
			'timeout'     => 15,
			'redirection' => 0,
			'headers'     => array(
				'Authorization' => 'Bearer ' . $o['api_key'],
				'Accept'        => 'application/json',
				'Content-Type'  => 'application/json',
				'User-Agent'    => 'EmzagarWP/' . EMZ_VERSION . '; ' . home_url(),
			),
		);
		if ( null !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}
		if ( $sign ) {
			$secret = Emzagar_Sync::secret();
			if ( '' === $secret ) {
				return new WP_Error( 'emzagar_no_secret', __( 'کلید امضای همگام‌سازی هنوز دریافت نشده است.', 'emzagar' ), array( 'error' => 'handshake_required' ) );
			}
			$ts                                      = time();
			$args['headers']['X-Emzagar-Timestamp']  = (string) $ts;
			$args['headers']['X-Emzagar-Signature']  = 'sha256=' . hash_hmac( 'sha256', $ts . '.' . ( isset( $args['body'] ) ? $args['body'] : '' ), $secret );
		}

		$res = wp_remote_request( $url, $args );
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'emzagar_http', __( 'ارتباط با سامانه برقرار نشد: ', 'emzagar' ) . $res->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$json = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( $code < 200 || $code >= 300 || ! is_array( $json ) || empty( $json['ok'] ) ) {
			if ( 401 === $code && is_array( $json ) && isset( $json['error'] ) && 'invalid_api_key' === $json['error'] ) {
				// کلید باطل شده (مثلاً قطع اتصال از پنل): افزونه خودش در پس‌زمینه دوباره وصل می‌شود
				Emzagar_Connect::mark_broken();
			}
			return new WP_Error(
				'emzagar_api',
				self::explain( $code, $json ),
				array(
					'status' => $code,
					'error'  => is_array( $json ) && isset( $json['error'] ) ? (string) $json['error'] : '',
				)
			);
		}
		if ( $cache && 'GET' === $method && $ttl > 0 ) {
			set_transient( $cache_key, $json, $ttl );
		}
		return $json;
	}

	/** پیام خطای قابل‌فهم برای کدهای رایج */
	public static function explain( $code, $json ) {
		$err = is_array( $json ) && isset( $json['error'] ) ? (string) $json['error'] : '';
		$map = array(
			'invalid_api_key'                                => __( 'اتصال منقضی شده است؛ افزونه در حال اتصال مجدد است.', 'emzagar' ),
			'site_unreachable'                               => __( 'سرویس امضاگیر نتوانست به سایت شما دسترسی پیدا کند. اگر سایت در حالت «به‌زودی» یا نگهداری است یا افزونه‌ی امنیتی REST API را بسته، آن را برای مسیر /wp-json/emzagar باز بگذارید.', 'emzagar' ),
			'pairing_expired'                                => __( 'کد اتصال افزونه منقضی شده است. افزونه را دوباره از پنل امضاگیر دانلود کنید.', 'emzagar' ),
			'handshake_expired'                              => __( 'مهلت اتصال تمام شد؛ دوباره تلاش می‌شود.', 'emzagar' ),
			'admin_email_invalid'                            => __( 'ایمیل مدیر سایت معتبر نیست؛ آن را در «تنظیمات ← همگانی» اصلاح کنید.', 'emzagar' ),
			'site_url_invalid'                               => __( 'آدرس سایت وردپرس معتبر نیست.', 'emzagar' ),
			'rate_limited'                                   => __( 'تعداد درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید.', 'emzagar' ),
			'template_not_found'                             => __( 'قالب انتخاب‌شده در سامانه پیدا نشد.', 'emzagar' ),
			'customer_email_invalid'                         => __( 'ایمیل مشتری معتبر نیست.', 'emzagar' ),
			'customer_mobile_invalid'                        => __( 'شماره‌ی موبایل باید به شکل 09123456789 باشد.', 'emzagar' ),
			'customer_name_and_mobile_required_for_new_customer' => __( 'نام و موبایل مشتری الزامی است.', 'emzagar' ),
			'plan_limit_reached'                             => __( 'سقف ماهانه‌ی طرح اشتراک امضاگیر پر شده است؛ طرح را ارتقا دهید.', 'emzagar' ),
			'bad_signature'                                  => __( 'امضای همگام‌سازی نامعتبر است؛ افزونه راز را دوباره دریافت می‌کند.', 'emzagar' ),
			'stale_timestamp'                                => __( 'ساعت سرور وردپرس با ابر اختلاف زیادی دارد؛ ساعت سرور را همگام کنید.', 'emzagar' ),
			'handshake_required'                             => __( 'دست‌دادن همگام‌سازی هنوز انجام نشده است.', 'emzagar' ),
			'sync_paused'                                    => __( 'همگام‌سازی از پنل امضاگیر متوقف شده است.', 'emzagar' ),
			'issue_in_progress'                              => __( 'صدور این قرارداد در حال انجام است.', 'emzagar' ),
			'not_remindable'                                 => __( 'برای این قرارداد یادآوری ممکن نیست (فقط قراردادهای در انتظار امضا).', 'emzagar' ),
		);
		if ( isset( $map[ $err ] ) ) {
			return $map[ $err ];
		}
		/* translators: %d: HTTP status code */
		return sprintf( __( 'خطای سامانه (کد %d) %s', 'emzagar' ), $code, $err );
	}

	/** پاک‌کردن همه‌ی کش‌های افزونه (پس از صدور قرارداد یا تغییر تنظیمات) */
	public static function flush_cache() {
		global $wpdb;
		$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\_transient\_emz\_%' OR option_name LIKE '\_transient\_timeout\_emz\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/** نرمال‌سازی موبایل ایرانی: ارقام فارسی/عربی، +98 و 98 → 09xxxxxxxxx ؛ در صورت نامعتبر بودن رشته‌ی خالی */
	public static function normalize_mobile( $raw ) {
		$raw = strtr(
			(string) $raw,
			array( '۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9', '٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9' )
		);
		$d = preg_replace( '/\D+/', '', $raw );
		if ( 0 === strpos( $d, '0098' ) ) {
			$d = '0' . substr( $d, 4 );
		} elseif ( 0 === strpos( $d, '98' ) && 12 === strlen( $d ) ) {
			$d = '0' . substr( $d, 2 );
		} elseif ( 10 === strlen( $d ) && 0 === strpos( $d, '9' ) ) {
			$d = '0' . $d;
		}
		return preg_match( '/^09\d{9}$/', $d ) ? $d : '';
	}

	/** صدور قرارداد برای یک مشتری */
	public static function issue_contract( $template_id, $name, $email, $mobile, $title = '', $expiry_days = null, $external = null ) {
		$body = array(
			'templateId' => (int) $template_id,
			'customer'   => array(
				'name'   => $name,
				'email'  => $email,
				'mobile' => $mobile,
			),
		);
		if ( '' !== $title ) {
			$body['title'] = $title;
		}
		if ( null !== $expiry_days ) {
			$body['expiryDays'] = (int) $expiry_days;
		}
		if ( is_array( $external ) ) {
			// کلید ایدمپوتنت: تلاش مجدد هرگز قرارداد تکراری نمی‌سازد؛ پیوند سفارش↔قرارداد برای همگام‌سازی وضعیت
			$body['external'] = $external;
		}
		$res = self::request( 'POST', '/api/v1/contracts', array(), $body );
		if ( ! is_wp_error( $res ) ) {
			self::flush_cache();
		}
		return $res;
	}
}
