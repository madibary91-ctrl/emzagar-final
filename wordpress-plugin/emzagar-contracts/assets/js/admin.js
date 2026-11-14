/* صفحه‌ی تنظیمات امضاگیر: نمایش/پنهان کلید و تست اتصال */
(function () {
	'use strict';
	var toggle = document.getElementById('emz-toggle-key');
	var key = document.getElementById('emz_key');
	if (toggle && key) {
		toggle.addEventListener('click', function () {
			var show = key.type === 'password';
			key.type = show ? 'text' : 'password';
			toggle.textContent = show ? 'پنهان' : 'نمایش';
		});
	}
	var btn = document.getElementById('emz-test');
	var out = document.getElementById('emz-test-result');
	if (!btn || !out || typeof EmzagarAdmin === 'undefined') return;
	btn.addEventListener('click', function () {
		out.textContent = EmzagarAdmin.wait;
		out.style.color = '';
		var body = new URLSearchParams({ action: 'emzagar_test', nonce: EmzagarAdmin.nonce });
		fetch(EmzagarAdmin.ajax, { method: 'POST', credentials: 'same-origin', body: body })
			.then(function (r) { return r.json(); })
			.then(function (j) {
				var ok = j && j.success;
				out.textContent = (j && j.data && j.data.message) || (ok ? 'OK' : 'خطا');
				out.style.color = ok ? '#0a7a3d' : '#b32d2e';
			})
			.catch(function () {
				out.textContent = 'ارتباط برقرار نشد';
				out.style.color = '#b32d2e';
			});
	});
})();

/* دکمه‌ی «اتصال دوباره»: نمایش وضعیت در حال انجام (جلوگیری از کلیک مکرر) */
(function () {
	'use strict';
	var b = document.getElementById('emz-reconnect');
	if (!b) return;
	b.addEventListener('click', function (e) {
		if (b.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
		b.setAttribute('aria-disabled', 'true');
		b.textContent = 'در حال اتصال…';
		b.style.opacity = '.7';
	});
})();

/* همگام‌سازی دوطرفه: همگام‌سازی کامل با نوار پیشرفت، ارسال/دریافت فوری، دریافت مجدد کلید امضا */
(function () {
	'use strict';
	if (typeof EmzagarAdmin === 'undefined' || !EmzagarAdmin.sync) return;
	var wrap = document.getElementById('emz-sync');
	if (!wrap) return;
	var out = document.getElementById('emz-sync-result');
	var bar = document.getElementById('emz-progress-bar');
	var box = document.getElementById('emz-progress');
	var t = EmzagarAdmin.i18n || {};

	function call(op) {
		var body = new URLSearchParams({ action: 'emzagar_sync', nonce: EmzagarAdmin.sync, op: op });
		return fetch(EmzagarAdmin.ajax, { method: 'POST', credentials: 'same-origin', body: body }).then(function (r) { return r.json(); });
	}
	function paint(d) {
		if (!d) return;
		['sent', 'received', 'queue', 'cloudPending'].forEach(function (k) {
			var el = wrap.querySelector('[data-emz="' + k + '"]');
			if (el && d[k] !== undefined) el.textContent = d[k];
		});
		var lf = wrap.querySelector('[data-emz="lastFlush"]');
		if (lf && d.lastFlush) lf.textContent = d.lastFlush;
		var lp = wrap.querySelector('[data-emz="lastPull"]');
		if (lp && d.lastPull) lp.textContent = d.lastPull;
		if (bar) bar.style.width = (d.percent || 0) + '%';
	}
	function say(msg, ok) {
		if (!out) return;
		out.textContent = msg;
		out.style.color = ok === false ? '#b32d2e' : ok ? '#0a7a3d' : '';
	}
	function busy(on) {
		wrap.querySelectorAll('button').forEach(function (b) { b.disabled = on; });
	}

	function loop() {
		return call('backfill_step').then(function (j) {
			if (!j || !j.success) throw new Error((j && j.data && j.data.message) || '');
			paint(j.data);
			say(t.working + ' ' + j.data.done + ' / ' + (j.data.total || '…') + ' ' + (t.orders || ''));
			if (j.data.running) return loop();
			return j.data;
		});
	}

	var bf = document.getElementById('emz-backfill');
	if (bf) {
		bf.addEventListener('click', function () {
			busy(true);
			if (box) box.hidden = false;
			say(t.working);
			call('backfill_start')
				.then(function (j) {
					if (!j || !j.success) throw new Error((j && j.data && j.data.message) || '');
					paint(j.data);
					return j.data.running ? loop() : j.data;
				})
				.then(function () { return call('now'); })
				.then(function (j) { if (j && j.success) paint(j.data); say(t.done, true); })
				.catch(function (e) { say((e && e.message) || t.failed, false); })
				.then(function () { busy(false); });
		});
	}
	var now = document.getElementById('emz-sync-now');
	if (now) {
		now.addEventListener('click', function () {
			busy(true); say(t.working);
			call('now')
				.then(function (j) { if (!j || !j.success) throw new Error(''); paint(j.data); say('✓', true); })
				.catch(function () { say(t.failed, false); })
				.then(function () { busy(false); });
		});
	}
	var rot = document.getElementById('emz-sync-rotate');
	if (rot) {
		rot.addEventListener('click', function () {
			busy(true); say(t.working);
			call('rotate')
				.then(function (j) { if (!j || !j.success) throw new Error((j && j.data && j.data.message) || ''); paint(j.data); say('✓', true); })
				.catch(function (e) { say((e && e.message) || t.failed, false); })
				.then(function () { busy(false); });
		});
	}
})();
