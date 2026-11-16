<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * اتصال فرم‌های سایت به صدور خودکار قرارداد:
 * با ارسال فرم (تماس، ثبت‌نام، درخواست خدمات) نام، ایمیل و موبایل مشتری از خود فرم خوانده می‌شود
 * و قرارداد انتخاب‌شده برای او صادر می‌شود — بدون هیچ کدنویسی.
 *
 * فرم‌سازهای پشتیبانی‌شده: Contact Form 7، WPForms، Gravity Forms، Elementor Pro Forms، Fluent Forms.
 */
class Emzagar_Forms {

	const OPT = 'emzagar_form_rules';
	const MAX = 30;

	public static function init() {
		Emzagar_Automations::init_ui(); // صفحه‌ی میزبان تب «فرم‌ها»
		add_action( 'wpcf7_mail_sent', array( __CLASS__, 'on_cf7' ), 10, 1 );
		add_action( 'wpforms_process_complete', array( __CLASS__, 'on_wpforms' ), 10, 4 );
		add_action( 'gform_after_submission', array( __CLASS__, 'on_gravity' ), 10, 2 );
		add_action( 'elementor_pro/forms/new_record', array( __CLASS__, 'on_elementor' ), 10, 2 );
		add_action( 'fluentform/submission_inserted', array( __CLASS__, 'on_fluent' ), 20, 3 );
		add_action( 'fluentform_submission_inserted', array( __CLASS__, 'on_fluent' ), 20, 3 );
		if ( is_admin() ) {
			add_action( 'admin_post_emzagar_form_save', array( __CLASS__, 'act_save' ) );
			add_action( 'admin_post_emzagar_form_delete', array( __CLASS__, 'act_delete' ) );
		}
	}

	public static function providers() {
		return array(
			'cf7'       => 'Contact Form 7',
			'wpforms'   => 'WPForms',
			'gravity'   => 'Gravity Forms',
			'elementor' => 'Elementor Pro Forms',
			'fluent'    => 'Fluent Forms',
		);
	}

	public static function installed( $p ) {
		switch ( $p ) {
			case 'cf7':
				return class_exists( 'WPCF7_ContactForm' );
			case 'wpforms':
				return function_exists( 'wpforms' );
			case 'gravity':
				return class_exists( 'GFForms' );
			case 'elementor':
				return defined( 'ELEMENTOR_PRO_VERSION' );
			case 'fluent':
				return defined( 'FLUENTFORM' );
		}
		return false;
	}

