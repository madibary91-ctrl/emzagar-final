
export type WorkspaceOption = { id: number; name: string; slug: string; owner: string; plan: string };

/** فقط ارقام فارسی/عربی → لاتین (فاصله‌ها حفظ می‌شوند تا جستجوی چندکلمه‌ای کار کند) */
const latin = (s: string) => s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
const fold = (s: string) =>
  latin(s)
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک");

/**
 * جستجوی فضای کاری برای مدیر کل: شناسه، نام، نشانی کوتاه (slug) یا ایمیل/نام مالک؛ فارسی‌دوست (ارقام و «ي/ك»).
 * پیش‌تر مدیر باید «شناسه‌ی عددی» فضای کاری را از جایی می‌دانست که در هیچ صفحه‌ای نمایش داده نمی‌شد.
 */
export function searchWorkspaces(list: WorkspaceOption[], query: string, limit = 8): WorkspaceOption[] {
  const q = fold(query).trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: [number, WorkspaceOption][] = [];
  for (const w of list) {
    const hay = fold(`${w.id} ${w.name} ${w.slug} ${w.owner}`);
    if (!terms.every((t) => hay.includes(t))) continue;
    const score = String(w.id) === q ? 0 : fold(w.name).startsWith(q) ? 1 : fold(w.name).includes(q) ? 2 : 3;
    scored.push([score, w]);
  }
  return scored.sort((a, b) => a[0] - b[0] || b[1].id - a[1].id).slice(0, limit).map((x) => x[1]);
}
