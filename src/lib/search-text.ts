/**
 * یکسان‌سازی متن جستجو برای کاربر ایرانی (فایل خالص؛ هم در سرور و هم در کلاینت قابل استفاده است).
 *
 * مشکل واقعی: کاربر «۱۴۰۴» یا «علي» (ي/ك عربی کیبورد موبایل) تایپ می‌کند، اما عنوان/شماره با ارقام لاتین
 * یا «ی/ک» فارسی ذخیره شده است؛ جستجو بی‌صدا «چیزی پیدا نشد» می‌داد.
 */
const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

/** ارقام فارسی/عربی → لاتین */
function toAsciiDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));
}

/** ي/ى/ك/ة/ۀ → ی/ی/ک/ه/ه */
function toPersianLetters(s: string): string {
  return s.replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/[ةۀ]/g, "ه");
}

/** متن «تاشده» برای مقایسه: حروف کوچک، ارقام لاتین، ی/ک فارسی، بدون کشیده و اعراب، نیم‌فاصله ← فاصله */
export function foldSearch(raw: unknown): string {
  return toPersianLetters(toAsciiDigits(String(raw ?? "")))
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[\u200c\u200d\u200e\u200f\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** واژه‌های جستجو (همه‌ی واژه‌ها باید پیدا شوند) */
export function searchTokens(raw: unknown): string[] {
  const f = foldSearch(raw);
  return f ? f.split(" ").slice(0, 8) : [];
}

/** آیا همه‌ی واژه‌های `needle` در `haystack` (هر ترکیبی از فیلدها) هستند؟ خالی ⇒ true */
export function matchesSearch(haystack: unknown, needle: unknown): boolean {
  const tokens = searchTokens(needle);
  if (tokens.length === 0) return true;
  const h = foldSearch(haystack);
  return tokens.every((t) => h.includes(t));
}

/**
 * گونه‌های ممکن یک عبارت برای ILIKE در دیتابیس (که متن را «تا» نمی‌کند):
 * {ارقام لاتین / فارسی} × {ی‌ک فارسی / ي‌ك عربی} ← حداکثر ۵ گونه‌ی یکتا.
 */
export function searchVariants(raw: unknown): string[] {
  const base = String(raw ?? "").replace(/[\u200c\u200d]/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return [];
  const fa = toPersianLetters(toAsciiDigits(base));
  const withFaDigits = fa.replace(/[0-9]/g, (d) => FA[Number(d)]);
  const toArabic = (s: string) => s.replace(/ی/g, "ي").replace(/ک/g, "ك");
  return [...new Set([base, fa, withFaDigits, toArabic(fa), toArabic(withFaDigits)])].slice(0, 5);
}
