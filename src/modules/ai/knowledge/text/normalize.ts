/* ───────────── نرمال‌سازی فارسی ───────────── */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** ارقام فارسی/عربی → لاتین (یک‌به‌یک؛ طول رشته تغییر نمی‌کند) */
export function asciiDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (d) => {
    const i = FA_DIGITS.indexOf(d);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(d));
  });
}
/** یکسان‌سازی ي/ك عربی، حذف اعراب و کشیده */
export function normalizeFa(s: string): string {
  return s
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ۀ/g, "ه")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "");
}
/** پاک‌سازی متن خام: نویسه‌های کنترلی/جهت، فاصله‌های اضافه (ساختار پاراگراف حفظ می‌شود) */
export function cleanText(raw: string): string {
  return normalizeFa(raw)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
