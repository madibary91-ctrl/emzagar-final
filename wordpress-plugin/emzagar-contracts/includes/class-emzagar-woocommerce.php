<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * یکپارچگی با ووکامرس:
 *  - انتخاب قالب قرارداد برای هر محصول
 *  - صدور خودکار قرارداد پس از پرداخت/تکمیل سفارش؛ ایدمپوتنت (هرگز قرارداد تکراری نمی‌سازد) و با تلاش مجدد خودکار
 *  - وضعیت زنده‌ی امضا روی هر سفارش (از همگام‌سازی دوطرفه) + یادداشت‌های سفارش
 *  - اتوماسیون: نگه‌داشتن سفارش تا امضا، تکمیل خودکار پس از امضا، واکنش به رد/انقضا، قفل دانلود تا امضا
 *  - نمایش لینک و وضعیت امضا در صفحه‌ی تشکر، جزئیات سفارش، ایمیل و حساب کاربری
 *
 * ساختار متای سفارش (_emzagar_contracts): [ شناسه‌ی محصول => { id, url, status, number, pending, signed_at } ]
 * status: pending | signed | rejected | expired | cancelled
 */
class Emzagar_WooCommerce {

	const ENDPOINT = 'emzagar-contracts';
	const META     = '_emzagar_contracts';
	const HELD     = '_emzagar_held';
	const RETRY    = 'emzagar_issue_retry';

	public static function init() {
		add_action( 'init', array( __CLASS__, 'register_endpoint' ) );
		if ( ! class_exists( 'WooCommerce' ) ) {
			return;
		}
		$o = emzagar_options();

		// فیلد قالب در صفحه‌ی محصول
		add_action( 'woocommerce_product_options_general_product_data', array( __CLASS__, 'product_field' ) );
		add_action( 'woocommerce_process_product_meta', array( __CLASS__, 'save_product_field' ) );

		// صدور خودکار
		if ( 'yes' === $o['wc_enabled'] ) {
			$hook = 'completed' === $o['wc_trigger'] ? 'woocommerce_order_status_completed' : 'woocommerce_order_status_processing';
			add_action( $hook, array( __CLASS__, 'maybe_issue' ), 20 );
			if ( 'processing' === $o['wc_trigger'] ) {
				// سفارش‌هایی که مستقیم به «تکمیل» می‌روند (محصولات دانلودی/مجازی)
				add_action( 'woocommerce_order_status_completed', array( __CLASS__, 'maybe_issue' ), 20 );
			}
		}
		add_action( self::RETRY, array( __CLASS__, 'retry_issue' ), 10, 1 );

		// قفل دانلود تا امضا
		add_filter( 'woocommerce_order_is_download_permitted', array( __CLASS__, 'filter_downloads' ), 20, 2 );

		// نمایش به مشتری
		add_action( 'woocommerce_thankyou', array( __CLASS__, 'show_links' ), 20 );
		add_action( 'woocommerce_order_details_after_order_table', array( __CLASS__, 'show_links_order' ), 20 );
		add_action( 'woocommerce_email_after_order_table', array( __CLASS__, 'email_links' ), 20, 4 );

		// حساب کاربری
		add_filter( 'woocommerce_account_menu_items', array( __CLASS__, 'menu_item' ) );
		add_action( 'woocommerce_account_' . self::ENDPOINT . '_endpoint', array( __CLASS__, 'account_content' ) );
		add_filter( 'query_vars', array( __CLASS__, 'query_vars' ) );
	}

	public static function register_endpoint() {
		add_rewrite_endpoint( self::ENDPOINT, EP_ROOT | EP_PAGES );
	}

	public static function query_vars( $vars ) {
		$vars[] = self::ENDPOINT;
		return $vars;
	}

	/* ───────── وضعیت‌ها ───────── */

	public static function status_labels() {
		return array(
			'pending'   => __( 'در انتظار امضا', 'emzagar' ),
			'signed'    => __( 'امضا شده', 'emzagar' ),
			'rejected'  => __( 'رد شده', 'emzagar' ),
			'expired'   => __( 'منقضی شده', 'emzagar' ),
			'cancelled' => __( 'لغو شده', 'emzagar' ),
		);
	}

