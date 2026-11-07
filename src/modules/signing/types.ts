import { inspectPng, PNG_LIMITS } from "@/lib/png";

export interface ActionResult {
  ok: boolean;
  error?: string;
  seconds?: number;
  devCode?: string;
  /** کد تایید علاوه بر پیامک (یا به‌جای آن) به ایمیل هم ارسال شد */
  emailed?: boolean;
  /** پس از امضا: قرارداد کاملاً نهایی شد (همه‌ی طرف‌ها امضا کرده‌اند) */
  completed?: boolean;
}

/**
 * اعتبارسنجی تصویر امضا (data URL از نوع PNG).
 * فایل باید «ساختاراً» یک PNG سالم باشد (امضا، CRC، ترتیب تکه‌ها، ابعاد و اندازه‌ی بازشده‌ی IDAT)؛
 * فقط تطبیق چهار بایت اول کافی نیست و فایل ساختگی/بمب فشرده‌سازی می‌تواند هنگام ساخت PDF پروسه را بکشد (SEC-05).
 */
export function parseSignatureDataUrl(input: string | undefined): { buffer: Buffer } | { error: string } {
  // سقف طول پیش از اجرای regex: پایه‌ی۶۴ بیش از ~۹۴۰ هزار نویسه یعنی بزرگ‌تر از ۷۰۰ کیلوبایت
  if (typeof input !== "string" || input.length > 960_000) return { error: "حجم یا محتوای امضا معتبر نیست" };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input);
  if (!m) return { error: "امضا معتبر نیست" };
  const buffer = Buffer.from(m[1], "base64");
  if (buffer.length < 300 || buffer.length > PNG_LIMITS.maxBytes) return { error: "حجم یا محتوای امضا معتبر نیست" };
  if (buffer.subarray(0, 4).toString("hex") !== "89504e47") return { error: "فرمت امضا باید PNG باشد" };
  const check = inspectPng(buffer);
  if (!check.ok) return { error: "تصویر امضا معتبر نیست یا آسیب‌دیده است" };
  return { buffer };
}

export const devSecretsAllowed = () => process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_OTP === "1";
