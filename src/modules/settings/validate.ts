import { normalizeDigits } from "@/lib/numbers";
import type { SettingKey } from "./service";

/**
 * اعتبارسنجی «تنظیمات عمومی» (خالص و بدون وابستگی به سرور → قابل‌آزمون).
 * خطا = ذخیره انجام نمی‌شود؛ هشدار = ذخیره می‌شود ولی به مدیر گفته می‌شود چه چیزی ناقص است.
 * پیش‌تر هر مقداری (ایمیل نامعتبر، پورت فارسی «۴۶۵»، نام سایت خالی) بی‌صدا ذخیره می‌شد و خطا ماه‌ها بعد در ایمیل‌های نرسیده پیدا می‌شد.
 */
type Values = Partial<Record<SettingKey, string>>;
export type SettingsValidation = { ok: true; values: Values; warnings: string[] } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
export const isEmail = (v: string) => EMAIL_RE.test(v.trim());
/** «ایمیل» یا «نام <ایمیل>» */
export const isMailbox = (v: string) => {
  const t = v.trim();
  const m = /^[^<>]*<([^<>]+)>$/.exec(t);
  return isEmail(m ? m[1] : t);
};

const SMS_PROVIDERS = ["log", "kavenegar", "melipayamak"];

export function validateGeneralSettings(input: Values, current: Record<SettingKey, string>): SettingsValidation {
  const v: Values = { ...input };
  const warnings: string[] = [];
  const eff = (k: SettingKey) => (v[k] !== undefined ? (v[k] as string) : current[k]);

  if (v.site_name !== undefined) {
    if (!v.site_name.trim()) return { ok: false, error: "نام سایت نمی‌تواند خالی باشد (در ایمیل‌ها و صفحه‌ی امضا نمایش داده می‌شود)" };
    if (v.site_name.length > 80) return { ok: false, error: "نام سایت حداکثر ۸۰ نویسه می‌تواند باشد" };
  }
  if (v.admin_email && !isEmail(v.admin_email)) return { ok: false, error: "ایمیل مدیر معتبر نیست (مثال: admin@example.com)" };
  if (v.smtp_from && !isMailbox(v.smtp_from)) return { ok: false, error: "«ایمیل فرستنده» معتبر نیست (مثال: info@example.com یا «امضاگیر <info@example.com>»)" };
  if (v.sms_provider !== undefined && !SMS_PROVIDERS.includes(v.sms_provider)) return { ok: false, error: "سرویس‌دهنده‌ی پیامک نامعتبر است" };

  if (v.smtp_host) {
    // کاربران اغلب «smtp://host:587» یا «https://host» می‌چسبانند؛ فقط نام میزبان لازم است
    if (/[\s/@:]/.test(v.smtp_host) || v.smtp_host.length > 253) return { ok: false, error: "میزبان SMTP فقط باید نام میزبان باشد، بدون http://، بدون پورت و فاصله (مثال: smtp.example.com — پورت را در فیلد بعدی بنویسید)" };
  }
  if (v.smtp_port !== undefined) {
    const raw = normalizeDigits(v.smtp_port);
    if (raw === "") v.smtp_port = "587";
    else if (!/^\d{1,5}$/.test(raw)) return { ok: false, error: "پورت SMTP باید یک عدد باشد (۵۸۷ یا ۴۶۵)" };
    else v.smtp_port = String(Number(raw)); // «۴۶۵» فارسی بی‌صدا ۵۸۷ نمی‌شود
  }

  // ── هشدارهای ناقص‌بودن (ذخیره می‌شود) ──
  const sms = eff("sms_provider");
  if (sms === "kavenegar" && !eff("kavenegar_api_key")) warnings.push("کاوه‌نگار انتخاب شده ولی «کلید API» خالی است؛ تا تکمیل نشود پیامک‌ها فقط در لاگ ثبت می‌شوند و کد تأیید امضا به موبایل نمی‌رسد.");
  if (sms === "melipayamak" && (!eff("melipayamak_username") || !eff("melipayamak_password") || !eff("melipayamak_from"))) warnings.push("ملی‌پیامک انتخاب شده ولی نام کاربری، رمز یا شماره‌ی فرستنده کامل نیست؛ پیامک‌ها ارسال نمی‌شوند.");
  if (eff("smtp_host") && eff("smtp_user") && !eff("smtp_pass")) warnings.push("نام کاربری SMTP وارد شده ولی رمز عبور خالی است؛ احتمالاً ورود به سرور ایمیل رد می‌شود.");
  if (eff("smtp_host") && !eff("smtp_from") && !isEmail(eff("smtp_user"))) warnings.push("«ایمیل فرستنده» خالی است و نام کاربری هم ایمیل نیست؛ بعضی سرورها ایمیل را رد می‌کنند.");
  if (eff("smtp_host") && eff("smtp_port") === "465" ) warnings.push("پورت ۴۶۵ با SSL مستقیم کار می‌کند؛ اگر سرورتان STARTTLS می‌خواهد پورت ۵۸۷ را بزنید. با «ارسال ایمیل آزمایشی» مطمئن شوید.");
  if (!eff("smtp_host") && !process.env.SMTP_HOST) warnings.push("SMTP تنظیم نشده است؛ ایمیل‌ها (لینک امضا، بازیابی رمز، نسخه‌ی نهایی) فقط در لاگ ثبت می‌شوند و به کسی نمی‌رسند.");

  return { ok: true, values: v, warnings };
}
