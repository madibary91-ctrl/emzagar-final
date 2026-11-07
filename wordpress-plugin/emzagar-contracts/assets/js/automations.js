/* امضاگیر — فرم ساخت قانون: برچسب فیلدها بر اساس کنش انتخاب‌شده تغییر می‌کند */
(function () {
	'use strict';
	if (typeof EmzagarAuto === 'undefined') return;
	var sel = document.getElementById('emz-r-act');
	if (!sel) return;
	var pl = document.getElementById('emz-r-p-l');
	var p2l = document.getElementById('emz-r-p2-l');
	var row = document.getElementById('emz-r-p2-row');
	function sync() {
		var h = EmzagarAuto.hints[sel.value] || { p: '', p2: '' };
		if (pl) pl.textContent = h.p || 'پارامتر';
		if (p2l) p2l.textContent = h.p2 || '';
		if (row) row.style.display = h.p2 ? '' : 'none';
	}
	sel.addEventListener('change', sync);
	sync();
})();
