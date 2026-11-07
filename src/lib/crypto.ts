import crypto from "node:crypto";
import { getSecret } from "@/lib/secret";

/**
 * رمزنگاری متقارن (AES-256-GCM) برای اطلاعات محرمانه‌ی ذخیره‌شده در دیتابیس
 * (کلید هوش مصنوعی، رمز SMTP، کلید پیامک …). کلید از SESSION_SECRET مشتق می‌شود.
 * قالب خروجی:  enc:v1:<iv>.<tag>.<data>  (base64url)
 * مقدارهای قدیمی بدون پیشوند (متن ساده) هنگام خواندن همان‌طور برگردانده می‌شوند (سازگاری رو به عقب).
 */
const PREFIX = "enc:v1:";
const key = () => crypto.createHash("sha256").update(`emz-settings-v1:${getSecret()}`).digest();

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

/** خروجی ناموفق (کلید جلسه تغییر کرده یا داده خراب است) رشته‌ی خالی است، نه خطا */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const [iv, tag, data] = stored.slice(PREFIX.length).split(".");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

/** نمایش ماسک‌شده: فقط ۴ نویسه‌ی پایانی */
export function maskSecret(plain: string): string {
  if (!plain) return "";
  return plain.length <= 8 ? "••••••••" : `••••••••${plain.slice(-4)}`;
}
