<?php
// حذف کامل داده‌های افزونه هنگام حذف از وردپرس
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

// اتصال را در ابر می‌بندیم (کلید باطل می‌شود؛ قراردادها و قالب‌ها در حساب شما می‌مانند).
$emz_opts = get_option( 'emzagar_options', array() );
if ( is_array( $emz_opts ) && ! empty( $emz_opts['api_key'] ) && ! empty( $emz_opts['base_url'] ) && 'auto' === ( isset( $emz_opts['connection'] ) ? $emz_opts['connection'] : '' ) ) {
	wp_remote_post(
		untrailingslashit( $emz_opts['base_url'] ) . '/api/v1/connect/disconnect',
		array(
			'timeout'     => 5,
			'redirection' => 0,
			'headers'     => array(
				'Authorization' => 'Bearer ' . $emz_opts['api_key'],
				'Accept'        => 'application/json',
				'Content-Type'  => 'application/json',
			),
			'body'        => '{}',
		)
	);
}

wp_clear_scheduled_hook( 'emzagar_connect_retry' );
wp_clear_scheduled_hook( 'emzagar_heartbeat' );
delete_option( 'emzagar_options' );
delete_option( 'emzagar_install_id' );
delete_option( 'emzagar_handshake' );
delete_option( 'emzagar_next_attempt' );
delete_option( 'emzagar_fail_count' );
delete_option( 'emzagar_last_error' );
delete_option( 'emzagar_sync_secret' );
delete_option( 'emzagar_sync_state' );
delete_option( 'emzagar_sync_seen' );
delete_option( 'emzagar_open_contracts' );
delete_option( 'emzagar_db_version' );
wp_clear_scheduled_hook( 'emzagar_hub_refresh' );
wp_clear_scheduled_hook( 'emzagar_hub_digest' );
delete_option( 'emzagar_hub' );
delete_option( 'emzagar_hub_pulse' );
delete_option( 'emzagar_hub_stats' );
delete_option( 'emzagar_sig_index' );
delete_option( 'emzagar_role_ready' );
delete_option( 'emzagar_feed' );
delete_option( 'emzagar_auto_rules' );
delete_option( 'emzagar_auto_log' );
delete_option( 'emzagar_form_rules' );
delete_option( 'emzagar_actions' );
delete_option( 'emzagar_ws_used' );
delete_option( 'emzagar_modules' );
delete_option( 'emzagar_module_errors' );
delete_option( 'emzagar_limits' );
delete_option( 'emzagar_lockdown' );
delete_option( 'emzagar_snapshot' );
delete_option( 'emzagar_last_export' );
delete_option( 'emzagar_last_beat' );
delete_option( 'emzagar_updater' );
delete_option( 'emz_update_info' );
delete_option( 'emzagar_onboarding' );
delete_option( 'emzagar_health_token' );
delete_option( 'emzagar_version' );
delete_option( 'emzagar_flush_rewrite' );
delete_transient( 'emzagar_welcome_redirect' );
delete_transient( 'emz_health_bad' );
wp_clear_scheduled_hook( 'emzagar_daily_maintenance' );
delete_transient( 'emz_hub_refresh_lock' );
wp_clear_scheduled_hook( 'emzagar_sync_tick' );
wp_clear_scheduled_hook( 'emzagar_sync_flush' );
wp_clear_scheduled_hook( 'emzagar_sync_backfill' );
delete_transient( 'emzagar_flush_lock' );
delete_transient( 'emzagar_just_activated' );
delete_transient( 'emzagar_connect_lock' );
global $wpdb;
$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE 'emzagar\\_rl\\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}emzagar_queue" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE '\_transient\_emz\_%' OR option_name LIKE '\_transient\_timeout\_emz\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
$wpdb->query( "DELETE FROM {$wpdb->postmeta} WHERE meta_key IN ('_emz_gate','_emz_gate_msg')" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
$wpdb->query( "DELETE FROM {$wpdb->usermeta} WHERE meta_key IN ('emzagar_mobile','_emz_signed_at','_emz_role_granted')" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
delete_metadata( 'user', 0, '_emz_feed_seen', '', true );