	/** وضعیت ابر (sent/draft/signed/…) → وضعیت محلی */
	public static function map_status( $cloud ) {
		$cloud = (string) $cloud;
		if ( in_array( $cloud, array( 'signed', 'rejected', 'expired', 'cancelled' ), true ) ) {
			return $cloud;
		}
		return 'pending';
	}

	public static function entries( $order ) {
		$done = $order->get_meta( self::META );
		if ( ! is_array( $done ) ) {
			return array();
		}
		foreach ( $done as $pid => $e ) {
			if ( ! is_array( $e ) ) {
				unset( $done[ $pid ] );
				continue;
			}
			$done[ $pid ] = wp_parse_args(
				$e,
				array(
					'id'        => 0,
					'url'       => '',
					'status'    => 'pending', // نسخه‌های قدیمی وضعیت نداشتند
					'number'    => '',
					'pending'   => 1,
					'signed_at' => 0,
				)
			);
		}
		return $done;
	}

	public static function has_unsigned( $order ) {
		foreach ( self::entries( $order ) as $e ) {
			if ( 'signed' !== $e['status'] ) {
				return true;
			}
		}
		return false;
	}

	/* ───────── محصول ───────── */

	public static function product_field() {
		echo '<div class="options_group">';
		$choices = array( '' => __( '— بدون قرارداد —', 'emzagar' ) );
		foreach ( Emzagar_Settings::templates() as $t ) {
			$choices[ (string) $t['id'] ] = $t['title'];
		}
		if ( count( $choices ) > 1 ) {
			woocommerce_wp_select(
				array(
					'id'          => '_emzagar_template_id',
					'label'       => __( 'قالب قرارداد امضاگیر', 'emzagar' ),
					'options'     => $choices,
					'desc_tip'    => true,
					'description' => __( 'پس از خرید این محصول، قرارداد از روی این قالب برای مشتری صادر می‌شود.', 'emzagar' ),
				)
			);
		} else {
			woocommerce_wp_text_input(
				array(
					'id'          => '_emzagar_template_id',
					'label'       => __( 'شناسه‌ی قالب امضاگیر', 'emzagar' ),
					'type'        => 'number',
					'desc_tip'    => true,
					'description' => __( 'پس از اتصال امضاگیر (خودکار)، فهرست قالب‌ها اینجا نمایش داده می‌شود.', 'emzagar' ),
				)
			);
		}
		echo '</div>';
	}

	public static function save_product_field( $post_id ) {
		// ووکامرس پیش از این هوک، nonce و دسترسی ویرایش را بررسی کرده است
		$val = isset( $_POST['_emzagar_template_id'] ) ? absint( wp_unslash( $_POST['_emzagar_template_id'] ) ) : 0; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$product = wc_get_product( $post_id );
		if ( ! $product ) {
			return;
		}
		if ( $val ) {
			$product->update_meta_data( '_emzagar_template_id', $val );
		} else {
			$product->delete_meta_data( '_emzagar_template_id' );
		}
		$product->save_meta_data();
	}

	/* ───────── صدور ───────── */

	/** خطای گذرا (شبکه، ۵xx، محدودیت نرخ، صدور هم‌زمان) که ارزش تلاش مجدد دارد */
	private static function is_transient_error( $err ) {
		if ( 'emzagar_http' === $err->get_error_code() ) {
			return true;
		}
		$data   = $err->get_error_data();
		$status = is_array( $data ) && isset( $data['status'] ) ? (int) $data['status'] : 0;
		return $status >= 500 || 429 === $status || 409 === $status;
	}

	public static function retry_issue( $order_id ) {
		self::maybe_issue( $order_id );
	}

