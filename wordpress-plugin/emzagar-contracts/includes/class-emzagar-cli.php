<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * دستورهای WP-CLI برای اتوماسیون سرور و اسکریپت‌نویسی:
 *
 *   wp emzagar status
 *   wp emzagar contracts --status=sent --limit=20 --format=table
 *   wp emzagar remind 123
 *   wp emzagar issue 5 ali@example.com --name="علی رضایی" --mobile=09121234567
 *   wp emzagar pulse
 *   wp emzagar automations
 *   wp emzagar health [--live] [--format=table|json]
 *   wp emzagar export [--file=out.json] [--contracts]
 *   wp emzagar modules list|enable <id>|disable <id>|safe
 *   wp emzagar lockdown on|off|status
 *   wp emzagar update [--check]
 */
class Emzagar_CLI {

	private static function need() {
		if ( ! Emzagar_API::is_configured() ) {
			WP_CLI::error( 'امضاگیر هنوز متصل نیست. (wp emzagar status)' );
		}
	}

	/**
	 * وضعیت اتصال و میزان ادغام.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function status( $args, $assoc_args ) {
		unset( $args, $assoc_args );
		$o = emzagar_options();
		WP_CLI::line( 'اتصال: ' . ( Emzagar_API::is_configured() ? 'برقرار' : 'برقرار نیست' ) );
		WP_CLI::line( 'آدرس: ' . ( '' !== $o['base_url'] ? $o['base_url'] : '—' ) );
		WP_CLI::line( 'فضای کاری: ' . ( '' !== $o['workspace'] ? $o['workspace'] : '—' ) );
		WP_CLI::line( 'قانون اتوماسیون فعال: ' . Emzagar_Automations::active_count() );
		WP_CLI::line( 'فرم متصل: ' . Emzagar_Forms::active_count() );
		WP_CLI::line( 'کنش‌های انجام‌شده از وردپرس: ' . (int) get_option( 'emzagar_actions', 0 ) );
	}

	/**
	 * فهرست قراردادها.
	 *
	 * ## OPTIONS
	 *
	 * [--status=<status>]
	 * : sent | signed | rejected | expired | cancelled
	 *
	 * [--q=<text>]
	 * : جستجو در عنوان، شماره، نام و ایمیل
	 *
	 * [--limit=<n>]
	 * : حداکثر ۵۰ (پیش‌فرض ۲۰)
	 *
	 * [--format=<format>]
	 * : table | json | csv | ids
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function contracts( $args, $assoc_args ) {
		unset( $args );
		self::need();
		$q = array( 'limit' => isset( $assoc_args['limit'] ) ? max( 1, min( 50, (int) $assoc_args['limit'] ) ) : 20 );
		if ( ! empty( $assoc_args['status'] ) ) {
			$q['status'] = sanitize_key( $assoc_args['status'] );
		}
		if ( ! empty( $assoc_args['q'] ) ) {
			$q['q'] = sanitize_text_field( $assoc_args['q'] );
		}
		$res = Emzagar_API::request( 'GET', '/api/v1/contracts', $q );
		if ( is_wp_error( $res ) ) {
			WP_CLI::error( $res->get_error_message() );
		}
		$rows = array();
		foreach ( (array) $res['items'] as $c ) {
			$rows[] = array(
				'id'       => $c['id'],
				'number'   => $c['number'],
				'title'    => $c['title'],
				'status'   => $c['status'],
				'customer' => isset( $c['customer']['email'] ) ? $c['customer']['email'] : '',
				'issued'   => $c['issuedAt'],
			);
		}
		$format = isset( $assoc_args['format'] ) ? $assoc_args['format'] : 'table';
		\WP_CLI\Utils\format_items( $format, $rows, array( 'id', 'number', 'title', 'status', 'customer', 'issued' ) );
	}

	/**
	 * ارسال یادآوری امضا.
	 *
	 * ## OPTIONS
	 *
	 * <id>
	 * : شناسه‌ی قرارداد
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function remind( $args, $assoc_args ) {
		unset( $assoc_args );
		self::need();
		$res = Emzagar_API::request( 'POST', '/api/v1/contracts/' . absint( $args[0] ) . '/remind' );
		if ( is_wp_error( $res ) ) {
			WP_CLI::error( $res->get_error_message() );
		}
		Emzagar_Workspace::bump();
		WP_CLI::success( 'یادآوری ارسال شد.' );
	}

	/**
	 * صدور قرارداد.
	 *
	 * ## OPTIONS
	 *
	 * <template>
	 * : شناسه‌ی قالب
	 *
	 * <email>
	 * : ایمیل مشتری
	 *
	 * [--name=<name>]
	 * [--mobile=<mobile>]
	 * [--title=<title>]
	 * [--expiry=<days>]
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function issue( $args, $assoc_args ) {
		self::need();
		$mobile = isset( $assoc_args['mobile'] ) ? Emzagar_API::normalize_mobile( $assoc_args['mobile'] ) : '';
		$res    = Emzagar_API::issue_contract(
			absint( $args[0] ),
			isset( $assoc_args['name'] ) ? sanitize_text_field( $assoc_args['name'] ) : '',
			sanitize_email( $args[1] ),
			$mobile,
			isset( $assoc_args['title'] ) ? sanitize_text_field( $assoc_args['title'] ) : '',
			isset( $assoc_args['expiry'] ) ? absint( $assoc_args['expiry'] ) : null
		);
		if ( is_wp_error( $res ) ) {
			WP_CLI::error( $res->get_error_message() );
		}
		Emzagar_Workspace::bump();
		WP_CLI::success( 'قرارداد صادر شد (شناسه ' . ( isset( $res['id'] ) ? $res['id'] : '?' ) . ').' . ( ! empty( $res['signUrl'] ) ? ' لینک امضا: ' . $res['signUrl'] : '' ) );
	}

	/**
	 * نبض کسب‌وکار (شاخص‌های کلیدی).
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function pulse( $args, $assoc_args ) {
		unset( $args, $assoc_args );
		self::need();
		$p = Emzagar_Hub::pulse( 0 );
		if ( is_wp_error( $p ) ) {
			WP_CLI::error( $p->get_error_message() );
		}
		foreach ( (array) $p['kpi'] as $k => $v ) {
			WP_CLI::line( $k . ': ' . ( is_scalar( $v ) ? $v : wp_json_encode( $v ) ) );
		}
		WP_CLI::line( 'عمق یکپارچگی: ' . $p['depth']['score'] . '٪ (' . $p['depth']['level'] . ')' );
	}

	/**
	 * فهرست قوانین اتوماسیون.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function automations( $args, $assoc_args ) {
		unset( $args, $assoc_args );
		$rows = array();
		foreach ( Emzagar_Automations::rules() as $r ) {
			$rows[] = array(
				'id'      => $r['id'],
				'name'    => $r['name'],
				'on'      => ! empty( $r['on'] ) ? 'yes' : 'no',
				'trigger' => $r['trigger'],
				'action'  => $r['action'],
			);
		}
		\WP_CLI\Utils\format_items( 'table', $rows, array( 'id', 'name', 'on', 'trigger', 'action' ) );
	}

	/**
	 * وضعیت سیستم (همان چراغ‌های صفحه‌ی «وضعیت سیستم»). کد خروج ۱ = مشکل جدی.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function health( $args, $assoc_args ) {
		unset( $args );
		$r = Emzagar_Health::report( isset( $assoc_args['live'] ) );
		if ( isset( $assoc_args['format'] ) && 'json' === $assoc_args['format'] ) {
			WP_CLI::line( wp_json_encode( $r, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT ) );
		} else {
			$rows = array();
			foreach ( $r['checks'] as $c ) {
				$rows[] = array( 'status' => $c['status'], 'check' => $c['label'], 'detail' => $c['detail'] );
			}
			\WP_CLI\Utils\format_items( 'table', $rows, array( 'status', 'check', 'detail' ) );
		}
		if ( 'bad' === $r['overall'] ) {
			WP_CLI::halt( 1 );
		}
		WP_CLI::success( 'ok' === $r['overall'] ? 'همه‌چیز سالم است.' : 'هشدار دارد، اما مشکل جدی نیست.' );
	}

	/**
	 * خروجی کامل داده‌ها (JSON).
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function export( $args, $assoc_args ) {
		unset( $args );
		$json = wp_json_encode( Emzagar_Export::bundle( isset( $assoc_args['contracts'] ) ), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT );
		if ( ! empty( $assoc_args['file'] ) ) {
			file_put_contents( $assoc_args['file'], $json ); // phpcs:ignore WordPress.WP.AlternativeFunctions
			WP_CLI::success( 'ذخیره شد: ' . $assoc_args['file'] );
			return;
		}
		WP_CLI::line( $json );
	}

	/**
	 * کلید ماژول‌ها: list | enable <id> | disable <id> | safe.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function modules( $args, $assoc_args ) {
		unset( $assoc_args );
		$op  = isset( $args[0] ) ? $args[0] : 'list';
		$reg = Emzagar_Modules::registry();
		if ( 'list' === $op ) {
			$rows = array();
			foreach ( $reg as $id => $m ) {
				$rows[] = array( 'id' => $id, 'state' => Emzagar_Modules::state( $id ), 'label' => $m['label'] );
			}
			\WP_CLI\Utils\format_items( 'table', $rows, array( 'id', 'state', 'label' ) );
			return;
		}
		if ( 'safe' === $op ) {
			Emzagar_Modules::apply( array() );
			WP_CLI::success( 'حالت امن: همه‌ی ماژول‌های اختیاری خاموش شد.' );
			return;
		}
		$id = isset( $args[1] ) ? sanitize_key( $args[1] ) : '';
		if ( ! in_array( $op, array( 'enable', 'disable' ), true ) || ! isset( $reg[ $id ] ) ) {
			WP_CLI::error( 'استفاده: wp emzagar modules list|enable <id>|disable <id>|safe' );
		}
		$on = array();
		foreach ( array_keys( $reg ) as $k ) {
			if ( Emzagar_Modules::on( $k ) && $k !== $id ) {
				$on[] = $k;
			}
		}
		if ( 'enable' === $op ) {
			$on[] = $id;
		}
		Emzagar_Modules::apply( $on );
		WP_CLI::success( $id . ( 'enable' === $op ? ' روشن شد.' : ' خاموش شد.' ) );
	}

	/**
	 * قفل اضطراری صدور از فرم‌ها: on | off | status.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function lockdown( $args, $assoc_args ) {
		unset( $assoc_args );
		$op = isset( $args[0] ) ? $args[0] : 'status';
		if ( 'on' === $op ) {
			Emzagar_Limits::lock( 'manual', 'WP-CLI', 0, 'cli' );
		} elseif ( 'off' === $op ) {
			Emzagar_Limits::unlock();
		}
		$st = Emzagar_Limits::stats();
		WP_CLI::line( 'قفل اضطراری: ' . ( $st['locked'] ? 'فعال (' . $st['lockMode'] . ')' : 'خاموش' ) );
		WP_CLI::line( 'صدور امروز از فرم‌ها: ' . $st['issuedToday'] . ' / ' . ( $st['dailyCap'] ? $st['dailyCap'] : '∞' ) . ' · مسدودشده: ' . $st['blockedToday'] );
	}

	/**
	 * بررسی (و نمایش) به‌روزرسانی از ابر.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function update( $args, $assoc_args ) {
		unset( $args, $assoc_args );
		self::need();
		$info = Emzagar_Updater::info( true );
		if ( ! empty( $info['error'] ) ) {
			WP_CLI::error( $info['error'] );
		}
		$new = Emzagar_Updater::available( $info );
		WP_CLI::line( 'نصب‌شده: ' . EMZ_VERSION . ' · ابر: ' . ( $info['version'] ? $info['version'] : '—' ) );
		WP_CLI::line( 'لایسنس: ' . Emzagar_Updater::license_label( (array) $info['license'] ) );
		WP_CLI::success( $new ? 'نسخه‌ی جدید آماده است: wp plugin update emzagar-contracts' : 'به‌روز است.' );
	}
}

WP_CLI::add_command( 'emzagar', 'Emzagar_CLI' );
