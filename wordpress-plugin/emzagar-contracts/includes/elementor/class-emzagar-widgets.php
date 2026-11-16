<?php
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

use Elementor\Controls_Manager;
use Elementor\Group_Control_Typography;
use Elementor\Widget_Base;

/** پایه‌ی مشترک ویجت‌ها: دسته، آیکون، شناسایی استایل */
abstract class Emzagar_Widget_Base extends Widget_Base {

	public function get_categories() {
		return array( 'emzagar' );
	}

	public function get_style_depends() {
		return array( 'emzagar' );
	}

	/** کنترل‌های ظاهری مشترک */
	protected function style_controls() {
		$this->start_controls_section( 'emz_style', array( 'label' => __( 'ظاهر', 'emzagar' ), 'tab' => Controls_Manager::TAB_STYLE ) );
		$this->add_control(
			'accent',
			array(
				'label'     => __( 'رنگ اصلی', 'emzagar' ),
				'type'      => Controls_Manager::COLOR,
				'selectors' => array( '{{WRAPPER}} .emz-wrap' => '--emz-accent: {{VALUE}};' ),
			)
		);
		$this->add_control(
			'card_bg',
			array(
				'label'     => __( 'پس‌زمینه‌ی کارت‌ها و جدول', 'emzagar' ),
				'type'      => Controls_Manager::COLOR,
				'selectors' => array( '{{WRAPPER}} .emz-wrap' => '--emz-bg: {{VALUE}};' ),
			)
		);
		$this->add_control(
			'border_color',
			array(
				'label'     => __( 'رنگ حاشیه', 'emzagar' ),
				'type'      => Controls_Manager::COLOR,
				'selectors' => array( '{{WRAPPER}} .emz-wrap' => '--emz-border: {{VALUE}};' ),
			)
		);
		$this->add_group_control(
			Group_Control_Typography::get_type(),
			array(
				'name'     => 'typo',
				'selector' => '{{WRAPPER}} .emz-wrap',
			)
		);
		$this->end_controls_section();
	}
}

class Emzagar_Widget_Dashboard extends Emzagar_Widget_Base {
	public function get_name() {
		return 'emzagar_dashboard';
	}
	public function get_title() {
		return __( 'داشبورد قراردادها', 'emzagar' );
	}
	public function get_icon() {
		return 'eicon-table';
	}
	public function get_keywords() {
		return array( 'emzagar', 'contract', 'قرارداد', 'امضا' );
	}

	protected function register_controls() {
		$this->start_controls_section( 'content', array( 'label' => __( 'محتوا', 'emzagar' ) ) );
		$this->add_control( 'title', array( 'label' => __( 'عنوان', 'emzagar' ), 'type' => Controls_Manager::TEXT, 'default' => __( 'قراردادهای من', 'emzagar' ) ) );
		$this->add_control(
			'scope',
			array(
				'label'   => __( 'محدوده', 'emzagar' ),
				'type'    => Controls_Manager::SELECT,
				'default' => 'mine',
				'options' => array(
					'mine' => __( 'قراردادهای کاربر واردشده', 'emzagar' ),
					'all'  => __( 'همه‌ی قراردادها (فقط مدیر سایت)', 'emzagar' ),
				),
			)
		);
		$this->add_control( 'per_page', array( 'label' => __( 'تعداد در هر صفحه', 'emzagar' ), 'type' => Controls_Manager::NUMBER, 'default' => 10, 'min' => 1, 'max' => 50 ) );
		$this->add_control( 'show_stats', array( 'label' => __( 'نمایش کارت‌های آمار', 'emzagar' ), 'type' => Controls_Manager::SWITCHER, 'return_value' => 'yes', 'default' => 'yes' ) );
		$this->end_controls_section();
		$this->style_controls();
	}

	protected function render() {
		$s = $this->get_settings_for_display();
		echo Emzagar_Shortcodes::render_dashboard( // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escape شده در کلاس
			array(
				'title'      => isset( $s['title'] ) ? $s['title'] : '',
				'scope'      => isset( $s['scope'] ) ? $s['scope'] : 'mine',
				'per_page'   => isset( $s['per_page'] ) ? $s['per_page'] : 10,
				'show_stats' => 'yes' === ( isset( $s['show_stats'] ) ? $s['show_stats'] : 'yes' ) ? 'yes' : 'no',
			)
		);
	}
}

class Emzagar_Widget_Stats extends Emzagar_Widget_Base {
	public function get_name() {
		return 'emzagar_stats';
	}
	public function get_title() {
		return __( 'آمار قراردادها', 'emzagar' );
	}
	public function get_icon() {
		return 'eicon-counter';
	}

	protected function register_controls() {
		$this->start_controls_section( 'content', array( 'label' => __( 'محتوا', 'emzagar' ) ) );
		$this->add_control(
			'scope',
			array(
				'label'   => __( 'محدوده', 'emzagar' ),
				'type'    => Controls_Manager::SELECT,
				'default' => 'mine',
				'options' => array(
					'mine' => __( 'کاربر واردشده', 'emzagar' ),
					'all'  => __( 'کل (فقط مدیر سایت)', 'emzagar' ),
				),
			)
		);
		$this->end_controls_section();
		$this->style_controls();
	}

	protected function render() {
		$s = $this->get_settings_for_display();
		echo Emzagar_Shortcodes::render_stats( array( 'scope' => isset( $s['scope'] ) ? $s['scope'] : 'mine' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	}
}

class Emzagar_Widget_Request extends Emzagar_Widget_Base {
	public function get_name() {
		return 'emzagar_request';
	}
	public function get_title() {
		return __( 'فرم درخواست قرارداد', 'emzagar' );
	}
	public function get_icon() {
		return 'eicon-form-horizontal';
	}

	protected function register_controls() {
		$this->start_controls_section( 'content', array( 'label' => __( 'محتوا', 'emzagar' ) ) );
		$options = array( '' => __( '— قالب پیش‌فرض تنظیمات —', 'emzagar' ) );
		foreach ( Emzagar_Settings::templates() as $t ) {
			$options[ (string) $t['id'] ] = $t['title'];
		}
		$this->add_control( 'template_id', array( 'label' => __( 'قالب قرارداد', 'emzagar' ), 'type' => Controls_Manager::SELECT, 'options' => $options, 'default' => '' ) );
		$this->add_control( 'title', array( 'label' => __( 'عنوان', 'emzagar' ), 'type' => Controls_Manager::TEXT, 'default' => '' ) );
		$this->add_control( 'button', array( 'label' => __( 'متن دکمه', 'emzagar' ), 'type' => Controls_Manager::TEXT, 'default' => __( 'درخواست قرارداد', 'emzagar' ) ) );
		$this->end_controls_section();
		$this->style_controls();
	}

	protected function render() {
		$s = $this->get_settings_for_display();
		echo Emzagar_Shortcodes::render_request_form( // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			array(
				'template_id' => isset( $s['template_id'] ) ? (int) $s['template_id'] : 0,
				'title'       => isset( $s['title'] ) ? $s['title'] : '',
				'button'      => isset( $s['button'] ) ? $s['button'] : '',
			)
		);
	}
}