	/**
	 * صدور قرارداد برای اقلام سفارش.
	 *
	 * @param int  $order_id شناسه‌ی سفارش
	 * @param bool $force    صدور دستی از پیشخوان (حتی اگر «صدور خودکار» خاموش باشد)
	 * @return array {issued:int, errors:string[]}
	 */
	public static function maybe_issue( $order_id, $force = false ) {
		$result = array(
			'issued' => 0,
			'errors' => array(),
		);
		$order  = wc_get_order( $order_id );
		if ( ! $order || ! Emzagar_API::is_configured() ) {
			return $result;
		}
		$o     = emzagar_options();
		$done  = self::entries( $order );
		$email = strtolower( $order->get_billing_email() );
		$name  = trim( $order->get_formatted_billing_full_name() );
		$phone = Emzagar_API::normalize_mobile( $order->get_billing_phone() );
		if ( ! $email ) {
			$result['errors'][] = __( 'ایمیل صورتحساب سفارش خالی است.', 'emzagar' );
			return $result;
		}
		if ( ! $phone ) {
			$msg = __( 'امضاگیر: شماره‌ی موبایل صورتحساب معتبر نیست (قالب 09123456789)؛ قرارداد صادر نشد.', 'emzagar' );
			if ( $order->get_meta( '_emzagar_last_note' ) !== $msg ) {
				$order->add_order_note( $msg );
				$order->update_meta_data( '_emzagar_last_note', $msg );
				$order->save();
			}
			$result['errors'][] = $msg;
			return $result;
		}

		$changed   = false;
		$retry     = false;
		$new_count = 0;
		foreach ( $order->get_items() as $item ) {
			$product = $item->get_product();
			if ( ! $product ) {
				continue;
			}
			$pid = $product->get_parent_id() ? $product->get_parent_id() : $product->get_id();
			if ( isset( $done[ $pid ] ) ) {
				continue; // قبلاً برای این محصول صادر شده است
			}
			$parent = wc_get_product( $pid );
			$tpl    = $parent ? (int) $parent->get_meta( '_emzagar_template_id' ) : 0;
			if ( ! $tpl && 'yes' === $o['wc_all_orders'] ) {
				$tpl = (int) $o['default_template'];
			}
			if ( ! $tpl ) {
				continue;
			}
			/* translators: 1: product name, 2: order number */
			$title = sprintf( __( 'قرارداد %1$s — سفارش %2$s', 'emzagar' ), $item->get_name(), $order->get_order_number() );
			$res   = Emzagar_API::issue_contract(
				$tpl,
				$name ? $name : $email,
				$email,
				$phone,
				mb_substr( $title, 0, 190 ),
				(int) $o['wc_expiry_days'],
				array(
					'source'    => 'woocommerce',
					'orderId'   => (int) $order->get_id(),
					'productId' => (int) $pid,
					'key'       => 'wc:' . $order->get_id() . ':' . $pid,
				)
			);
			if ( is_wp_error( $res ) ) {
				$result['errors'][] = $res->get_error_message();
				if ( self::is_transient_error( $res ) ) {
					$retry = true;
				} else {
					/* translators: %s: error message */
					$msg = sprintf( __( 'امضاگیر: صدور قرارداد ناموفق بود — %s', 'emzagar' ), $res->get_error_message() );
					if ( $order->get_meta( '_emzagar_last_note' ) !== $msg ) {
						$order->add_order_note( $msg );
						$order->update_meta_data( '_emzagar_last_note', $msg );
						$changed = true;
					}
				}
				continue;
			}
			$url = '';
			if ( ! empty( $res['signUrl'] ) ) {
				$url = esc_url_raw( $res['signUrl'] );
			} elseif ( ! empty( $res['shortUrl'] ) ) {
				$url = esc_url_raw( $res['shortUrl'] );
			}
			$status         = self::map_status( isset( $res['status'] ) ? $res['status'] : 'sent' );
			$done[ $pid ]   = array(
				'id'        => (int) $res['id'],
				'url'       => $url,
				'status'    => $status,
				'number'    => '',
				'pending'   => 'signed' === $status ? 0 : 1,
				'signed_at' => 0,
			);
			$changed        = true;
			++$new_count;
			++$result['issued'];
			if ( 'signed' !== $status ) {
				Emzagar_Sync::track_open( (int) $res['id'], $order->get_id() );
			}
			if ( empty( $res['reused'] ) ) {
				/* translators: 1: contract id, 2: signing URL */
				$order->add_order_note( sprintf( __( 'امضاگیر: قرارداد #%1$d صادر شد — %2$s', 'emzagar' ), (int) $res['id'], $url ) );
			}
		}
		if ( $changed ) {
			$order->update_meta_data( self::META, $done );
			$order->delete_meta_data( '_emzagar_retries' );
			$hold = $new_count > 0 && 'yes' === $o['wc_hold_until_signed'] && $order->has_status( 'processing' ) && self::has_unsigned( $order ) && ! $order->get_meta( self::HELD );
			if ( $hold ) {
				$order->update_meta_data( self::HELD, $order->get_status() );
				$order->update_status( 'on-hold', __( 'امضاگیر: سفارش تا امضای قرارداد در حالت «در انتظار بررسی» می‌ماند.', 'emzagar' ) );
			} else {
				$order->save();
			}
		}
		if ( $retry ) {
			$tries = (int) $order->get_meta( '_emzagar_retries' ) + 1;
			if ( $tries <= 6 ) {
				$order->update_meta_data( '_emzagar_retries', $tries );
				$order->save();
				if ( ! wp_next_scheduled( self::RETRY, array( (int) $order->get_id() ) ) ) {
					wp_schedule_single_event( time() + (int) min( 6 * HOUR_IN_SECONDS, 120 * pow( 2, $tries - 1 ) ), self::RETRY, array( (int) $order->get_id() ) );
				}
			} else {
				$order->add_order_note( __( 'امضاگیر: پس از چند تلاش، صدور خودکار انجام نشد. از کادر «امضاگیر» همین سفارش، دستی صادر کنید.', 'emzagar' ) );
			}
		}
		if ( $result['issued'] ) {
			Emzagar_API::flush_cache();
		}
		return $result;
	}

