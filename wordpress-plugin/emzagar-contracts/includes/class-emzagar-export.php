<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * مالکیت و آزادی داده (Data Portability): خروجی کامل، ورود (بازگردانی) و پشتیبان خودکار پیش از به‌روزرسانی.
 *
 *  • خروجی JSON کامل: تنظیمات، ماژول‌ها، محدودیت‌ها، اتوماسیون‌ها، اتصال فرم‌ها، لاگ اجرا، صندوق فعالیت،
 *    دروازه‌های محتوا، قالب محصولات و (اختیاری) فهرست قراردادهای ابر.
 *  • خروجی CSV برای هر مجموعه (UTF-8 با BOM برای اکسل فارسی؛ محافظت در برابر Formula Injection).
 *  • بسته‌ی ZIP حاوی همه‌ی CSVها و JSON.
 *  • ورود از فایل JSON با اعتبارسنجی و پاک‌سازی کامل (هیچ داده‌ی خام مستقیم ذخیره نمی‌شود)؛ پیش از هر ورود، پشتیبان گرفته می‌شود.
 *  • اسرار (کلید API، راز همگام‌سازی، توکن‌ها) هرگز در خروجی نیستند.
 */
class Emzagar_Export {

	const SCHEMA   = 1;
	const OPT_SNAP = 'emzagar_snapshot';
	const OPT_LAST = 'emzagar_last_export';

	public static function init() {
		if ( ! is_admin() ) {
			return;
		}
		add_action( 'admin_post_emzagar_export', array( __CLASS__, 'act_export' ) );
		add_action( 'admin_post_emzagar_import', array( __CLASS__, 'act_import' ) );
		add_action( 'admin_post_emzagar_restore_snapshot', array( __CLASS__, 'act_restore_snapshot' ) );
	}

	/* ───────────── ساخت داده ───────────── */

	/** تنظیمات بدون اسرار */
	private static function settings_public() {
		$o = emzagar_options();
		unset( $o['api_key'], $o['pairing_used'] );
		$o['has_api_key'] = Emzagar_API::is_configured() ? 'yes' : 'no';
		return $o;
	}

	private static function gates() {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT p.ID, p.post_type, p.post_title, pm.meta_value AS gate, mm.meta_value AS msg FROM {$wpdb->postmeta} pm JOIN {$wpdb->posts} p ON p.ID = pm.post_id LEFT JOIN {$wpdb->postmeta} mm ON mm.post_id = p.ID AND mm.meta_key = %s WHERE pm.meta_key = %s AND pm.meta_value <> '' LIMIT 5000", Emzagar_Access::META_MSG, Emzagar_Access::META_GATE ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$out  = array();
		foreach ( (array) $rows as $r ) {
			$out[] = array(
				'post_id' => (int) $r['ID'],
				'type'    => $r['post_type'],
				'title'   => $r['post_title'],
				'url'     => get_permalink( (int) $r['ID'] ),
				'gate'    => $r['gate'],
				'message' => (string) $r['msg'],
			);
		}
		return $out;
	}

	private static function products() {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results( "SELECT p.ID, p.post_title, pm.meta_value AS tpl FROM {$wpdb->postmeta} pm JOIN {$wpdb->posts} p ON p.ID = pm.post_id WHERE pm.meta_key = '_emzagar_template_id' AND pm.meta_value <> '' AND pm.meta_value <> '0' LIMIT 5000", ARRAY_A );
		$out  = array();
		foreach ( (array) $rows as $r ) {
			$out[] = array( 'product_id' => (int) $r['ID'], 'title' => $r['post_title'], 'template_id' => (int) $r['tpl'] );
		}
		return $out;
	}

	/** قراردادهای ابر (بهترین تلاش، با سقف و محدودیت زمانی) */
	private static function contracts() {
		if ( ! Emzagar_API::is_configured() ) {
			return array();
		}
		$max   = (int) apply_filters( 'emzagar_export_max_contracts', 1000 );
		$out   = array();
		$start = time();
		for ( $page = 1; $page <= 40 && count( $out ) < $max && ( time() - $start ) < 25; $page++ ) {
			$res = Emzagar_API::request( 'GET', '/api/v1/contracts', array( 'page' => $page, 'limit' => 50 ) );
			if ( is_wp_error( $res ) || empty( $res['items'] ) ) {
				break;
			}
			foreach ( $res['items'] as $it ) {
				if ( is_array( $it ) ) {
					$out[] = $it;
				}
			}
			if ( count( $res['items'] ) < 50 ) {
				break;
			}
		}
		return array_slice( $out, 0, $max );
	}

