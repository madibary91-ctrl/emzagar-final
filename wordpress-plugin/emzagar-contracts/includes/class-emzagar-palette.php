<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * پالت فرمان سراسری (Ctrl/⌘ + K) در تمام صفحه‌های پیشخوان وردپرس.
 *
 *  • پرش به هر صفحه‌ی مدیریت (از خود منوی وردپرس ساخته می‌شود؛ شامل افزونه‌های دیگر)
 *  • اقدام‌های سریع: صدور قرارداد، یادآوری گروهی، باز کردن پنل، اتوماسیون‌ها …
 *  • جستجوی زنده‌ی یکپارچه: قراردادها، مشتریان و قالب‌های امضاگیر + نوشته/صفحه/محصول/کاربر/سفارش ووکامرس وردپرس
 */
class Emzagar_Palette {

	public static function init() {
		add_action( 'admin_bar_menu', array( __CLASS__, 'admin_bar' ), 80 );
		if ( is_admin() ) {
			add_action( 'admin_enqueue_scripts', array( __CLASS__, 'assets' ) );
			add_action( 'wp_ajax_emzagar_palette_search', array( __CLASS__, 'ajax_search' ) );
		}
	}

	public static function enabled() {
		$h = Emzagar_Hub::opts();
		return 'yes' === $h['palette'] && current_user_can( 'manage_options' );
	}

	public static function admin_bar( $bar ) {
		if ( ! self::enabled() || ! is_admin() ) {
			return;
		}
		$bar->add_node(
			array(
				'id'    => 'emzagar-search',
				'title' => '<span class="ab-icon dashicons dashicons-search" style="margin-top:2px"></span><span class="ab-label">' . esc_html__( 'جستجو', 'emzagar' ) . '<kbd>Ctrl K</kbd></span>',
				'href'  => '#emzagar-palette',
				'meta'  => array( 'title' => esc_attr__( 'پالت فرمان امضاگیر (Ctrl+K)', 'emzagar' ) ),
			)
		);
	}

	/** منوی مدیریت وردپرس → فهرست پرش */
	private static function menu_commands() {
		global $menu, $submenu;
		$out = array();
		if ( ! is_array( $menu ) ) {
			return $out;
		}
		$clean = function ( $t ) {
			$t = preg_replace( '#<span[^>]*>.*?</span>#s', '', (string) $t );
			return trim( wp_strip_all_tags( $t ) );
		};
		$url   = function ( $slug, $parent = '' ) {
			if ( preg_match( '#^https?://#', $slug ) ) {
				return $slug;
			}
			if ( false !== strpos( $slug, '.php' ) ) {
				return admin_url( $slug );
			}
			if ( '' !== $parent && false !== strpos( $parent, '.php' ) ) {
				return admin_url( $parent . ( false === strpos( $parent, '?' ) ? '?' : '&' ) . 'page=' . rawurlencode( $slug ) );
			}
			return admin_url( 'admin.php?page=' . rawurlencode( $slug ) );
		};
		foreach ( $menu as $m ) {
			if ( empty( $m[0] ) || empty( $m[2] ) || ( isset( $m[1] ) && ! current_user_can( $m[1] ) ) ) {
				continue;
			}
			$parent_title = $clean( $m[0] );
			if ( '' === $parent_title ) {
				continue;
			}
			$out[] = array(
				'g' => __( 'برو به', 'emzagar' ),
				't' => $parent_title,
				's' => '',
				'u' => $url( $m[2] ),
				'i' => '➜',
				'n' => 1,
			);
			if ( ! empty( $submenu[ $m[2] ] ) && is_array( $submenu[ $m[2] ] ) ) {
				foreach ( $submenu[ $m[2] ] as $sm ) {
					if ( empty( $sm[0] ) || empty( $sm[2] ) || ( isset( $sm[1] ) && ! current_user_can( $sm[1] ) ) ) {
						continue;
					}
					$st = $clean( $sm[0] );
					if ( '' === $st || $st === $parent_title || $sm[2] === $m[2] ) {
						continue;
					}
					$out[] = array(
						'g' => __( 'برو به', 'emzagar' ),
						't' => $st,
						's' => $parent_title,
						'u' => $url( $sm[2], $m[2] ),
						'i' => '➜',
						'n' => 1,
					);
				}
			}
		}
		return array_slice( $out, 0, 300 );
	}