	/* ───────── ورودی همگام‌سازی: وضعیت قرارداد از ابر ───────── */

	/**
	 * اعمال رویداد/عکس لحظه‌ای قرارداد بر سفارش مربوط.
	 *
	 * @param string $type contract.* یا contract.snapshot
	 * @param array  $d    بار رویداد از ابر
	 * @return bool آیا بر سفارشی اعمال شد
	 */
	public static function apply_contract_event( $type, $d ) {
		if ( ! class_exists( 'WooCommerce' ) ) {
			return false;
		}
		$order_id = isset( $d['wcOrderId'] ) ? (int) $d['wcOrderId'] : 0;
		$cid      = isset( $d['contractId'] ) ? (int) $d['contractId'] : ( isset( $d['id'] ) ? (int) $d['id'] : 0 );
		$order    = $order_id ? wc_get_order( $order_id ) : null;
		if ( ! $order && $cid ) {
			// عکس‌های ترمیم (GET) شناسه‌ی سفارش ندارند؛ از فهرست قراردادهای باز پیدا می‌کنیم
			$open = get_option( Emzagar_Sync::OPT_OPEN, array() );
			if ( is_array( $open ) && isset( $open[ $cid ]['o'] ) ) {
				$order = wc_get_order( (int) $open[ $cid ]['o'] );
			}
		}
		if ( ! $order || ! $cid ) {
			return false;
		}
		$entries = self::entries( $order );
		$key     = null;
		foreach ( $entries as $pid => $e ) {
			if ( (int) $e['id'] === $cid ) {
				$key = $pid;
				break;
			}
		}
		if ( null === $key ) {
			return false; // قرارداد متعلق به این سفارش در افزونه ثبت نشده (مثلاً صدور دستی از پنل)
		}
		$entry   = $entries[ $key ];
		$old     = $entry['status'];
		$new     = self::map_status( isset( $d['status'] ) ? $d['status'] : '' );
		$pending = isset( $d['pendingSigners'] ) ? (int) $d['pendingSigners'] : (int) $entry['pending'];
		// وضعیت نهایی هرگز با رویداد دیرهنگام به «در انتظار» برنمی‌گردد
		if ( 'pending' !== $old && 'pending' === $new ) {
			$new = $old;
		}
		$status_changed  = $new !== $old;
		$pending_changed = 'pending' === $new && $pending !== (int) $entry['pending'];
		if ( 'contract.reminder' === $type ) {
			$order->add_order_note( sprintf( /* translators: %d: contract id */ __( 'امضاگیر: یادآوری امضای قرارداد #%d ارسال شد.', 'emzagar' ), $cid ) );
			return true;
		}
		if ( ! empty( $d['number'] ) ) {
			$entry['number'] = sanitize_text_field( (string) $d['number'] );
		}
		$entry['status']  = $new;
		$entry['pending'] = $pending;
		if ( 'signed' === $new && ! $entry['signed_at'] ) {
			$entry['signed_at'] = ! empty( $d['signedAt'] ) ? (int) strtotime( (string) $d['signedAt'] ) : time();
		}
		$entries[ $key ] = $entry;
		$order->update_meta_data( self::META, $entries );

		$label = $entry['number'] ? $entry['number'] : '#' . $cid;
		$notes = array(
			'signed'    => sprintf( /* translators: %s: contract number */ __( 'امضاگیر: قرارداد %s توسط همه‌ی طرفین امضا و نهایی شد ✓', 'emzagar' ), $label ),
			'rejected'  => sprintf( /* translators: %s: contract number */ __( 'امضاگیر: قرارداد %s رد شد.', 'emzagar' ), $label ),
			'expired'   => sprintf( /* translators: %s: contract number */ __( 'امضاگیر: مهلت امضای قرارداد %s تمام شد و منقضی شد.', 'emzagar' ), $label ),
			'cancelled' => sprintf( /* translators: %s: contract number */ __( 'امضاگیر: قرارداد %s لغو شد.', 'emzagar' ), $label ),
		);
		if ( $status_changed && isset( $notes[ $new ] ) ) {
			$order->add_order_note( $notes[ $new ] );
		} elseif ( $pending_changed && 'contract.signed' === $type ) {
			/* translators: 1: contract number, 2: remaining signers */
			$order->add_order_note( sprintf( __( 'امضاگیر: یکی از طرفین قرارداد %1$s را امضا کرد (%2$d امضای باقی‌مانده).', 'emzagar' ), $label, $pending ) );
		}

		if ( 'pending' !== $new ) {
			Emzagar_Sync::untrack( $cid );
		}
		$order->save();
		if ( $status_changed ) {
			self::after_change( $order );
			do_action( 'emzagar_contract_status_changed', $order, $entry, $old, $new );
		}
		Emzagar_API::flush_cache();
		return true;
	}