	/** نسخه‌ی سبک برای پشتیبان‌گیری خودکار و بازگردانی */
	public static function snapshot() {
		return array(
			'settings'    => self::settings_public(),
			'modules'     => Emzagar_Modules::saved(),
			'limits'      => Emzagar_Limits::opts(),
			'hub'         => Emzagar_Hub::opts(),
			'automations' => array( 'rules' => Emzagar_Automations::rules() ),
			'forms'       => array( 'rules' => Emzagar_Forms::rules() ),
		);
	}

	/** بسته‌ی کامل خروجی */
	public static function bundle( $with_contracts = false ) {
		$user = wp_get_current_user();
		$data = self::snapshot();
		$data['automations']['log'] = Emzagar_Automations::log_items();
		$data['feed']               = Emzagar_Inbox::items();
		$data['gates']              = self::gates();
		$data['products']           = self::products();
		$data['rate_limit']         = Emzagar_Limits::stats();
		if ( $with_contracts ) {
			$data['contracts'] = self::contracts();
		}
		$json = wp_json_encode( $data );
		return array(
			'format'      => 'emzagar-export',
			'schema'      => self::SCHEMA,
			'plugin'      => EMZ_VERSION,
			'wordpress'   => get_bloginfo( 'version' ),
			'site'        => home_url(),
			'exported_at' => gmdate( 'c' ),
			'exported_by' => $user && $user->exists() ? $user->user_login : 'cli',
			'checksum'    => 'sha256:' . hash( 'sha256', (string) $json ),
			'data'        => $data,
		);
	}

	/* ───────────── CSV ───────────── */

	public static function dataset_defs() {
		return array(
			'automation_rules' => __( 'قوانین اتوماسیون', 'emzagar' ),
			'form_rules'       => __( 'اتصال فرم‌ها', 'emzagar' ),
			'execution_log'    => __( 'گزارش اجرا', 'emzagar' ),
			'activity_feed'    => __( 'صندوق فعالیت', 'emzagar' ),
			'content_gates'    => __( 'دروازه‌های محتوا', 'emzagar' ),
			'product_templates' => __( 'قالب محصولات', 'emzagar' ),
			'settings'         => __( 'تنظیمات (بدون اسرار)', 'emzagar' ),
			'contracts'        => __( 'قراردادها (از ابر)', 'emzagar' ),
		);
	}

	/** @return array<int,array<string,scalar>> */
	public static function rows( $set ) {
		switch ( $set ) {
			case 'automation_rules':
				return self::norm( Emzagar_Automations::rules() );
			case 'form_rules':
				return self::norm( Emzagar_Forms::rules() );
			case 'execution_log':
				$rows = array();
				foreach ( Emzagar_Automations::log_items() as $e ) {
					$rows[] = array(
						'time'    => gmdate( 'c', (int) $e['ts'] ),
						'rule'    => $e['rule'],
						'kind'    => $e['kind'],
						'ref'     => $e['ref'],
						'success' => ! empty( $e['ok'] ) ? 'yes' : 'no',
						'message' => $e['msg'],
					);
				}
				return $rows;
			case 'activity_feed':
				return self::norm( Emzagar_Inbox::items() );
			case 'content_gates':
				return self::norm( self::gates() );
			case 'product_templates':
				return self::norm( self::products() );
			case 'settings':
				$rows = array();
				$all  = array(
					'general' => self::settings_public(),
					'hub'     => Emzagar_Hub::opts(),
					'limits'  => Emzagar_Limits::opts(),
					'modules' => Emzagar_Modules::saved(),
				);
				foreach ( $all as $group => $vals ) {
					foreach ( (array) $vals as $k => $v ) {
						$rows[] = array( 'group' => $group, 'key' => $k, 'value' => is_scalar( $v ) ? $v : wp_json_encode( $v ) );
					}
				}
				return $rows;
			case 'contracts':
				return self::norm( self::contracts() );
		}
		return array();
	}

	/** مقدارهای غیرنردبانی را به رشته‌ی JSON تبدیل می‌کند */
	private static function norm( $items ) {
		$out = array();
		foreach ( (array) $items as $it ) {
			$row = array();
			foreach ( (array) $it as $k => $v ) {
				$row[ (string) $k ] = is_scalar( $v ) || null === $v ? ( is_bool( $v ) ? ( $v ? 'yes' : 'no' ) : $v ) : wp_json_encode( $v, JSON_UNESCAPED_UNICODE );
			}
			$out[] = $row;
		}
		return $out;
	}

