/* امضاگیر — اعلان زنده (Heartbeat): امضای مشتری بدون رفرش در همه‌ی صفحه‌های پیشخوان */
(function ($) {
	'use strict';
	if (typeof EmzagarInbox === 'undefined' || !$ || !$(document).on) return;

	var lastId = parseInt(EmzagarInbox.lastId, 10) || 0;

	function toast(item) {
		var host = document.getElementById('emz-toasts');
		if (!host) {
			host = document.createElement('div');
			host.id = 'emz-toasts';
			host.setAttribute('role', 'status');
			host.setAttribute('aria-live', 'polite');
			document.body.appendChild(host);
		}
		var a = document.createElement('a');
		a.className = 'emz-toast';
		a.href = item.cid ? EmzagarInbox.base + '&contract=' + encodeURIComponent(item.cid) : EmzagarInbox.open;
		var ico = document.createElement('span');
		ico.className = 'emz-toast-ico';
		ico.textContent = item.icon || '•';
		var box = document.createElement('div');
		var b = document.createElement('b');
		b.textContent = item.ti;
		var s = document.createElement('small');
		s.textContent = item.tx;
		box.appendChild(b);
		box.appendChild(document.createElement('br'));
		box.appendChild(s);
		a.appendChild(ico);
		a.appendChild(box);
		host.appendChild(a);
		setTimeout(function () {
			a.classList.add('is-out');
			setTimeout(function () {
				if (a.parentNode) a.parentNode.removeChild(a);
			}, 400);
		}, 9000);
	}

	function setBadge(unread, pending) {
		var c = document.querySelector('#wp-admin-bar-emzagar-feed .emz-feed-count');
		if (c) {
			c.textContent = String(unread);
			c.classList.toggle('is-zero', !unread);
		}
		if (pending !== null && pending !== undefined) {
			var p = document.querySelector('#wp-admin-bar-emzagar-hub .emz-pill');
			if (p) {
				p.textContent = String(pending);
				p.classList.toggle('is-zero', !pending);
			}
		}
	}

	$(document).on('heartbeat-send', function (e, data) {
		data.emz_feed = lastId;
	});

	$(document).on('heartbeat-tick', function (e, data) {
		var f = data && data.emz_feed;
		if (!f) return;
		lastId = parseInt(f.lastId, 10) || lastId;
		setBadge(f.unread || 0, f.pending);
		(f.items || []).forEach(toast);
	});
})(window.jQuery);