	/** اتوماسیون وضعیت سفارش پس از تغییر وضعیت قراردادها (فقط طبق تنظیمات مدیر) */
	private static function after_change( $order ) {
		$entries = self::entries( $order );
		if ( empty( $entries ) ) {
			return;
		}
		$o          = emzagar_options();
		$all_signed = true;
		$any_bad    = false;
		foreach ( $entries as $e ) {
			if ( 'signed' !== $e['status'] ) {
				$all_signed = false;
			}
			if ( in_array( $e['status'], array( 'rejected', 'expired', 'cancelled' ), true ) ) {
				$any_bad = true;
			}
		}
		if ( $all_signed ) {
			$held   = (string) $order->get_meta( self::HELD );
			$target = (string) $o['wc_on_signed'];
			if ( $held ) {
				$order->delete_meta_data( self::HELD );
				$order->save();
				$restore = 'completed' === $target ? 'completed' : ( 'processing' === $target ? 'processing' : $held );
				if ( $order->has_status( 'on-hold' ) ) {
					$order->update_status( $restore, __( 'امضاگیر: همه‌ی قراردادها امضا شد؛ سفارش آزاد شد.', 'emzagar' ) );
				}
			} elseif ( 'completed' === $target && $order->has_status( 'processing' ) ) {
				$order->update_status( 'completed', __( 'امضاگیر: همه‌ی قراردادها امضا شد؛ سفارش تکمیل شد.', 'emzagar' ) );
			}
			if ( 'yes' === $o['wc_gate_downloads'] && function_exists( 'wc_downloadable_product_permissions' ) ) {
				wc_downloadable_product_permissions( $order->get_id(), true ); // دانلودها پس از امضا فعال می‌شود
			}
		} elseif ( $any_bad ) {
			if ( 'on-hold' === $o['wc_on_reject'] && $order->has_status( array( 'pending', 'processing' ) ) ) {
				$order->update_status( 'on-hold', __( 'امضاگیر: قرارداد رد/منقضی/لغو شد؛ سفارش برای بررسی نگه داشته شد.', 'emzagar' ) );
			} elseif ( 'cancelled' === $o['wc_on_reject'] && $order->has_status( array( 'pending', 'processing', 'on-hold' ) ) ) {
				$order->update_status( 'cancelled', __( 'امضاگیر: قرارداد رد/منقضی/لغو شد؛ سفارش لغو شد.', 'emzagar' ) );
			}
		}
	}