	private static function action_commands() {
		$g   = __( 'اقدام سریع', 'emzagar' );
		$out = array(
			array( 'g' => $g, 't' => __( 'صدور قرارداد جدید', 'emzagar' ), 's' => __( 'میز کار', 'emzagar' ), 'u' => Emzagar_Workspace::url( array( 'tab' => 'new' ) ), 'i' => '➕' ),
			array( 'g' => $g, 't' => __( 'کانبان قراردادها', 'emzagar' ), 's' => __( 'میز کار', 'emzagar' ), 'u' => Emzagar_Workspace::url(), 'i' => '🗂️' ),
			array( 'g' => $g, 't' => __( 'همه‌ی قراردادها', 'emzagar' ), 's' => __( 'میز کار', 'emzagar' ), 'u' => Emzagar_Workspace::url( array( 'tab' => 'list' ) ), 'i' => '📄' ),
			array( 'g' => $g, 't' => __( 'قراردادهای منتظر امضا', 'emzagar' ), 's' => __( 'میز کار', 'emzagar' ), 'u' => Emzagar_Workspace::url( array( 'tab' => 'list', 'status' => 'sent' ) ), 'i' => '⏳' ),
			array( 'g' => $g, 't' => __( 'فعالیت زنده', 'emzagar' ), 's' => __( 'صندوق فعالیت', 'emzagar' ), 'u' => Emzagar_Workspace::url( array( 'tab' => 'activity' ) ), 'i' => '🔔' ),
			array( 'g' => $g, 't' => __( 'مرکز فرماندهی کسب‌وکار', 'emzagar' ), 's' => __( 'نبض و عمق یکپارچگی', 'emzagar' ), 'u' => Emzagar_Hub::hub_url(), 'i' => '📊' ),
			array( 'g' => $g, 't' => __( 'اتوماسیون‌ها (اگر … آنگاه)', 'emzagar' ), 's' => __( 'قوانین خودکار', 'emzagar' ), 'u' => Emzagar_Automations::url(), 'i' => '⚡' ),
			array( 'g' => $g, 't' => __( 'اتصال فرم‌ها به قرارداد', 'emzagar' ), 's' => __( 'CF7، WPForms، Gravity، المنتور', 'emzagar' ), 'u' => Emzagar_Automations::url( array( 'tab' => 'forms' ) ), 'i' => '🧩' ),
			array( 'g' => $g, 't' => __( 'یادآوری گروهی به همه‌ی معطل‌ها', 'emzagar' ), 's' => __( 'اقدام یک‌کلیکی', 'emzagar' ), 'u' => wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_hub_remind_all' ), 'emzagar_hub_remind_all' ), 'i' => '📣' ),
			array( 'g' => $g, 't' => __( 'به‌روزرسانی نبض کسب‌وکار', 'emzagar' ), 's' => '', 'u' => wp_nonce_url( admin_url( 'admin-post.php?action=emzagar_hub_refresh' ), 'emzagar_hub_refresh' ), 'i' => '🔄' ),
			array( 'g' => $g, 't' => __( 'باز کردن پنل امضاگیر', 'emzagar' ), 's' => __( 'ورود یک‌کلیکی', 'emzagar' ), 'u' => Emzagar_Connect::panel_link( 'admin' ), 'i' => '🚀' ),
			array( 'g' => $g, 't' => __( 'تنظیمات امضاگیر', 'emzagar' ), 's' => '', 'u' => admin_url( 'admin.php?page=emzagar' ), 'i' => '⚙️' ),
		);
		return $out;
	}

	public static function assets() {
		if ( ! self::enabled() ) {
			return;
		}
		wp_enqueue_style( 'emzagar-workspace', EMZ_URL . 'assets/css/workspace.css', array(), EMZ_VERSION );
		wp_enqueue_script( 'emzagar-palette', EMZ_URL . 'assets/js/palette.js', array(), EMZ_VERSION, true );
		$cfg = Emzagar_API::is_configured();
		wp_localize_script(
			'emzagar-palette',
			'EmzagarPalette',
			array(
				'ajax'     => admin_url( 'admin-ajax.php' ),
				'nonce'    => wp_create_nonce( 'emzagar_palette' ),
				'live'     => $cfg,
				'commands' => array_merge( $cfg ? self::action_commands() : array(), self::menu_commands() ),
				't'        => array(
					'placeholder' => __( 'جستجوی قرارداد، مشتری، صفحه، محصول، سفارش یا هر دستور…', 'emzagar' ),
					'empty'       => __( 'نتیجه‌ای پیدا نشد.', 'emzagar' ),
					'searching'   => __( 'در حال جستجو…', 'emzagar' ),
					'hint'        => __( '↑↓ حرکت   ↵ باز کردن   Esc بستن', 'emzagar' ),
				),
			)
		);
	}

	public static function ajax_search() {
		check_ajax_referer( 'emzagar_palette', 'nonce' );
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_send_json_error( null, 403 );
		}
		$q = isset( $_POST['q'] ) ? sanitize_text_field( wp_unslash( $_POST['q'] ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Missing
		$q = mb_substr( trim( $q ), 0, 80 );
		if ( mb_strlen( $q ) < 2 ) {
			wp_send_json_success( array( 'items' => array() ) );
		}
		$items = array();

		// ۱) ابر امضاگیر (با کش کوتاه برای کاهش بار)
		if ( Emzagar_API::is_configured() ) {
			$key   = 'emz_pal_' . md5( mb_strtolower( $q ) );
			$cloud = get_transient( $key );
			if ( false === $cloud ) {
				$cloud = Emzagar_API::request( 'GET', '/api/v1/hub/search', array( 'q' => $q ) );
				if ( ! is_wp_error( $cloud ) ) {
					set_transient( $key, $cloud, 45 );
				}
			}
			if ( ! is_wp_error( $cloud ) && is_array( $cloud ) ) {
				foreach ( (array) ( isset( $cloud['contracts'] ) ? $cloud['contracts'] : array() ) as $c ) {
					$items[] = array(
						'g' => __( 'قراردادها', 'emzagar' ),
						't' => (string) $c['title'],
						's' => $c['number'] . ' • ' . $c['customer'] . ' • ' . $c['statusLabel'],
						'u' => Emzagar_Workspace::url( array( 'contract' => (int) $c['id'] ) ),
						'i' => '📄',
					);
				}
				foreach ( (array) ( isset( $cloud['customers'] ) ? $cloud['customers'] : array() ) as $c ) {
					$wp_user = get_user_by( 'email', (string) $c['email'] );
					$items[] = array(
						'g' => __( 'مشتریان', 'emzagar' ),
						't' => '' !== (string) $c['name'] ? (string) $c['name'] : (string) $c['email'],
						/* translators: 1: contracts 2: signed */
						's' => sprintf( __( '%1$s قرارداد • %2$s امضاشده', 'emzagar' ), number_format_i18n( (int) $c['contracts'] ), number_format_i18n( (int) $c['signed'] ) ),
						'u' => $wp_user && current_user_can( 'edit_user', $wp_user->ID ) ? get_edit_user_link( $wp_user->ID ) : Emzagar_Workspace::url( array( 'tab' => 'list', 'q' => (string) $c['email'] ) ),
						'i' => '👤',
					);
				}
				foreach ( (array) ( isset( $cloud['templates'] ) ? $cloud['templates'] : array() ) as $t ) {
					$items[] = array(
						'g' => __( 'قالب‌ها', 'emzagar' ),
						't' => (string) $t['title'],
						's' => __( 'صدور قرارداد با این قالب', 'emzagar' ),
						'u' => Emzagar_Workspace::url( array( 'tab' => 'new', 'template' => (int) $t['id'] ) ),
						'i' => '🧾',
					);
				}
			}
		}

		// ۲) محتوای خود وردپرس
		$posts = get_posts(
			array(
				's'                      => $q,
				'post_type'              => 'any',
				'post_status'            => 'any',
				'posts_per_page'         => 6,
				'no_found_rows'          => true,
				'update_post_term_cache' => false,
				'suppress_filters'       => false,
			)
		);
		foreach ( $posts as $p ) {
			if ( ! current_user_can( 'edit_post', $p->ID ) ) {
				continue;
			}
			$pt      = get_post_type_object( $p->post_type );
			$items[] = array(
				'g' => __( 'محتوای سایت', 'emzagar' ),
				't' => '' !== $p->post_title ? $p->post_title : __( '(بدون عنوان)', 'emzagar' ),
				's' => $pt ? $pt->labels->singular_name : $p->post_type,
				'u' => get_edit_post_link( $p->ID, 'raw' ),
				'i' => '📝',
			);
		}
		if ( current_user_can( 'list_users' ) ) {
			foreach ( get_users(
				array(
					'search'         => '*' . $q . '*',
					'search_columns' => array( 'user_login', 'user_email', 'display_name' ),
					'number'         => 4,
				)
			) as $u ) {
				$items[] = array(
					'g' => __( 'کاربران', 'emzagar' ),
					't' => $u->display_name,
					's' => $u->user_email,
					'u' => get_edit_user_link( $u->ID ),
					'i' => '🙍',
				);
			}
		}
		if ( ctype_digit( $q ) && function_exists( 'wc_get_order' ) ) {
			$order = wc_get_order( (int) $q );
			if ( $order && method_exists( $order, 'get_edit_order_url' ) && current_user_can( 'edit_shop_orders' ) ) {
				$items[] = array(
					'g' => __( 'سفارش‌ها', 'emzagar' ),
					/* translators: %s: order number */
					't' => sprintf( __( 'سفارش #%s', 'emzagar' ), $order->get_order_number() ),
					's' => wc_get_order_status_name( $order->get_status() ),
					'u' => $order->get_edit_order_url(),
					'i' => '🛒',
				);
			}
		}
		wp_send_json_success( array( 'items' => array_slice( $items, 0, 30 ) ) );
	}
}
