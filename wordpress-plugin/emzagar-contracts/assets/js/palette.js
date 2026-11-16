/* امضاگیر — پالت فرمان سراسری (Ctrl/⌘+K). همه‌ی خروجی‌ها با textContent؛ لینک‌ها فقط http(s) و هم‌مبدأ/معتبر */
(function () {
	'use strict';
	if (typeof EmzagarPalette === 'undefined') return;
	var T = EmzagarPalette.t;
	var root = null, input = null, list = null, foot = null;
	var remote = [];
	var sel = 0;
	var seq = 0;
	var timer;

	function norm(s) {
		return String(s || '').toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\u064B-\u065F]/g, '').trim();
	}
	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}
	function safeUrl(u) {
		try {
			var p = new URL(u, location.href);
			return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : '#';
		} catch (e) {
			return '#';
		}
	}
	function build() {
		root = el('div');
		root.id = 'emz-pal';
		root.hidden = true;
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', 'پالت فرمان');
		var box = el('div', 'emz-pal-box');
		input = el('input');
		input.type = 'search';
		input.placeholder = T.placeholder;
		input.setAttribute('aria-label', T.placeholder);
		input.autocomplete = 'off';
		list = el('ul', 'emz-pal-list');
		list.setAttribute('role', 'listbox');
		foot = el('div', 'emz-pal-foot', T.hint);
		box.appendChild(input);
		box.appendChild(list);
		box.appendChild(foot);
		root.appendChild(box);
		document.body.appendChild(root);
		root.addEventListener('mousedown', function (e) {
			if (e.target === root) close();
		});
		input.addEventListener('input', onInput);
		input.addEventListener('keydown', onKey);
	}
	function open() {
		if (!root) build();
		root.hidden = false;
		input.value = '';
		remote = [];
		sel = 0;
		render();
		input.focus();
	}
	function close() {
		if (root) root.hidden = true;
	}
	function visible() {
		var q = norm(input.value);
		var items = [];
		var cmds = EmzagarPalette.commands || [];
		if (!q) {
			// بدون عبارت: اقدام‌های سریع + چند صفحه‌ی اول
			items = cmds.filter(function (c) { return !c.n; }).slice(0, 12);
		} else {
			var words = q.split(/\s+/);
			items = cmds.filter(function (c) {
				var hay = norm(c.t + ' ' + c.s);
				return words.every(function (w) { return hay.indexOf(w) !== -1; });
			}).slice(0, 10);
		}
		return remote.concat(items);
	}
	function render(msg) {
		while (list.firstChild) list.removeChild(list.firstChild);
		var items = visible();
		if (sel >= items.length) sel = Math.max(0, items.length - 1);
		if (!items.length) {
			list.appendChild(el('li', 'emz-pal-empty', msg || T.empty));
			return;
		}
		var lastG = '';
		items.forEach(function (it, i) {
			if (it.g !== lastG) {
				lastG = it.g;
				list.appendChild(el('li', 'g', it.g));
			}
			var li = el('li');
			li.setAttribute('role', 'option');
			var a = el('a', i === sel ? 'is-on' : '');
			a.href = safeUrl(it.u);
			a.appendChild(el('span', '', (it.i || '') + ' ' + it.t));
			if (it.s) a.appendChild(el('small', '', it.s));
			a.addEventListener('mousemove', function () {
				if (sel !== i) { sel = i; mark(); }
			});
			li.appendChild(a);
			list.appendChild(li);
		});
	}
	function mark() {
		var as = list.querySelectorAll('a');
		Array.prototype.forEach.call(as, function (a, i) {
			a.className = i === sel ? 'is-on' : '';
			if (i === sel && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
		});
	}
	function onKey(e) {
		var as = list.querySelectorAll('a');
		if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(as.length - 1, sel + 1); mark(); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
		else if (e.key === 'Enter') { e.preventDefault(); if (as[sel]) { if (e.ctrlKey || e.metaKey) window.open(as[sel].href, '_blank'); else location.href = as[sel].href; } }
		else if (e.key === 'Escape') { e.preventDefault(); close(); }
	}
	function onInput() {
		sel = 0;
		clearTimeout(timer);
		var q = input.value.trim();
		if (!EmzagarPalette.live || q.length < 2) {
			remote = [];
			render();
			return;
		}
		render();
		var mine = ++seq;
		timer = setTimeout(function () {
			var body = new URLSearchParams({ action: 'emzagar_palette_search', nonce: EmzagarPalette.nonce, q: q });
			fetch(EmzagarPalette.ajax, { method: 'POST', credentials: 'same-origin', body: body })
				.then(function (r) { return r.json(); })
				.then(function (j) {
					if (mine !== seq) return;
					remote = j && j.success && j.data && j.data.items ? j.data.items : [];
					render();
				})
				.catch(function () { if (mine === seq) { remote = []; render(); } });
		}, 220);
	}

	document.addEventListener('keydown', function (e) {
		if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			if (root && !root.hidden) close();
			else open();
		}
	});
	document.addEventListener('click', function (e) {
		var t = e.target;
		while (t && t !== document) {
			if (t.id === 'wp-admin-bar-emzagar-search' || (t.getAttribute && t.getAttribute('href') === '#emzagar-palette')) {
				e.preventDefault();
				open();
				return;
			}
			t = t.parentNode;
		}
	});
})();
