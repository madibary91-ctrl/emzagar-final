/* امضاگیر — ویزارد خوش‌آمدگویی: گام‌به‌گام، با ذخیره‌ی گام جاری (بدون JS هم همه‌ی گام‌ها دیده می‌شود) */
( function () {
	'use strict';
	var cfg = window.EmzagarWelcome;
	var root = document.getElementById( 'emz-welcome' );
	if ( ! root ) { return; }
	root.classList.add( 'js' );

	var panes = [].slice.call( root.querySelectorAll( '.emz-pane' ) );
	var tabs = [].slice.call( root.querySelectorAll( '#emz-steps button' ) );
	var prev = document.getElementById( 'emz-prev' );
	var next = document.getElementById( 'emz-next' );
	var pos = document.getElementById( 'emz-pos' );
	var last = panes.length - 1;
	var cur = Math.max( 0, Math.min( last, parseInt( root.getAttribute( 'data-start' ), 10 ) || 0 ) );

	function save( step ) {
		if ( ! cfg ) { return; }
		var body = new URLSearchParams( { action: 'emzagar_onboard_step', nonce: cfg.nonce, step: step } );
		fetch( cfg.ajax, { method: 'POST', credentials: 'same-origin', body: body } ).catch( function () {} );
	}

	function show( i, persist ) {
		cur = Math.max( 0, Math.min( last, i ) );
		panes.forEach( function ( p, n ) { p.classList.toggle( 'is-active', n === cur ); } );
		tabs.forEach( function ( t, n ) {
			t.classList.toggle( 'is-active', n === cur );
			t.classList.toggle( 'is-seen', n < cur );
			t.setAttribute( 'aria-current', n === cur ? 'step' : 'false' );
		} );
		prev.disabled = cur === 0;
		next.style.visibility = cur === last ? 'hidden' : 'visible';
		pos.textContent = ( cur + 1 ) + ' / ' + ( last + 1 );
		if ( persist ) { save( cur ); }
	}

	prev.addEventListener( 'click', function () { show( cur - 1, true ); } );
	next.addEventListener( 'click', function () { show( cur + 1, true ); } );
	tabs.forEach( function ( t, n ) { t.addEventListener( 'click', function () { show( n, true ); } ); } );
	document.addEventListener( 'keydown', function ( e ) {
		if ( /input|textarea|select/i.test( ( e.target || {} ).tagName || '' ) ) { return; }
		var rtl = document.dir === 'rtl' || root.getAttribute( 'dir' ) === 'rtl';
		if ( e.key === 'ArrowRight' ) { show( cur + ( rtl ? -1 : 1 ), true ); }
		if ( e.key === 'ArrowLeft' ) { show( cur + ( rtl ? 1 : -1 ), true ); }
	} );

	show( cur, false );
}() );
