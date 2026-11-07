/** قواعد احراز هویت (KYC) — بدون وابستگی به سرور؛ در کلاینت هم قابل استفاده */

/** آستانه‌ی پیش‌فرض ارزش قرارداد (تومان) که صدور آن نیاز به احراز هویت دارد */
export const DEFAULT_KYC_THRESHOLD = 100_000_000;
export const KYC_MAX_FILE_BYTES = 5 * 1024 * 1024;

export type KycDocKind = "national_front" | "national_back" | "selfie" | "other";
export const KYC_DOC_KINDS: { kind: KycDocKind; field: string; label: string; hint: string; required: boolean }[] = [
  { kind: "national_front", field: "front", label: "روی کارت ملی", hint: "عکس واضح و کامل، بدون بازتاب نور", required: true },
  { kind: "national_back", field: "back", label: "پشت کارت ملی", hint: "اختیاری ولی تسریع‌کننده‌ی بررسی", required: false },
  { kind: "selfie", field: "selfie", label: "عکس سلفی با کارت ملی", hint: "چهره و کارت ملی در یک عکس", required: true },
  { kind: "other", field: "other", label: "مدرک تکمیلی (اختیاری)", hint: "مثلاً روزنامه‌ی رسمی یا جواز کسب (تصویر یا PDF)", required: false },
];
export const KYC_DOC_LABEL: Record<string, string> = Object.fromEntries(KYC_DOC_KINDS.map((d) => [d.kind, d.label]));

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";
/** تبدیل ارقام فارسی/عربی به لاتین */
export const toLatinDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)));

/** اعتبارسنجی کد ملی ایران (۱۰ رقم + رقم کنترل) */
export function isValidNationalCode(raw: string): boolean {
  const code = toLatinDigits(String(raw || "").trim());
  if (!/^\d{10}$/.test(code)) return false;
  if (/^(\d)\1{9}$/.test(code)) return false;
  const sum = code
    .slice(0, 9)
    .split("")
    .reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
  const r = sum % 11;
  const check = r < 2 ? r : 11 - r;
  return check === Number(code[9]);
}

export const normalizeNationalCode = (raw: string) => toLatinDigits(String(raw || "").trim());

/** نمایش ماسک‌شده: فقط ۳ رقم آخر */
export const maskNationalCode = (code: string) => (code.length >= 10 ? `${"•".repeat(7)}${code.slice(-3)}` : "•".repeat(10));

export const KYC_STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  none: { label: "ارسال نشده", cls: "bg-stone-100 text-ink/75" },
  pending: { label: "در انتظار بررسی", cls: "bg-amber-50 text-amber-800" },
  approved: { label: "تایید شده", cls: "bg-emerald-50 text-emerald-700" },
  rejected: { label: "رد شده", cls: "bg-red-50 text-red-700" },
};
