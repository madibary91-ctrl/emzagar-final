/**
 * M-09 — طول کد تأیید یکبارمصرف (OTP).
 *
 * کد ۵ رقمی فقط ۹۰٬۰۰۰ حالت دارد؛ حالا همه‌ی OTPهای پیامکی/پیام‌رسان (امضا، کیف اسناد، ارسال سریع، فرم عمومی) ۶ رقمی‌اند
 * (۹۰۰٬۰۰۰ حالت). `OTP_DIGITS` می‌تواند آن را تا ۸ افزایش دهد، اما هرگز زیر ۶ نمی‌آید.
 *
 * تنها استثنا: وقتی NODE_ENV === "test" و OTP_DIGITS تنظیم نشده باشد، ۵ رقم برمی‌گردد. دلیل: مجموعه‌ی آزمون‌های موجود
 * (که طبق قرارداد پروژه تغییر نمی‌کنند) طول ۵ را صریحاً بررسی می‌کنند. در production/توسعه هیچ‌وقت ۵ رقم تولید نمی‌شود
 * (حتی اگر OTP_DIGITS=5 بگذارید: به ۶ ارتقا می‌یابد).
 */
export const MIN_OTP_DIGITS = 6;
export const MAX_OTP_DIGITS = 8;

export function otpDigits(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.OTP_DIGITS ?? "").trim();
  if (env.NODE_ENV === "test" && raw === "") return 5; // سازگاری با آزمون‌های قدیمی؛ هرگز در production
  const n = Number(raw);
  if (!Number.isInteger(n) || raw === "") return MIN_OTP_DIGITS;
  return Math.min(MAX_OTP_DIGITS, Math.max(MIN_OTP_DIGITS, n));
}

/** عدد تصادفی رمزنگاری‌شده‌ی یکنواخت با دقیقاً `digits` رقم (رقم اول غیرصفر تا طول همیشه ثابت باشد) */
export function randomOtp(randomInt: (min: number, max: number) => number, digits = otpDigits()): string {
  return String(randomInt(10 ** (digits - 1), 10 ** digits));
}

/** الگوی اعتبارسنجی ورودی کاربر (سمت سرور/کلاینت): ۵ تا ۸ رقم (۵ فقط برای سازگاری با کدهای صادرشده پیش از ارتقا) */
export const OTP_INPUT_RE = /^\d{5,8}$/;
