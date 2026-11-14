<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * سازگاری با المنتور: ثبت دسته‌ی «امضاگیر» و سه ویجت.
 * شورت‌کدها در ویجت «شورت‌کد» المنتور هم مستقیماً کار می‌کنند؛ این ویجت‌ها فقط کنترل‌های بصری اضافه می‌کنند.
 */
class Emzagar_Elementor {

	public static function init() {
		add_action( 'elementor/elements/categories_registered', array( __CLASS__, 'category' ) );
		add_action( 'elementor/widgets/register', array( __CLASS__, 'widgets' ) );
		// استایل داخل ویرایشگر و پیش‌نمایش
		add_action( 'elementor/frontend/after_enqueue_styles', array( __CLASS__, 'styles' ) );
		add_action( 'elementor/preview/enqueue_styles', array( __CLASS__, 'styles' ) );
	}

	public static function styles() {
		wp_enqueue_style( 'emzagar', EMZ_URL . 'assets/css/emzagar.css', array(), EMZ_VERSION );
	}

	public static function category( $manager ) {
		$manager->add_category(
			'emzagar',
			array(
				'title' => __( 'امضاگیر', 'emzagar' ),
				'icon'  => 'eicon-document-file',
			)
		);
	}

	public static function widgets( $widgets_manager ) {
		if ( ! class_exists( '\Elementor\Widget_Base' ) ) {
			return;
		}
		require_once EMZ_DIR . 'includes/elementor/class-emzagar-widgets.php';
		$widgets_manager->register( new Emzagar_Widget_Dashboard() );
		$widgets_manager->register( new Emzagar_Widget_Stats() );
		$widgets_manager->register( new Emzagar_Widget_Request() );
	}
}
