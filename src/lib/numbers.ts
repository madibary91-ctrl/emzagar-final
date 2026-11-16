/**
 * ورودی‌های عددی «کاربرپسند»: کاربر ایرانی با کیبورد فارسی ارقام فارسی/عربی تایپ می‌کند (۳۰، ٣٠)،
 * جداکننده‌ی هزارگان فارسی/انگلیسی (٬ , ،) می‌گذارد یا فاصله‌ی اضافه دارد. `Number("۳۰")` برابر NaN است و فرم‌های قدیمی
 * این را بی‌صدا به «پیش‌فرض/بدون انقضا/خالی» تبدیل می‌کردند. اینجا همه‌چیز یک‌جا و با پیام خطای روشن نرمال می‌شود.
 *
 * فایل خالص است (بدون وابستگی به سرور) و در کلاینت هم قابل استفاده است.
 */
const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";

/** ارقام فارسی/عربی → لاتین، جداکننده‌ی اعشار فارسی (٫) → «.»، حذف جداکننده‌ی هزارگان و فاصله‌ها (شامل نیم‌فاصله و NBSP) */
export function normalizeDigits(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/[,٬،\s\u200c\u200f\u200e\u00a0]/g, "")
    .trim();
}

export type LooseInt = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * عدد صحیح از ورودی کاربر.
 *  - خالی ⇒ `{ ok: true, value: null }` (فراخواننده تصمیم می‌گیرد پیش‌فرض چیست)
 *  - نامعتبر / اعشاری / خارج از بازه ⇒ خطای فارسی با نام فیلد (به‌جای نادیده‌گرفتن بی‌صدا)
 */
export function parseLooseInt(raw: unknown, opts: { label: string; min?: number; max?: number }): LooseInt {
  const s = normalizeDigits(raw);
  if (s === "") return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: `«${opts.label}» باید یک عدد صحیح باشد (مثلاً ۳۰)` };
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return { ok: false, error: `«${opts.label}» بیش از حد بزرگ است` };
  if (opts.min !== undefined && n < opts.min) return { ok: false, error: `«${opts.label}» نمی‌تواند کمتر از ${opts.min.toLocaleString("fa-IR")} باشد` };
  if (opts.max !== undefined && n > opts.max) return { ok: false, error: `«${opts.label}» نمی‌تواند بیشتر از ${opts.max.toLocaleString("fa-IR")} باشد` };
  return { ok: true, value: n };
}

/**
 * ورودی کد یک‌بارمصرف (OTP): ارقام فارسی/عربی → لاتین، حذف هر نویسه‌ی غیرعددی (فاصله، خط‌تیره، «٫»…)
 * و برش به سقف طول. برای `onChange` همه‌ی فیلدهای کد تأیید (F-18) تا کاربر با هر کیبوردی کد را بزند.
 */
export function sanitizeOtpInput(raw: unknown, max = 8): string {
  return normalizeDigits(raw).replace(/\D/g, "").slice(0, max);
}
