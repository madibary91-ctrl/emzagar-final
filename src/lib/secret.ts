import { getConfig } from "@/lib/config";

const DEV_FALLBACK = "amzagir-dev-secret-change-me";

/**
 * کلید امضای نشست، کد OTP و لینک‌ها.
 * منبع: SESSION_SECRET (محیط) یا کلید تصادفی که نصب‌کننده‌ی وب هنگام نصب می‌سازد.
 * در production بدون کلید قوی، برنامه عمداً از کار می‌افتد (هیچ‌گاه با کلید پیش‌فرض اجرا نمی‌شود).
 */
export function getSecret(): string {
  const s = getConfig().sessionSecret;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("کلید امنیتی تنظیم نشده است. نصب‌کننده (/install) را کامل کنید یا SESSION_SECRET را مقدار دهید.");
  }
  return DEV_FALLBACK;
}
