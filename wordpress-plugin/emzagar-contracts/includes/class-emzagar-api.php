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

	const OPT_GEN = 'emzagar_cache_gen';
	/** قطع‌کننده‌ی مدار (نام عمداً بدون پیشوند emz_ تا flush_cache آن را پاک نکند) */
	const BREAKER = 'emzagar_cloud_down';

	/**
	 * کلید API فقط روی HTTPS (یا میزبان حلقه‌ی محلی) فرستاده می‌شود؛ حتی اگر آدرس ناامن قبلاً ذخیره شده باشد
	 * (مثلاً از نسخه‌های قدیمی یا WP_DEBUG روشن در سرور واقعی)، توکن Bearer هرگز بدون رمزنگاری نمی‌رود.
	 */
	public static function transport_ok( $base ) {
		$base = (string) $base;
		if ( 0 === strpos( $base, 'https://' ) ) {
			return true;
		}
		$host = (string) wp_parse_url( $base, PHP_URL_HOST );
		return in_array( strtolower( $host ), array( 'localhost', '127.0.0.1', '[::1]', '::1' ), true );
	}

	/** وضعیت قطع‌کننده‌ی مدار: until, fails. ابر چند بار پیاپی در دسترس نبوده؟ */
	public static function breaker_state() {
		$b = get_option( self::BREAKER, array() );
		return wp_parse_args( is_array( $b ) ? $b : array(), array( 'until' => 0, 'fails' => 0, 'at' => 0 ) );
	}

	public static function breaker_open() {
		$b = self::breaker_state();
		return (int) $b['until'] > time();
	}

	/** پس از هر خطای شبکه/۵۰۲/۵۰۳/۵۰۴ — فاصله‌ی افزایشی ۱۵ث … ۵د؛ تا ابر برگردد درخواست‌ها بدون انتظار رد می‌شوند */
	public static function breaker_trip() {
		$b     = self::breaker_state();
		$fails = min( 10, (int) $b['fails'] + 1 );
		update_option(
			self::BREAKER,
			array(
				'until' => time() + (int) min( 300, 15 * pow( 2, $fails - 1 ) ),
				'fails' => $fails,
				'at'    => time(),
			),
			false
		);
	}

	public static function breaker_reset() {
		delete_option( self::BREAKER );
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
		if ( ! self::transport_ok( $base ) ) {
			return new WP_Error( 'emzagar_insecure', __( 'آدرس سرویس امضاگیر باید با https:// شروع شود؛ برای امنیت کلید API ارسال نشد.', 'emzagar' ) );
		}
		$url = $base . $path;
		if ( ! empty( $query ) ) {
			$url = add_query_arg( array_map( 'strval', $query ), $url );
		}

		$ttl       = max( 0, (int) $o['cache_minutes'] ) * MINUTE_IN_SECONDS;
		$cache_key = 'emz_' . md5( (int) get_option( self::OPT_GEN, 1 ) . $method . $url . $o['api_key'] );
		if ( $cache && 'GET' === $method && $ttl > 0 ) {
			$hit = get_transient( $cache_key );
			if ( false !== $hit ) {
				return $hit;
			}
		}

		// ابر چند لحظه‌ی پیش پاسخ نداده است: به‌جای ۱۵ ثانیه معطل کردن پرداخت/پیشخوان، فوراً خطای گذرا می‌دهیم
		if ( self::breaker_open() ) {
			return new WP_Error(
				'emzagar_http',
				__( 'ارتباط با سامانه موقتاً برقرار نیست؛ چند لحظه بعد خودکار دوباره تلاش می‌شود.', 'emzagar' ),
				array( 'status' => 0, 'breaker' => true )
			);
		}

		$args = array(
			'method'      => $method,
			'timeout'     => max( 3, (int) apply_filters( 'emzagar_http_timeout', 15, $method, $path ) ),
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
			self::breaker_trip();
			return new WP_Error( 'emzagar_http', __( 'ارتباط با سامانه برقرار نشد: ', 'emzagar' ) . $res->get_error_message(), array( 'status' => 0 ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( in_array( $code, array( 502, 503, 504 ), true ) ) {
			self::breaker_trip();
		} elseif ( $code > 0 && $code < 500 && self::breaker_state()['fails'] ) {
			self::breaker_reset(); // ابر پاسخ داد (حتی با خطای ۴xx): مدار بسته می‌شود
		}
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
		// با کش شیء بیرونی (Redis/Memcached) ترنزینت‌ها در جدول options نیستند؛ شماره‌ی نسلِ کلید همه‌ی کش‌ها را یک‌جا باطل می‌کند
		update_option( self::OPT_GEN, (int) get_option( self::OPT_GEN, 1 ) + 1, true );
		$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\_transient\_emz\_%' OR option_name LIKE '\_transient\_timeout\_emz\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	}

	/**
	 * نرمال‌سازی موبایل ایرانی → 09xxxxxxxxx ؛ در صورت نامعتبر بودن رشته‌ی خالی.
	 * تحمل‌پذیر در برابر آنچه در سفارش‌های واقعی دیده می‌شود: ارقام فارسی/عربی/تمام‌عرض، +98 ،‌ 0098 ،‌ «+98 (0) 912…»،
	 * فاصله/خط‌تیره/پرانتز/کاراکترهای نامرئی جهت‌دهی (RLM/LRM/ZWNJ)، موجودیت‌های HTML، و فیلدی که علاوه بر موبایل
	 * متن یا تلفن ثابت هم دارد (مثلاً «تلفن: 021-123 ، موبایل: 0912 123 4567»).
	 */
	public static function normalize_mobile( $raw ) {
		if ( is_array( $raw ) ) {
			$raw = implode( ' ', array_map( 'strval', array_filter( $raw, 'is_scalar' ) ) );
		}
		$raw = html_entity_decode( (string) $raw, ENT_QUOTES, 'UTF-8' );
		$raw = strtr(
			$raw,
			array(
				'۰' => '0', '۱' => '1', '۲' => '2', '۳' => '3', '۴' => '4', '۵' => '5', '۶' => '6', '۷' => '7', '۸' => '8', '۹' => '9',
				'٠' => '0', '١' => '1', '٢' => '2', '٣' => '3', '٤' => '4', '٥' => '5', '٦' => '6', '٧' => '7', '٨' => '8', '٩' => '9',
				'０' => '0', '１' => '1', '２' => '2', '３' => '3', '４' => '4', '５' => '5', '６' => '6', '７' => '7', '８' => '8', '９' => '9',
			)
		);
		// ۱) کل مقدار فقط یک شماره است
		$m = self::mobile_from_digits( preg_replace( '/\D+/', '', $raw ) );
		if ( '' !== $m ) {
			return $m;
		}
		// ۲) مقدار شامل چند عدد/متن است؛ اولین «شماره‌ی موبایل‌مانند» را بردار
		if ( preg_match_all( '/\+?\d[\d\s\-().]{8,}\d/', $raw, $found ) ) {
			foreach ( $found[0] as $cand ) {
				$m = self::mobile_from_digits( preg_replace( '/\D+/', '', $cand ) );
				if ( '' !== $m ) {
					return $m;
				}
			}
		}
		return '';
	}

	/** فقط رقم‌ها → 09xxxxxxxxx یا '' */
	private static function mobile_from_digits( $d ) {
		$d = (string) $d;
		if ( 0 === strpos( $d, '0098' ) ) {
			$d = substr( $d, 4 );
			$d = ( '' !== $d && '9' === $d[0] ) ? '0' . $d : $d;
		} elseif ( 0 === strpos( $d, '98' ) && 12 === strlen( $d ) ) {
			$d = '0' . substr( $d, 2 );
		} elseif ( 0 === strpos( $d, '98' ) && 13 === strlen( $d ) && '0' === $d[2] ) {
			$d = substr( $d, 2 ); // +98 (0) 912…
		} elseif ( 10 === strlen( $d ) && '9' === $d[0] ) {
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
