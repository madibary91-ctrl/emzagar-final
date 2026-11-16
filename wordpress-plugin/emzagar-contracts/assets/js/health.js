/* امضاگیر — وضعیت سیستم: بررسی زنده‌ی ابر و REST، ارسال ضربان، به‌روزرسانی چراغ‌ها */
( function () {
	'use strict';
	var cfg = window.EmzagarHealth;
	var root = document.getElementById( 'emz-health' );
	if ( ! cfg || ! root ) { return; }

	var LAMP = { ok: 'is-green', warn: 'is-amber', bad: 'is-red', off: 'is-grey', pending: 'is-grey is-pulse' };
	var TITLE = { ok: 'همه‌چیز سالم است', warn: 'چند مورد نیاز به توجه دارد', bad: 'مشکل جدی وجود دارد' };
	var msg = document.getElementById( 'emz-health-msg' );
	var busy = false;

	function post( action, extra ) {
		var body = new URLSearchParams( Object.assign( { action: action, nonce: cfg.nonce }, extra || {} ) );
		return fetch( cfg.ajax, { method: 'POST', credentials: 'same-origin', body: body } ).then( function ( r ) { return r.json(); } );
	}

	function setLamp( el, status ) {
		el.className = 'emz-lamp ' + ( LAMP[ status ] || LAMP.off );
	}

	function apply( report ) {
		report.checks.forEach( function ( c ) {
			var li = root.querySelector( 'li[data-id="' + c.id + '"]' );
			if ( ! li ) { return; }
			li.className = 'st-' + c.status;
			setLamp( li.querySelector( '.emz-lamp' ), c.status );
			li.querySelector( '[data-role="detail"]' ).textContent = c.detail;
		} );
		var banner = document.getElementById( 'emz-banner' );
		banner.className = 'emz-banner is-' + report.overall;
		setLamp( banner.querySelector( '.emz-lamp' ), report.overall );
		document.getElementById( 'emz-banner-title' ).textContent = TITLE[ report.overall ];
		var n = report.counts;
		document.getElementById( 'emz-banner-sub' ).textContent = n.ok + ' سالم · ' + n.warn + ' هشدار · ' + n.bad + ' مشکل';
	}

	function run( silent ) {
		if ( busy ) { return Promise.resolve(); }
		busy = true;
		if ( ! silent ) { msg.textContent = cfg.i18n.checking; }
		return post( 'emzagar_health_live' ).then( function ( res ) {
			if ( res && res.success ) { apply( res.data ); msg.textContent = ''; } else { msg.textContent = cfg.i18n.failed; }
		} ).catch( function () { msg.textContent = cfg.i18n.failed; } ).then( function () { busy = false; } );
	}

	document.getElementById( 'emz-health-run' ).addEventListener( 'click', function () { run( false ); } );
	document.getElementById( 'emz-health-beat' ).addEventListener( 'click', function () {
		msg.textContent = cfg.i18n.checking;
		post( 'emzagar_health_beat' ).then( function ( res ) {
			if ( res && res.success ) {
				apply( res.data.report );
				msg.textContent = res.data.ok ? cfg.i18n.sent : ( res.data.error || cfg.i18n.failed );
			} else { msg.textContent = cfg.i18n.failed; }
		} ).catch( function () { msg.textContent = cfg.i18n.failed; } );
	} );

	run( true );
	setInterval( function () { if ( ! document.hidden ) { run( true ); } }, 60000 );
}() );