	/** قفل دانلود: تا امضای همه‌ی قراردادهای سفارش، دانلود مجاز نیست (اختیاری) */
	public static function filter_downloads( $permitted, $order ) {
		$o = emzagar_options();
		if ( 'yes' !== $o['wc_gate_downloads'] || ! $permitted || ! $order ) {
			return $permitted;
		}
		return self::has_unsigned( $order ) ? false : $permitted;
	}

	/* ───────── نمایش ───────── */

	private static function links_html( $order ) {
		$done = self::entries( $order );
		if ( empty( $done ) ) {
			return '';
		}
		$labels = self::status_labels();
		$h      = '<section class="emzagar-order-contracts"><h2>' . esc_html__( 'قراردادهای شما', 'emzagar' ) . '</h2><ul>';
		$wait   = false;
		foreach ( $done as $c ) {
			$st    = isset( $labels[ $c['status'] ] ) ? $c['status'] : 'pending';
			$badge = '<span class="emzagar-badge emzagar-badge-' . esc_attr( $st ) . '">' . esc_html( $labels[ $st ] ) . '</span>';
			/* translators: %s: contract id or number */
			$text = sprintf( 'pending' === $st ? __( 'مشاهده و امضای قرارداد %s', 'emzagar' ) : __( 'قرارداد %s', 'emzagar' ), $c['number'] ? $c['number'] : '#' . (int) $c['id'] );
			if ( 'pending' === $st ) {
				$wait = true;
			}
			if ( ! empty( $c['url'] ) && in_array( $st, array( 'pending', 'signed' ), true ) ) {
				$h .= '<li><a href="' . esc_url( $c['url'] ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( $text ) . '</a> ' . $badge . '</li>';
			} else {
				$h .= '<li>' . esc_html( $text ) . ' ' . $badge . '</li>';
			}
		}
		$h .= '</ul>';
		if ( $wait ) {
			$h .= '<p>' . esc_html__( 'کد تایید امضا به موبایل شما پیامک می‌شود.', 'emzagar' ) . '</p>';
		}
		return $h . '</section>';
	}

	public static function show_links( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( $order ) {
			echo wp_kses_post( self::links_html( $order ) );
		}
	}

	public static function show_links_order( $order ) {
		echo wp_kses_post( self::links_html( $order ) );
	}

	public static function email_links( $order, $sent_to_admin, $plain_text, $email ) {
		if ( $sent_to_admin ) {
			return;
		}
		$done = self::entries( $order );
		if ( empty( $done ) ) {
			return;
		}
		if ( $plain_text ) {
			echo "\n" . esc_html__( 'قراردادهای شما:', 'emzagar' ) . "\n";
			foreach ( $done as $c ) {
				if ( ! empty( $c['url'] ) && 'pending' === $c['status'] ) {
					echo esc_url_raw( $c['url'] ) . "\n";
				}
			}
			return;
		}
		echo wp_kses_post( self::links_html( $order ) );
	}

	/* ───────── حساب کاربری ───────── */

	public static function menu_item( $items ) {
		$new = array();
		foreach ( $items as $key => $label ) {
			if ( 'customer-logout' === $key ) {
				$new[ self::ENDPOINT ] = __( 'قراردادها', 'emzagar' );
			}
			$new[ $key ] = $label;
		}
		if ( ! isset( $new[ self::ENDPOINT ] ) ) {
			$new[ self::ENDPOINT ] = __( 'قراردادها', 'emzagar' );
		}
		return $new;
	}

	public static function account_content() {
		echo Emzagar_Shortcodes::render_dashboard( array( 'title' => __( 'قراردادهای من', 'emzagar' ) ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- خروجی داخل کلاس escape شده است
	}
}