	public static function rules() {
		$r = get_option( self::OPT, array() );
		return is_array( $r ) ? $r : array();
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

	/* ───────────── دریافت از فرم‌سازها ───────────── */

	private static function flat( $v ) {
		if ( is_array( $v ) ) {
			$parts = array();
			foreach ( $v as $x ) {
				$s = self::flat( $x );
				if ( '' !== $s ) {
					$parts[] = $s;
				}
			}
			return implode( ' ', $parts );
		}
		return is_scalar( $v ) ? trim( (string) $v ) : '';
	}

	private static function pair( $key, $label, $value, $type = '' ) {
		return array(
			'key'   => (string) $key,
			'label' => (string) $label,
			'value' => self::flat( $value ),
			'type'  => (string) $type,
		);
	}

	public static function on_cf7( $form ) {
		if ( ! class_exists( 'WPCF7_Submission' ) || ! is_object( $form ) ) {
			return;
		}
		$sub = WPCF7_Submission::get_instance();
		if ( ! $sub ) {
			return;
		}
		$pairs = array();
		foreach ( (array) $sub->get_posted_data() as $k => $v ) {
			if ( 0 === strpos( (string) $k, '_wpcf7' ) ) {
				continue;
			}
			$pairs[] = self::pair( $k, $k, $v );
		}
		self::handle( 'cf7', array( (string) $form->id(), (string) $form->title() ), (string) $form->title(), $pairs );
	}

	public static function on_wpforms( $fields, $entry, $form_data, $entry_id = 0 ) {
		unset( $entry, $entry_id );
		$pairs = array();
		foreach ( (array) $fields as $f ) {
			if ( is_array( $f ) ) {
				$pairs[] = self::pair( isset( $f['id'] ) ? $f['id'] : '', isset( $f['name'] ) ? $f['name'] : '', isset( $f['value'] ) ? $f['value'] : '', isset( $f['type'] ) ? $f['type'] : '' );
			}
		}
		$title = isset( $form_data['settings']['form_title'] ) ? (string) $form_data['settings']['form_title'] : '';
		self::handle( 'wpforms', array( isset( $form_data['id'] ) ? (string) $form_data['id'] : '', $title ), $title, $pairs );
	}

	public static function on_gravity( $entry, $form ) {
		$pairs = array();
		foreach ( (array) ( isset( $form['fields'] ) ? $form['fields'] : array() ) as $field ) {
			$obj    = is_object( $field );
			$id     = $obj ? $field->id : ( isset( $field['id'] ) ? $field['id'] : '' );
			$label  = $obj ? $field->label : ( isset( $field['label'] ) ? $field['label'] : '' );
			$type   = $obj ? $field->type : ( isset( $field['type'] ) ? $field['type'] : '' );
			$inputs = $obj ? $field->inputs : ( isset( $field['inputs'] ) ? $field['inputs'] : null );
			if ( is_array( $inputs ) ) {
				$vals = array();
				foreach ( $inputs as $in ) {
					if ( isset( $in['id'] ) && isset( $entry[ (string) $in['id'] ] ) ) {
						$vals[] = $entry[ (string) $in['id'] ];
					}
				}
				$val = $vals;
			} else {
				$val = isset( $entry[ (string) $id ] ) ? $entry[ (string) $id ] : '';
			}
			$pairs[] = self::pair( $id, $label, $val, $type );
		}
		$title = isset( $form['title'] ) ? (string) $form['title'] : '';
		self::handle( 'gravity', array( isset( $form['id'] ) ? (string) $form['id'] : '', $title ), $title, $pairs );
	}

	public static function on_elementor( $record, $handler = null ) {
		unset( $handler );
		if ( ! is_object( $record ) || ! method_exists( $record, 'get' ) ) {
			return;
		}
		$pairs = array();
		foreach ( (array) $record->get( 'fields' ) as $id => $f ) {
			$pairs[] = self::pair( $id, isset( $f['title'] ) ? $f['title'] : '', isset( $f['value'] ) ? $f['value'] : '', isset( $f['type'] ) ? $f['type'] : '' );
		}
		$settings = (array) $record->get( 'form_settings' );
		$name     = isset( $settings['form_name'] ) ? (string) $settings['form_name'] : '';
		self::handle( 'elementor', array( isset( $settings['id'] ) ? (string) $settings['id'] : '', $name ), $name, $pairs );
	}

	public static function on_fluent( $insert_id, $form_data = array(), $form = null ) {
		unset( $insert_id );
		$pairs = array();
		foreach ( (array) $form_data as $k => $v ) {
			if ( 0 === strpos( (string) $k, '_' ) ) {
				continue;
			}
			$pairs[] = self::pair( $k, $k, $v );
		}
		$id    = is_object( $form ) && isset( $form->id ) ? (string) $form->id : '';
		$title = is_object( $form ) && isset( $form->title ) ? (string) $form->title : '';
		self::handle( 'fluent', array( $id, $title ), $title, $pairs );
	}

	/* ───────────── تشخیص فیلدها ───────────── */

	private static function find_override( $pairs, $name ) {
		if ( '' === $name ) {
			return null;
		}
		foreach ( $pairs as $p ) {
			if ( $p['key'] === $name || $p['label'] === $name ) {
				return $p['value'];
			}
		}
		return null;
	}

	private static function match( $p, $regex ) {
		return (bool) preg_match( $regex, $p['key'] . ' ' . $p['label'] );
	}

	public static function detect( $pairs, $over = array() ) {
		$email  = self::find_override( $pairs, isset( $over['email'] ) ? $over['email'] : '' );
		$mobile = self::find_override( $pairs, isset( $over['mobile'] ) ? $over['mobile'] : '' );
		$name   = self::find_override( $pairs, isset( $over['name'] ) ? $over['name'] : '' );

		if ( null === $email ) {
			foreach ( $pairs as $p ) {
				if ( ( 'email' === $p['type'] || self::match( $p, '/e-?mail|ایمیل|پست\s*الکترونیک/iu' ) ) && is_email( $p['value'] ) ) {
					$email = $p['value'];
					break;
				}
			}
		}
		if ( null === $email ) {
			foreach ( $pairs as $p ) {
				if ( is_email( $p['value'] ) ) {
					$email = $p['value'];
					break;
				}
			}
		}
		if ( null === $mobile ) {
			foreach ( $pairs as $p ) {
				if ( ( 'phone' === $p['type'] || 'tel' === $p['type'] || self::match( $p, '/mobile|phone|\btel\b|cell|موبایل|همراه|تلفن|شماره/iu' ) ) && '' !== Emzagar_API::normalize_mobile( $p['value'] ) ) {
					$mobile = $p['value'];
					break;
				}
			}
		}
		if ( null === $name ) {
			$first = '';
			$last  = '';
			$full  = '';
			foreach ( $pairs as $p ) {
				if ( '' === $p['value'] || is_email( $p['value'] ) || self::match( $p, '/company|شرکت|user|کاربری|file|فایل|subject|موضوع|message|پیام/iu' ) ) {
					continue;
				}
				if ( '' === $last && self::match( $p, '/last|family|surname|خانوادگی/iu' ) ) {
					$last = $p['value'];
				} elseif ( '' === $first && self::match( $p, '/first|given|^\s*نام\s*$|نام\s*\(|\bنام\b(?!\s*خانوادگی)/iu' ) && ! self::match( $p, '/last|family|surname|خانوادگی/iu' ) ) {
					$first = $p['value'];
				} elseif ( '' === $full && self::match( $p, '/full|your[-_ ]?name|\bname\b|نام/iu' ) ) {
					$full = $p['value'];
				}
			}
			$name = '' !== $first || '' !== $last ? trim( $first . ' ' . $last ) : $full;
		}
		return array(
			'name'   => sanitize_text_field( (string) $name ),
			'email'  => sanitize_email( (string) $email ),
			'mobile' => Emzagar_API::normalize_mobile( (string) $mobile ),
		);
	}

	/* ───────────── صدور ───────────── */

	private static function handle( $provider, $ids, $title, $pairs ) {
		$ids = array_filter( array_map( 'strval', (array) $ids ), 'strlen' );
		foreach ( self::rules() as $r ) {
			if ( empty( $r['on'] ) || $r['provider'] !== $provider ) {
				continue;
			}
			if ( '' !== $r['form'] && ! in_array( $r['form'], $ids, true ) ) {
				continue;
			}
			$label = self::providers()[ $provider ] . ( '' !== $title ? ' — ' . $title : '' );
			try {
				$res = self::issue( $r, $pairs, $title );
			} catch ( \Throwable $e ) { // phpcs:ignore PHPCompatibility.Keywords.NewKeywords.t_throwableFound
				$res = array( 'ok' => false, 'msg' => $e->getMessage(), 'ref' => '' );
			}
			Emzagar_Automations::record( $label, 'form', $res['ref'], $res['ok'], $res['msg'] );
		}
	}

	/** @return array{ok:bool,msg:string,ref:string} */
	private static function issue( $r, $pairs, $title ) {
		if ( ! Emzagar_API::is_configured() ) {
			return array( 'ok' => false, 'msg' => __( 'امضاگیر متصل نیست.', 'emzagar' ), 'ref' => '' );
		}
		$d = self::detect(
			$pairs,
			array(
				'name'   => isset( $r['f_name'] ) ? $r['f_name'] : '',
				'email'  => isset( $r['f_email'] ) ? $r['f_email'] : '',
				'mobile' => isset( $r['f_mobile'] ) ? $r['f_mobile'] : '',
			)
		);
		if ( ! is_email( $d['email'] ) ) {
			return array( 'ok' => false, 'msg' => __( 'ایمیل در فرم پیدا نشد؛ نام فیلد ایمیل را در تنظیمات اتصال بنویسید.', 'emzagar' ), 'ref' => '' );
		}
		$dup = 'emz_form_' . md5( $d['email'] . '|' . (int) $r['tpl'] );
		if ( get_transient( $dup ) ) {
			return array( 'ok' => true, 'msg' => __( 'ارسال تکراری (کمتر از ۱۰ دقیقه) نادیده گرفته شد.', 'emzagar' ), 'ref' => $d['email'] );
		}
		// محدودیت نرخ + قفل اضطراری (سقف روزانه، هر IP، هر ایمیل، تشخیص موج اسپم)
		$gate = Emzagar_Limits::check( 'form', $d['email'] );
		if ( ! $gate['ok'] ) {
			return array( 'ok' => false, 'msg' => $gate['msg'], 'ref' => $d['email'] );
		}
		$expiry = ! empty( $r['expiry'] ) ? (int) $r['expiry'] : null;
		$res    = Emzagar_API::issue_contract( (int) $r['tpl'], $d['name'], $d['email'], $d['mobile'], '', $expiry );
		if ( is_wp_error( $res ) ) {
			Emzagar_Limits::release( $gate ); // صدور انجام نشد؛ سهمیه برمی‌گردد
			return array( 'ok' => false, 'msg' => $res->get_error_message(), 'ref' => $d['email'] );
		}
		set_transient( $dup, 1, 10 * MINUTE_IN_SECONDS );
		Emzagar_Hub::invalidate();
		$cid = isset( $res['id'] ) ? (int) $res['id'] : 0;
		Emzagar_Inbox::add( 'issued', __( 'قرارداد از فرم سایت صادر شد', 'emzagar' ), ( '' !== $d['name'] ? $d['name'] : $d['email'] ) . ( '' !== $title ? ' — ' . $title : '' ), $cid );
		/**
		 * پس از صدور خودکار قرارداد از فرم.
		 *
		 * @param array $res  پاسخ API (id, signUrl, ...)
		 * @param array $rule قانون اتصال فرم
		 * @param array $data name/email/mobile تشخیص‌داده‌شده
		 */
		do_action( 'emzagar_form_contract_issued', $res, $r, $d );
		return array( 'ok' => true, 'msg' => __( 'قرارداد صادر و برای مشتری ارسال شد.', 'emzagar' ), 'ref' => $d['email'] );
	}

	/* ───────────── مدیریت ───────────── */

	private static function guard( $nonce ) {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'دسترسی ندارید.', 'emzagar' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( $nonce );
	}

	private static function back( $code ) {
		wp_safe_redirect( add_query_arg( 'emz_a', $code, Emzagar_Automations::url( array( 'tab' => 'forms' ) ) ) );
		exit;
	}

	/**
	 * ورود اتصال‌های فرم از فایل پشتیبان (با پاک‌سازی کامل).
	 *
	 * @param array $items فهرست اتصال‌ها
	 * @return int تعداد واردشده
	 */
	public static function import_rules( $items ) {
		$out = array();
		foreach ( (array) $items as $it ) {
			if ( ! is_array( $it ) || count( $out ) >= self::MAX ) {
				continue;
			}
			$provider = isset( $it['provider'] ) ? sanitize_key( $it['provider'] ) : '';
			$tpl      = isset( $it['tpl'] ) ? absint( $it['tpl'] ) : 0;
			if ( ! isset( self::providers()[ $provider ] ) || ! $tpl ) {
				continue;
			}
			$id    = isset( $it['id'] ) ? preg_replace( '/[^A-Za-z0-9]/', '', (string) $it['id'] ) : '';
			$out[] = array(
				'id'       => '' !== $id ? substr( $id, 0, 20 ) : wp_generate_password( 10, false ),
				'on'       => ! empty( $it['on'] ) && 'no' !== $it['on'],
				'provider' => $provider,
				'form'     => isset( $it['form'] ) ? sanitize_text_field( (string) $it['form'] ) : '',
				'tpl'      => $tpl,
				'expiry'   => isset( $it['expiry'] ) ? max( 0, min( 3650, absint( $it['expiry'] ) ) ) : 0,
				'f_name'   => isset( $it['f_name'] ) ? sanitize_text_field( (string) $it['f_name'] ) : '',
				'f_email'  => isset( $it['f_email'] ) ? sanitize_text_field( (string) $it['f_email'] ) : '',
				'f_mobile' => isset( $it['f_mobile'] ) ? sanitize_text_field( (string) $it['f_mobile'] ) : '',
			);
		}
		update_option( self::OPT, $out, false );
		Emzagar_Hub::invalidate();
		return count( $out );
	}

	public static function act_save() {
		self::guard( 'emzagar_form_save' );
		// phpcs:disable WordPress.Security.NonceVerification.Missing -- در guard بررسی شده
		$provider = isset( $_POST['provider'] ) ? sanitize_key( wp_unslash( $_POST['provider'] ) ) : '';
		$tpl      = isset( $_POST['tpl'] ) ? absint( $_POST['tpl'] ) : 0;
		if ( ! isset( self::providers()[ $provider ] ) || ! $tpl ) {
			self::back( 'bad' );
		}
		$rules = self::rules();
		if ( count( $rules ) >= self::MAX ) {
			self::back( 'limit' );
		}
		$rules[] = array(
			'id'       => wp_generate_password( 10, false ),
			'on'       => true,
			'provider' => $provider,
			'form'     => isset( $_POST['form'] ) ? sanitize_text_field( wp_unslash( $_POST['form'] ) ) : '',
			'tpl'      => $tpl,
			'expiry'   => isset( $_POST['expiry'] ) && '' !== $_POST['expiry'] ? max( 0, min( 3650, absint( $_POST['expiry'] ) ) ) : 0,
			'f_name'   => isset( $_POST['f_name'] ) ? sanitize_text_field( wp_unslash( $_POST['f_name'] ) ) : '',
			'f_email'  => isset( $_POST['f_email'] ) ? sanitize_text_field( wp_unslash( $_POST['f_email'] ) ) : '',
			'f_mobile' => isset( $_POST['f_mobile'] ) ? sanitize_text_field( wp_unslash( $_POST['f_mobile'] ) ) : '',
		);
		// phpcs:enable
		update_option( self::OPT, $rules, false );
		Emzagar_Hub::invalidate();
		wp_schedule_single_event( time() + 3, Emzagar_Hub::HOOK_REFRESH );
		self::back( 'form_saved' );
	}

	public static function act_delete() {
		self::guard( 'emzagar_form_delete' );
		$id    = isset( $_GET['id'] ) ? sanitize_text_field( wp_unslash( $_GET['id'] ) ) : '';
		$rules = array_values(
			array_filter(
				self::rules(),
				function ( $r ) use ( $id ) {
					return $r['id'] !== $id;
				}
			)
		);
		update_option( self::OPT, $rules, false );
		Emzagar_Hub::invalidate();
		wp_schedule_single_event( time() + 3, Emzagar_Hub::HOOK_REFRESH );
		self::back( 'form_deleted' );
	}

	public static function render_tab() {
		$rules = self::rules();
		$tpls  = Emzagar_API::is_configured() ? Emzagar_API::request( 'GET', '/api/v1/templates', array(), null, true ) : array( 'items' => array() );
		$tpls  = is_wp_error( $tpls ) ? array( 'items' => array() ) : $tpls;
		$tname = array();
		foreach ( (array) $tpls['items'] as $t ) {
			$tname[ (int) $t['id'] ] = $t['title'];
		}
		?>
		<section class="emz-h-box">
			<h2><?php esc_html_e( 'فرم‌سازهای نصب‌شده', 'emzagar' ); ?></h2>
			<p>
				<?php foreach ( self::providers() as $k => $l ) : ?>
					<span class="emz-st <?php echo self::installed( $k ) ? 'emz-st-signed' : ''; ?>"><?php echo self::installed( $k ) ? '✓ ' : ''; ?><?php echo esc_html( $l ); ?></span>
				<?php endforeach; ?>
			</p>
			<p class="description"><?php esc_html_e( 'با ارسال هر فرم، نام و ایمیل و موبایل مشتری از خود فرم تشخیص داده می‌شود و قرارداد انتخابی برایش صادر می‌شود. ارسال تکراریِ همان ایمیل در ۱۰ دقیقه نادیده گرفته می‌شود و سقف روزانه، سقف هر IP و قفل اضطراری هم اعمال می‌شود (تنظیمات ← محدودیت و امنیت).', 'emzagar' ); ?></p>
		</section>

		<section class="emz-h-box">
			<h2><?php esc_html_e( 'اتصال‌های فعال', 'emzagar' ); ?></h2>
			<?php if ( empty( $rules ) ) : ?>
				<p class="emz-h-empty"><?php esc_html_e( 'هنوز فرمی وصل نشده است.', 'emzagar' ); ?></p>
			<?php else : ?>
				<table class="widefat striped"><thead><tr><th><?php esc_html_e( 'فرم‌ساز', 'emzagar' ); ?></th><th><?php esc_html_e( 'فرم', 'emzagar' ); ?></th><th><?php esc_html_e( 'قالب قرارداد', 'emzagar' ); ?></th><th></th></tr></thead><tbody>
				<?php foreach ( $rules as $r ) : ?>
					<tr>
						<td><?php echo esc_html( self::providers()[ $r['provider'] ] ); ?></td>
						<td><?php echo '' !== $r['form'] ? esc_html( $r['form'] ) : esc_html__( 'همه‌ی فرم‌ها', 'emzagar' ); ?></td>
						<td><?php echo esc_html( isset( $tname[ (int) $r['tpl'] ] ) ? $tname[ (int) $r['tpl'] ] : '#' . (int) $r['tpl'] ); ?></td>
						<td style="text-align:end"><a class="button button-small button-link-delete" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_form_delete&id=' . rawurlencode( $r['id'] ) ), 'emzagar_form_delete' ) ); ?>"><?php esc_html_e( 'حذف', 'emzagar' ); ?></a></td>
					</tr>
				<?php endforeach; ?>
				</tbody></table>
			<?php endif; ?>
		</section>

		<section class="emz-h-box">
			<h2><?php esc_html_e( 'اتصال فرم جدید', 'emzagar' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="emzagar_form_save">
				<?php wp_nonce_field( 'emzagar_form_save' ); ?>
				<table class="form-table" role="presentation"><tbody>
					<tr><th><label for="emz-fm-p"><?php esc_html_e( 'فرم‌ساز', 'emzagar' ); ?></label></th><td>
						<select id="emz-fm-p" name="provider">
							<?php foreach ( self::providers() as $k => $l ) : ?>
								<option value="<?php echo esc_attr( $k ); ?>"><?php echo esc_html( $l . ( self::installed( $k ) ? '' : ' (' . __( 'نصب نیست', 'emzagar' ) . ')' ) ); ?></option>
							<?php endforeach; ?>
						</select>
					</td></tr>
					<tr><th><label for="emz-fm-f"><?php esc_html_e( 'شناسه یا نام فرم', 'emzagar' ); ?></label></th><td><input type="text" id="emz-fm-f" name="form" class="regular-text" placeholder="<?php esc_attr_e( 'خالی = همه‌ی فرم‌های این فرم‌ساز', 'emzagar' ); ?>"></td></tr>
					<tr><th><label for="emz-fm-t"><?php esc_html_e( 'قالب قرارداد', 'emzagar' ); ?></label></th><td>
						<select id="emz-fm-t" name="tpl" required>
							<option value=""><?php esc_html_e( '— انتخاب کنید —', 'emzagar' ); ?></option>
							<?php foreach ( $tname as $id => $title ) : ?>
								<option value="<?php echo (int) $id; ?>"><?php echo esc_html( $title ); ?></option>
							<?php endforeach; ?>
						</select>
					</td></tr>
					<tr><th><label for="emz-fm-e"><?php esc_html_e( 'مهلت امضا (روز)', 'emzagar' ); ?></label></th><td><input type="number" id="emz-fm-e" name="expiry" min="0" max="3650" class="small-text" placeholder="14"></td></tr>
					<tr><th><?php esc_html_e( 'نام فیلدها (اختیاری)', 'emzagar' ); ?></th><td>
						<details><summary><?php esc_html_e( 'اگر تشخیص خودکار کافی نبود', 'emzagar' ); ?></summary>
							<p><input type="text" name="f_name" class="regular-text" placeholder="<?php esc_attr_e( 'فیلد نام', 'emzagar' ); ?>"></p>
							<p><input type="text" name="f_email" class="regular-text" dir="ltr" placeholder="<?php esc_attr_e( 'فیلد ایمیل', 'emzagar' ); ?>"></p>
							<p><input type="text" name="f_mobile" class="regular-text" dir="ltr" placeholder="<?php esc_attr_e( 'فیلد موبایل', 'emzagar' ); ?>"></p>
						</details>
					</td></tr>
				</tbody></table>
				<?php submit_button( __( 'ذخیره اتصال', 'emzagar' ) ); ?>
			</form>
		</section>
		<?php
	}
}
