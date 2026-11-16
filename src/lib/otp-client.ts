/**
 * U-01…U-05 — منبع واحد «ورودی کد تأیید» برای همه‌ی فرم‌های کلاینت (امضای مهمان، پنل امضا، کیف اسناد، اصلاحیه، ارسال سریع).
 *
 * ریشه‌ی باگ: هر فرم برای خودش `slice(0, 5)` و `code.length !== 5` داشت؛ در حالی که سرور (M-09) از ارتقا به بعد کد ۶ رقمی
 * (تا ۸ رقمی با OTP_DIGITS) می‌فرستد ⇒ کاربر هرگز نمی‌توانست رقم ششم را بزند و دکمه‌ی «تأیید» هیچ‌وقت فعال نمی‌شد.
 * اکنون هر فرم از همین ثابت‌ها استفاده می‌کند و قاعده‌ی کلاینت دقیقاً با `OTP_INPUT_RE` سرور یکی است (۵ تا ۸ رقم؛
 * ۵ فقط برای کدهای صادرشده پیش از ارتقا).
 */
import { OTP_INPUT_RE, MAX_OTP_DIGITS } from "@/lib/otp-digits";
import { sanitizeOtpInput } from "@/lib/numbers";

/** حداقل رقم قابل‌قبول برای فعال‌شدن دکمه (کدهای قدیمی ۵ رقمی هنوز معتبرند) */
export const OTP_MIN_ACCEPT = 5;
/** سقف ورودی؛ هرگز کمتر از طول واقعی کدی که سرور می‌فرستد نیست */
export const OTP_MAX_ACCEPT = MAX_OTP_DIGITS;
/** نمونه‌ی نمایشی (۶ نقطه: طول پیش‌فرض کد فعلی) */
export const OTP_PLACEHOLDER = "• • • • • •";

/** ورودی خام (فارسی/عربی/لاتین، با فاصله و خط‌تیره) ← ارقام لاتین تا سقف طول */
export function normalizeOtp(raw: unknown): string {
  return sanitizeOtpInput(raw, OTP_MAX_ACCEPT);
}

/** آیا کد برای ارسال به سرور کامل است؟ (همان قاعده‌ی سرور) */
export function isOtpComplete(code: string): boolean {
  return OTP_INPUT_RE.test(code);
}