	/** جلوگیری از Formula Injection در اکسل/شیت */
	public static function csv_cell( $v ) {
		$s = null === $v ? '' : (string) $v;
		if ( '' !== $s && in_array( $s[0], array( '=', '+', '-', '@', "\t", "\r" ), true ) && ! is_numeric( $s ) ) {
			$s = "'" . $s;
		}
		return '"' . str_replace( '"', '""', $s ) . '"';
	}

	public static function to_csv( $rows ) {
		$cols = array();
		foreach ( $rows as $r ) {
			foreach ( array_keys( $r ) as $k ) {
				if ( ! in_array( $k, $cols, true ) ) {
					$cols[] = $k;
				}
			}
		}
		$out = "\xEF\xBB\xBF"; // BOM برای اکسل
		if ( empty( $cols ) ) {
			return $out . "\"(empty)\"\r\n";
		}
		$out .= implode( ',', array_map( array( __CLASS__, 'csv_cell' ), $cols ) ) . "\r\n";
		foreach ( $rows as $r ) {
			$line = array();
			foreach ( $cols as $c ) {
				$line[] = self::csv_cell( isset( $r[ $c ] ) ? $r[ $c ] : '' );
			}
			$out .= implode( ',', $line ) . "\r\n";
		}
		return $out;
	}

