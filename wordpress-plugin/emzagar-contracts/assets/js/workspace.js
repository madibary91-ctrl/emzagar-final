/* امضاگیر — میز کار قراردادها (کانبان، فهرست، کشوی جزئیات، صدور) — بدون وابستگی؛ همه‌ی متن‌ها با textContent (ضد XSS) */
(function () {
	'use strict';
	if (typeof EmzagarWS === 'undefined') return;
	var T = EmzagarWS.t;
	var drawer = document.getElementById('emz-ws-drawer');
	var drawerBody = document.getElementById('emz-ws-drawer-body');
	var flashBox = document.getElementById('emz-ws-flash');
	var lastFocus = null;

	/* ───── ابزارها ───── */
	function h(tag, attrs, kids) {
		var el = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (k) {
				var v = attrs[k];
				if (v === null || v === undefined || v === false) return;
				if (k === 'class') el.className = v;
				else if (k === 'text') el.textContent = v;
				else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
				else el.setAttribute(k, v === true ? '' : v);
			});
		}
		(kids || []).forEach(function (c) {
			if (c === null || c === undefined || c === false) return;
			el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		});
		return el;
	}
	function clear(el) {
		while (el && el.firstChild) el.removeChild(el.firstChild);
	}
	function num(v) {
		return Number(v || 0).toLocaleString('fa-IR');
	}
	function when(iso) {
		if (!iso) return '—';
		var d = new Date(iso);
		if (isNaN(d.getTime())) return '—';
		try {
			return d.toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
		} catch (e) {
			return d.toLocaleString();
		}
	}
	function ajax(action, data) {
		var body = new URLSearchParams(Object.assign({ action: 'emzagar_ws_' + action, nonce: EmzagarWS.nonce }, data || {}));
		return fetch(EmzagarWS.ajax, { method: 'POST', credentials: 'same-origin', body: body })
			.then(function (r) {
				return r.json();
			})
			.then(function (j) {
				if (!j || !j.success) {
					var err = new Error((j && j.data && j.data.message) || T.error);
					err.code = j && j.data && j.data.code;
					throw err;
				}
				return j.data;
			});
	}
	function flash(msg, type) {
		if (!flashBox) return;
		flashBox.hidden = false;
		flashBox.className = 'emz-ws-flash is-' + (type || 'ok');
		flashBox.textContent = msg;
		clearTimeout(flash.t);
		flash.t = setTimeout(function () {
			flashBox.hidden = true;
		}, 7000);
	}
	function chip(status) {
		var labels = { sent: 'در انتظار امضا', signed: 'امضاشده', rejected: 'ردشده', expired: 'منقضی', cancelled: 'لغوشده', viewed: 'مشاهده‌شده' };
		return h('span', { class: 'emz-st emz-st-' + status, text: labels[status] || status });
	}
	function debounce(fn, ms) {
		var t;
		return function () {
			var a = arguments;
			clearTimeout(t);
			t = setTimeout(function () {
				fn.apply(null, a);
			}, ms);
		};
	}

	/* ───── کانبان ───── */
	function renderBoard(data) {
		var board = document.getElementById('emz-ws-board');
		clear(board);
		board.removeAttribute('aria-busy');
		data.stages.forEach(function (st) {
			var col = h('section', { class: 'emz-col emz-col-' + st.key }, [
				h('header', null, [h('b', { text: st.label }), h('span', { class: 'emz-col-n', text: num(st.count) }), st.value ? h('small', { text: num(st.value) + ' ' + T.toman }) : null]),
			]);
			var list = h('div', { class: 'emz-col-list' });
			if (!st.items.length) list.appendChild(h('p', { class: 'emz-col-empty', text: T.empty }));
			st.items.forEach(function (c) {
				var meta = [];
				meta.push(h('span', { text: c.customer || c.email }));
				if (c.value) meta.push(h('span', { text: num(c.value) + ' ' + T.toman }));
				var warn = null;
				if (c.expiresInHours !== null && c.expiresInHours !== undefined) {
					if (c.expiresInHours <= 0) warn = h('span', { class: 'emz-warn', text: T.expired });
					else if (c.expiresInHours <= 48) warn = h('span', { class: 'emz-warn', text: T.expSoon });
				}
				var card = h(
					'button',
					{
						type: 'button',
						class: 'emz-card',
						onclick: function () {
							openDrawer(c.id);
						},
					},
					[h('b', { text: c.title }), h('small', { text: c.number + ' • ' + num(c.ageDays) + ' ' + T.ageDays }), h('div', { class: 'emz-card-meta' }, meta), warn]
				);
				list.appendChild(card);
			});
			if (st.count > st.items.length) {
				list.appendChild(
					h('a', { class: 'emz-col-more', href: '#', onclick: function (e) { e.preventDefault(); location.href = location.pathname + '?page=emzagar-workspace&tab=list' + (st.key === 'signed' || st.key === 'rejected' ? '&status=' + st.key : ''); } , text: '+ ' + num(st.count - st.items.length) + ' ' + T.more })
				);
			}
			col.appendChild(list);
			board.appendChild(col);
		});
	}
	function loadBoard() {
		var board = document.getElementById('emz-ws-board');
		if (!board) return;
		if (!board.firstChild) board.appendChild(h('p', { text: T.loading }));
		ajax('pipeline')
			.then(renderBoard)
			.catch(function (e) {
				clear(board);
				board.appendChild(h('p', { class: 'emz-h-empty', text: e.message }));
			});
	}

	/* ───── فهرست ───── */
	var listState = { page: 1, status: '', q: EmzagarWS.q || '' };
	function loadList() {
		var box = document.getElementById('emz-ws-list');
		if (!box) return;
		box.setAttribute('aria-busy', 'true');
		ajax('list', { page: listState.page, status: listState.status, q: listState.q })
			.then(function (d) {
				clear(box);
				box.removeAttribute('aria-busy');
				if (!d.items.length) {
					box.appendChild(h('p', { class: 'emz-h-empty', text: T.empty }));
				} else {
					var tb = h('tbody');
					d.items.forEach(function (c) {
						tb.appendChild(
							h('tr', null, [
								h('td', null, [h('a', { href: '#', onclick: function (e) { e.preventDefault(); openDrawer(c.id); }, text: c.title }), h('br'), h('small', { text: c.number })]),
								h('td', { text: (c.customer && (c.customer.name || c.customer.email)) || '' }),
								h('td', null, [chip(c.status)]),
								h('td', { text: c.value ? num(c.value) : '—' }),
								h('td', { text: when(c.issuedAt) }),
								h('td', null, [h('button', { type: 'button', class: 'button button-small', onclick: function () { openDrawer(c.id); }, text: '⋯' })]),
							])
						);
					});
					box.appendChild(
						h('table', { class: 'widefat striped' }, [
							h('thead', null, [h('tr', null, ['قرارداد', 'مشتری', 'وضعیت', 'ارزش (تومان)', 'تاریخ صدور', ''].map(function (t) { return h('th', { text: t }); }))]),
							tb,
						])
					);
				}
				var pg = document.getElementById('emz-ws-pager');
				clear(pg);
				var pages = Math.max(1, Math.ceil(d.total / d.limit));
				if (pages > 1) {
					pg.appendChild(h('button', { type: 'button', class: 'button', disabled: d.page <= 1, onclick: function () { listState.page--; loadList(); }, text: T.prev }));
					pg.appendChild(h('span', { text: num(d.page) + ' / ' + num(pages) + ' (' + num(d.total) + ')' }));
					pg.appendChild(h('button', { type: 'button', class: 'button', disabled: d.page >= pages, onclick: function () { listState.page++; loadList(); }, text: T.nextPage }));
				}
			})
			.catch(function (e) {
				clear(box);
				box.appendChild(h('p', { class: 'emz-h-empty', text: e.message }));
			});
	}
	function initList() {
		var q = document.getElementById('emz-ws-q');
		var s = document.getElementById('emz-ws-status');
		if (!q || !s) return;
		q.value = listState.q;
		var qs = new URLSearchParams(location.search).get('status');
		if (qs) {
			s.value = qs;
			listState.status = s.value;
		}
		q.addEventListener('input', debounce(function () { listState.q = q.value.trim(); listState.page = 1; loadList(); }, 350));
		s.addEventListener('change', function () { listState.status = s.value; listState.page = 1; loadList(); });
		loadList();
	}

	/* ───── کشوی جزئیات ───── */
	function closeDrawer() {
		if (!drawer) return;
		drawer.classList.remove('is-open');
		drawer.hidden = true;
		drawer.setAttribute('aria-hidden', 'true');
		document.body.classList.remove('emz-lock');
		if (lastFocus && lastFocus.focus) lastFocus.focus();
	}
	function openDrawer(id) {
		id = parseInt(id, 10);
		if (!drawer || !id || id < 1) return; // هرگز کشوی بدون قرارداد باز نشود
		lastFocus = document.activeElement;
		drawer.hidden = false;
		drawer.classList.add('is-open');
		drawer.setAttribute('aria-hidden', 'false');
		document.body.classList.add('emz-lock');
		clear(drawerBody);
		drawerBody.appendChild(h('p', { text: T.loading }));
		var x = drawer.querySelector('.emz-drawer-x');
		if (x) x.focus();
		ajax('detail', { id: id })
			.then(function (d) {
				if (!d || !d.contract) throw new Error(T.error);
				renderDetail(d.contract);
			})
			.catch(function (e) {
				clear(drawerBody);
				drawerBody.appendChild(h('p', { class: 'emz-h-empty', text: e.message || T.error }));
			});
	}
	function renderDetail(c) {
		clear(drawerBody);
		var acts = [];
		if (c.canRemind) {
			acts.push(
				h('button', {
					type: 'button',
					class: 'button button-primary',
					text: T.remind,
					onclick: function (e) {
						var b = e.currentTarget;
						b.disabled = true;
						ajax('remind', { id: c.id })
							.then(function () { flash(T.reminded); b.textContent = T.reminded; })
							.catch(function (er) { flash(er.message, 'err'); b.disabled = false; });
					},
				})
			);
		}
		if (c.signUrl) {
			acts.push(
				h('button', {
					type: 'button',
					class: 'button',
					text: T.copy,
					onclick: function (e) {
						var b = e.currentTarget;
						var done = function () { b.textContent = T.copied; };
						if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(c.signUrl).then(done, function () { window.prompt(T.signLink, c.signUrl); });
						else window.prompt(T.signLink, c.signUrl);
					},
				})
			);
		}
		if (c.canDownload) acts.push(h('a', { class: 'button button-primary', href: EmzagarWS.pdf + '&id=' + encodeURIComponent(c.id), text: T.pdf }));
		if (c.links && c.links.order) acts.push(h('a', { class: 'button', href: c.links.order, text: T.order }));
		if (c.links && c.links.user) acts.push(h('a', { class: 'button', href: c.links.user, text: T.user }));
		if (c.canCancel) {
			acts.push(
				h('button', {
					type: 'button',
					class: 'button button-link-delete',
					text: T.cancel,
					onclick: function () {
						if (!window.confirm(T.cancelAsk)) return;
						ajax('cancel', { id: c.id })
							.then(function () { flash(T.cancelled); closeDrawer(); loadBoard(); loadList(); })
							.catch(function (er) { flash(er.message, 'err'); });
					},
				})
			);
		}
		var info = [
			['', c.customer.name + (c.customer.email ? ' — ' + c.customer.email : '')],
			[T.issued, when(c.issuedAt)],
			[T.expires, c.expiresAt ? when(c.expiresAt) : '—'],
			[T.value, c.value ? num(c.value) + ' ' + T.toman : '—'],
		];
		if (c.nextSigner) info.push([T.next, c.nextSigner.label + (c.nextSigner.name ? ' — ' + c.nextSigner.name : '')]);
		var dl = h('dl', { class: 'emz-dl' });
		info.forEach(function (r) {
			if (r[0]) dl.appendChild(h('dt', { text: r[0] }));
			dl.appendChild(h('dd', { text: r[1] }));
		});
		var signers = h('ul', { class: 'emz-signers' });
		c.signers.forEach(function (s) {
			signers.appendChild(h('li', { class: 'is-' + s.status }, [h('b', { text: s.label }), ' ', h('span', { text: s.name }), ' ', h('small', { text: s.status === 'signed' ? T.signed + ' • ' + when(s.signedAt) : s.status === 'rejected' ? T.rejected : T.pending })]));
		});
		var tl = h('ol', { class: 'emz-timeline' });
		c.timeline.forEach(function (t) {
			tl.appendChild(h('li', null, [h('b', { text: t.label }), ' ', h('small', { text: when(t.at) }), t.detail ? h('div', { class: 'emz-tl-d', text: t.detail }) : null]));
		});
		drawerBody.appendChild(h('h2', { text: c.title }));
		drawerBody.appendChild(h('p', { class: 'emz-drawer-sub' }, [chip(c.status), ' ', h('code', { text: c.number })]));
		drawerBody.appendChild(h('div', { class: 'emz-acts' }, acts));
		drawerBody.appendChild(dl);
		drawerBody.appendChild(h('h3', { text: T.signers }));
		drawerBody.appendChild(signers);
		drawerBody.appendChild(h('h3', { text: T.timeline }));
		drawerBody.appendChild(tl);
	}
	if (drawer) {
		// وضعیت آغازین و بازگشت از bfcache: کشو همیشه بسته است مگر اینکه صراحتاً باز شود
		closeDrawer();
		window.addEventListener('pageshow', function (ev) { if (ev.persisted && drawer.classList.contains('is-open') === false) closeDrawer(); });
		drawer.addEventListener('click', function (e) {
			if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-emz-close')) closeDrawer();
		});
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && !drawer.hidden) closeDrawer();
		});
	}

	/* ───── صدور قرارداد ───── */
	function initIssue() {
		var form = document.getElementById('emz-ws-issue');
		if (!form) return;
		var out = document.getElementById('emz-f-result');
		var btn = document.getElementById('emz-f-submit');
		form.addEventListener('submit', function (e) {
			e.preventDefault();
			clear(out);
			if (!form.template.value) {
				flash(T.tplRequired, 'err');
				return;
			}
			btn.disabled = true;
			btn.textContent = T.issuing;
			ajax('issue', { template: form.template.value, name: form.name.value, email: form.email.value, mobile: form.mobile.value, title: form.title.value, expiry: form.expiry.value })
				.then(function (d) {
					flash(T.issueOk);
					out.appendChild(h('div', { class: 'notice notice-success inline' }, [h('p', { text: T.issueOk })]));
					if (d.signUrl) out.appendChild(h('p', null, [h('b', { text: T.signLink + ': ' }), h('input', { type: 'text', readonly: true, class: 'large-text', dir: 'ltr', value: d.signUrl, onclick: function (ev) { ev.target.select(); } })]));
					if (d.id) out.appendChild(h('p', null, [h('a', { class: 'button', href: '#', onclick: function (ev) { ev.preventDefault(); openDrawer(d.id); }, text: T.openList })]));
				})
				.catch(function (er) {
					flash(er.message, 'err');
					out.appendChild(h('div', { class: 'notice notice-error inline' }, [h('p', { text: er.message })]));
				})
				.then(function () {
					btn.disabled = false;
					btn.textContent = 'صدور و ارسال برای مشتری';
				});
		});
		// جستجوی کاربران وردپرس
		var find = document.getElementById('emz-f-find');
		var ul = document.getElementById('emz-f-people');
		if (!find || !ul) return;
		find.addEventListener(
			'input',
			debounce(function () {
				var q = find.value.trim();
				clear(ul);
				if (q.length < 2) { ul.hidden = true; return; }
				ajax('people', { q: q })
					.then(function (d) {
						clear(ul);
						ul.hidden = false;
						if (!d.items.length) ul.appendChild(h('li', { class: 'is-empty', text: T.noMatches }));
						d.items.forEach(function (p) {
							ul.appendChild(
								h('li', null, [
									h('button', {
										type: 'button',
										onclick: function () {
											form.name.value = p.name || '';
											form.email.value = p.email || '';
											form.mobile.value = p.mobile || '';
											ul.hidden = true;
											find.value = '';
										},
									}, [h('b', { text: p.name }), ' ', h('small', { text: p.email + (p.mobile ? ' • ' + p.mobile : '') })]),
								])
							);
						});
					})
					.catch(function () { ul.hidden = true; });
			}, 250)
		);
	}

	/* ───── راه‌اندازی ───── */
	loadBoard();
	if (document.getElementById('emz-ws-board')) {
		setInterval(function () { if (!document.hidden && (!drawer || drawer.hidden)) loadBoard(); }, 60000);
	}
	initList();
	initIssue();
	if (EmzagarWS.open) openDrawer(EmzagarWS.open);
})();