	/* ───────────── دانلود ───────────── */

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	private static function file_base() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		return 'emzagar-' . sanitize_file_name( $host ? $host : 'site' ) . '-' . wp_date( 'Y-m-d-His' );
	}

	private static function remember( $format, $what ) {
		$u = wp_get_current_user();
		update_option( self::OPT_LAST, array( 'ts' => time(), 'format' => $format, 'what' => $what, 'by' => $u->user_login ), false );
	}

	public static function act_export() {
		self::guard( 'emzagar_export' );
		$format = isset( $_GET['format'] ) ? sanitize_key( wp_unslash( $_GET['format'] ) ) : 'json';
		$set    = isset( $_GET['set'] ) ? sanitize_key( wp_unslash( $_GET['set'] ) ) : '';
		$with_c = ! empty( $_GET['contracts'] );
		$base   = self::file_base();
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 120 ); // phpcs:ignore WordPress.PHP.NoSilencedErrors, Squiz.PHP.DiscouragedFunctions
		}

		if ( 'csv' === $format && isset( self::dataset_defs()[ $set ] ) ) {
			self::remember( 'csv', $set );
			nocache_headers();
			header( 'Content-Type: text/csv; charset=utf-8' );
			header( 'Content-Disposition: attachment; filename="' . $base . '-' . $set . '.csv"' );
			header( 'X-Content-Type-Options: nosniff' );
			echo self::to_csv( self::rows( $set ) ); // phpcs:ignore WordPress.Security.EscapeOutput
			exit;
		}

		if ( 'zip' === $format && class_exists( 'ZipArchive' ) ) {
			$tmp = wp_tempnam( $base . '.zip' );
			$zip = new ZipArchive();
			if ( $tmp && true === $zip->open( $tmp, ZipArchive::OVERWRITE ) ) {
				$zip->addFromString( $base . '/emzagar-export.json', wp_json_encode( self::bundle( $with_c ), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT ) );
				foreach ( array_keys( self::dataset_defs() ) as $s ) {
					if ( 'contracts' === $s && ! $with_c ) {
						continue;
					}
					$zip->addFromString( $base . '/csv/' . $s . '.csv', self::to_csv( self::rows( $s ) ) );
				}
				$zip->addFromString( $base . '/README.txt', "Emzagar data export\nPlugin: " . EMZ_VERSION . "\nSite: " . home_url() . "\nSecrets (API key) are never included.\nRestore: Emzagar > Settings > Data > Import (emzagar-export.json).\n" );
				$zip->close();
				self::remember( 'zip', 'all' );
				nocache_headers();
				header( 'Content-Type: application/zip' );
				header( 'Content-Disposition: attachment; filename="' . $base . '.zip"' );
				header( 'Content-Length: ' . filesize( $tmp ) );
				readfile( $tmp ); // phpcs:ignore WordPress.WP.AlternativeFunctions
				wp_delete_file( $tmp );
				exit;
			}
		}

		self::remember( 'json', 'all' );
		nocache_headers();
		header( 'Content-Type: application/json; charset=utf-8' );
		header( 'Content-Disposition: attachment; filename="' . $base . '.json"' );
		header( 'X-Content-Type-Options: nosniff' );
		echo wp_json_encode( self::bundle( $with_c ), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT ); // phpcs:ignore WordPress.Security.EscapeOutput
		exit;
	}

	/* ───────────── ورود / بازگردانی ───────────── */

	/** @return array<string,string> مجموعه‌های قابل بازگردانی */
	public static function restore_sets() {
		return array(
			'automations' => __( 'قوانین اتوماسیون', 'emzagar' ),
			'forms'       => __( 'اتصال فرم‌ها', 'emzagar' ),
			'modules'     => __( 'کلیدهای ماژول‌ها', 'emzagar' ),
			'limits'      => __( 'محدودیت نرخ', 'emzagar' ),
			'hub'         => __( 'تنظیمات مرکز فرماندهی', 'emzagar' ),
			'settings'    => __( 'تنظیمات عمومی و ووکامرس', 'emzagar' ),
		);
	}

	/**
	 * اعمال داده‌ی بازگردانی با پاک‌سازی کامل.
	 *
	 * @param array $data داده‌ی snapshot/export
	 * @param array $sets کدام مجموعه‌ها
	 * @return array<string,int|string> خلاصه
	 */
	public static function restore( $data, $sets ) {
		$done = array();
		$data = is_array( $data ) ? $data : array();
		foreach ( (array) $sets as $s ) {
			switch ( $s ) {
				case 'automations':
					if ( isset( $data['automations']['rules'] ) && is_array( $data['automations']['rules'] ) ) {
						$done['automations'] = Emzagar_Automations::import_rules( $data['automations']['rules'] );
					}
					break;
				case 'forms':
					if ( isset( $data['forms']['rules'] ) && is_array( $data['forms']['rules'] ) ) {
						$done['forms'] = Emzagar_Forms::import_rules( $data['forms']['rules'] );
					}
					break;
				case 'modules':
					if ( isset( $data['modules'] ) && is_array( $data['modules'] ) ) {
						$on = array();
						foreach ( array_keys( Emzagar_Modules::registry() ) as $id ) {
							if ( ! isset( $data['modules'][ $id ] ) || 'no' !== $data['modules'][ $id ] ) {
								$on[] = $id;
							}
						}
						Emzagar_Modules::apply( $on );
						$done['modules'] = count( $on );
					}
					break;
				case 'limits':
					if ( isset( $data['limits'] ) && is_array( $data['limits'] ) ) {
						update_option( Emzagar_Limits::OPT, Emzagar_Limits::sanitize( $data['limits'] ), false );
						$done['limits'] = 1;
					}
					break;
				case 'hub':
					if ( isset( $data['hub'] ) && is_array( $data['hub'] ) ) {
						$h = $data['hub'];
						unset( $h['grant_role'] ); // نقش‌ها به سایت مقصد وابسته‌اند
						update_option( Emzagar_Hub::OPT, Emzagar_Hub::sanitize( array_merge( Emzagar_Hub::opts(), $h ) ) );
						$done['hub'] = 1;
					}
					break;
				case 'settings':
					if ( isset( $data['settings'] ) && is_array( $data['settings'] ) ) {
						$allowed = array( 'wc_enabled', 'wc_trigger', 'wc_all_orders', 'wc_expiry_days', 'sync_orders', 'sync_customers', 'wc_hold_until_signed', 'wc_on_signed', 'wc_on_reject', 'wc_gate_downloads', 'cache_minutes', 'accent' );
						$subset  = array();
						foreach ( $allowed as $k ) {
							if ( isset( $data['settings'][ $k ] ) ) {
								$subset[ $k ] = $data['settings'][ $k ];
							}
						}
						update_option( EMZ_OPTION, Emzagar_Settings::sanitize( $subset ) );
						$done['settings'] = count( $subset );
					}
					break;
			}
		}
		Emzagar_Hub::invalidate();
		return $done;
	}

	public static function take_snapshot( $reason = '' ) {
		update_option(
			self::OPT_SNAP,
			array(
				'ts'      => time(),
				'version' => EMZ_VERSION,
				'reason'  => (string) $reason,
				'data'    => self::snapshot(),
			),
			false
		);
	}

	public static function last_snapshot() {
		$s = get_option( self::OPT_SNAP, array() );
		return ( is_array( $s ) && ! empty( $s['data'] ) ) ? $s : null;
	}

	private static function back( $code, $extra = array() ) {
		wp_safe_redirect( add_query_arg( array_merge( array( 'emz_d' => $code ), $extra ), Emzagar_Settings::tab_url( 'data' ) ) );
		exit;
	}

	public static function act_import() {
		self::guard( 'emzagar_import' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- در guard بررسی شده
		if ( empty( $_FILES['file']['tmp_name'] ) || ! is_uploaded_file( $_FILES['file']['tmp_name'] ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
			self::back( 'nofile' );
		}
		if ( (int) $_FILES['file']['size'] > 10 * MB_IN_BYTES ) {
			self::back( 'big' );
		}
		$raw  = file_get_contents( $_FILES['file']['tmp_name'] ); // phpcs:ignore WordPress.WP.AlternativeFunctions, WordPress.Security.ValidatedSanitizedInput
		$json = json_decode( (string) $raw, true );
		if ( ! is_array( $json ) || ! isset( $json['format'], $json['data'] ) || 'emzagar-export' !== $json['format'] || ! is_array( $json['data'] ) ) {
			self::back( 'bad' );
		}
		if ( isset( $json['schema'] ) && (int) $json['schema'] > self::SCHEMA ) {
			self::back( 'newer' );
		}
		$allowed = array_keys( self::restore_sets() );
		$sets    = isset( $_POST['sets'] ) && is_array( $_POST['sets'] ) ? array_values( array_intersect( array_map( 'sanitize_key', wp_unslash( $_POST['sets'] ) ), $allowed ) ) : array();
		// phpcs:enable
		if ( empty( $sets ) ) {
			self::back( 'nosets' );
		}
		self::take_snapshot( 'before-import' );
		$done = self::restore( $json['data'], $sets );
		self::back( 'imported', array( 'n' => count( $done ) ) );
	}

	public static function act_restore_snapshot() {
		self::guard( 'emzagar_restore_snapshot' );
		$s = self::last_snapshot();
		if ( ! $s ) {
			self::back( 'nosnap' );
		}
		self::restore( $s['data'], array_keys( self::restore_sets() ) );
		self::back( 'restored' );
	}

	/* ───────────── نمایش ───────────── */

	public static function render_tab() {
		$code = isset( $_GET['emz_d'] ) ? sanitize_key( wp_unslash( $_GET['emz_d'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		$msgs = array(
			'imported' => array( 'success', __( 'داده‌ها با موفقیت بازگردانی شد. (پشتیبان وضعیت قبلی هم نگه داشته شد.)', 'emzagar' ) ),
			'restored' => array( 'success', __( 'وضعیت آخرین پشتیبان بازگردانی شد.', 'emzagar' ) ),
			'nofile'   => array( 'error', __( 'فایلی انتخاب نشد.', 'emzagar' ) ),
			'big'      => array( 'error', __( 'حجم فایل بیش از ۱۰ مگابایت است.', 'emzagar' ) ),
			'bad'      => array( 'error', __( 'فایل معتبر نیست؛ باید خروجی خود امضاگیر (JSON) باشد.', 'emzagar' ) ),
			'newer'    => array( 'error', __( 'این فایل از نسخه‌ی جدیدتر افزونه است؛ ابتدا افزونه را به‌روز کنید.', 'emzagar' ) ),
			'nosets'   => array( 'error', __( 'حداقل یک بخش را برای بازگردانی انتخاب کنید.', 'emzagar' ) ),
			'nosnap'   => array( 'error', __( 'پشتیبانی برای بازگردانی وجود ندارد.', 'emzagar' ) ),
		);
		if ( isset( $msgs[ $code ] ) ) {
			printf( '<div class="notice notice-%s is-dismissible"><p>%s</p></div>', esc_attr( $msgs[ $code ][0] ), esc_html( $msgs[ $code ][1] ) );
		}
		$last = get_option( self::OPT_LAST, array() );
		$snap = self::last_snapshot();
		$link = function ( $args ) {
			return wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_export&' . $args ), 'emzagar_export' );
		};
		?>
		<section class="emz-card emz-export">
			<h2>📦 <?php esc_html_e( 'خروجی کامل داده‌ها', 'emzagar' ); ?></h2>
			<p class="description"><?php esc_html_e( 'داده‌های شما متعلق به خودتان است. هر زمان بخواهید همه‌چیز را بردارید و بروید — یا پشتیبان بگیرید. کلید API و اسرار هرگز در فایل نیست.', 'emzagar' ); ?></p>
			<form method="get" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" class="emz-export-form">
				<input type="hidden" name="action" value="emzagar_export">
				<input type="hidden" name="_wpnonce" value="<?php echo esc_attr( wp_create_nonce( 'emzagar_export' ) ); ?>">
				<p><label><input type="checkbox" name="contracts" value="1" checked> <?php esc_html_e( 'فهرست قراردادها از ابر هم گنجانده شود (تا ۱۰۰۰ قرارداد اخیر)', 'emzagar' ); ?></label></p>
				<p class="emz-actions">
					<button class="button button-primary button-hero" name="format" value="json">⬇ <?php esc_html_e( 'JSON کامل', 'emzagar' ); ?></button>
					<?php if ( class_exists( 'ZipArchive' ) ) : ?>
						<button class="button button-hero" name="format" value="zip">⬇ <?php esc_html_e( 'بسته‌ی ZIP (JSON + همه‌ی CSVها)', 'emzagar' ); ?></button>
					<?php endif; ?>
				</p>
			</form>
			<h3><?php esc_html_e( 'خروجی CSV هر بخش', 'emzagar' ); ?></h3>
			<p class="emz-chips">
				<?php foreach ( self::dataset_defs() as $k => $label ) : ?>
					<a class="button" href="<?php echo esc_url( $link( 'format=csv&set=' . $k ) ); ?>">CSV · <?php echo esc_html( $label ); ?></a>
				<?php endforeach; ?>
			</p>
			<?php if ( ! empty( $last['ts'] ) ) : ?>
				<p class="description"><?php echo esc_html( sprintf( /* translators: 1: time 2: user */ __( 'آخرین خروجی: %1$s پیش توسط %2$s', 'emzagar' ), human_time_diff( (int) $last['ts'] ), (string) $last['by'] ) ); ?></p>
			<?php endif; ?>
		</section>

		<section class="emz-card">
			<h2>♻️ <?php esc_html_e( 'ورود و بازگردانی', 'emzagar' ); ?></h2>
			<p class="description"><?php esc_html_e( 'فایل JSON خروجی را (روی همین سایت یا سایت دیگر) وارد کنید. پیش از اعمال، از وضعیت فعلی پشتیبان گرفته می‌شود.', 'emzagar' ); ?></p>
			<form method="post" enctype="multipart/form-data" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="emzagar_import">
				<?php wp_nonce_field( 'emzagar_import' ); ?>
				<p><input type="file" name="file" accept="application/json,.json" required></p>
				<p class="emz-chips">
					<?php foreach ( self::restore_sets() as $k => $label ) : ?>
						<label class="emz-chip"><input type="checkbox" name="sets[]" value="<?php echo esc_attr( $k ); ?>" <?php checked( in_array( $k, array( 'automations', 'forms' ), true ) ); ?>> <?php echo esc_html( $label ); ?></label>
					<?php endforeach; ?>
				</p>
				<?php submit_button( __( 'بازگردانی از فایل', 'emzagar' ), 'secondary' ); ?>
			</form>
			<hr>
			<h3><?php esc_html_e( 'پشتیبان خودکار', 'emzagar' ); ?></h3>
			<?php if ( $snap ) : ?>
				<p><?php echo esc_html( sprintf( /* translators: 1: time 2: version 3: reason */ __( 'آخرین پشتیبان: %1$s پیش (نسخه‌ی %2$s، %3$s)', 'emzagar' ), human_time_diff( (int) $snap['ts'] ), $snap['version'], 'before-update' === $snap['reason'] ? __( 'پیش از به‌روزرسانی', 'emzagar' ) : ( 'before-import' === $snap['reason'] ? __( 'پیش از ورود داده', 'emzagar' ) : (string) $snap['reason'] ) ) ); ?></p>
				<p><a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_restore_snapshot' ), 'emzagar_restore_snapshot' ) ); ?>" onclick="return confirm('<?php echo esc_js( __( 'تنظیمات فعلی با پشتیبان جایگزین شود؟', 'emzagar' ) ); ?>')"><?php esc_html_e( 'بازگردانی آخرین پشتیبان', 'emzagar' ); ?></a></p>
			<?php else : ?>
				<p class="description"><?php esc_html_e( 'پیش از هر به‌روزرسانی افزونه و هر ورود داده، خودکار ساخته می‌شود.', 'emzagar' ); ?></p>
			<?php endif; ?>
		</section>
		<?php
	}
}
