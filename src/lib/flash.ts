import crypto from "node:crypto";
import { getSecret } from "@/lib/secret";

/**
 * «پیام نتیجه‌ی پرداخت» امضاشده در آدرس بازگشت.
 *
 * مشکل قبلی: صفحه‌های مالی متن `?msg=` را مستقیم از آدرس نشان می‌دادند؛ هر کسی می‌توانست لینکی با دامنه‌ی واقعی بسازد که
 * «پرداخت با موفقیت انجام شد» (یا هر متن دلخواه دیگری) را با ظاهر رسمی سایت نشان دهد (جعل پیام/فیشینگ).
 * اکنون هر پیامی که سرور خودش می‌سازد با HMAC امضا می‌شود (`sig`) و صفحه فقط پیام امضاشده را نشان می‌دهد.
 */
export type FlashKind = "ok" | "error";
export type Flash = { pay: FlashKind; msg: string; pid?: number };
export type FlashParams = { pay?: string; msg?: string; pid?: string; sig?: string };

const sign = (pay: string, msg: string, pid: number | ""): string =>
  crypto.createHmac("sha256", getSecret()).update(`flash.v1\n${pay}\n${msg}\n${pid}`).digest("hex").slice(0, 32);

/** رشته‌ی query امضاشده (بدون `?`) */
export function flashQuery(pay: FlashKind, msg: string, pid?: number | null): string {
  const text = msg.slice(0, 240);
  const id = pid && Number.isInteger(pid) && pid > 0 ? pid : "";
  return `pay=${pay}&msg=${encodeURIComponent(text)}${id ? `&pid=${id}` : ""}&sig=${sign(pay, text, id)}`;
}

/** خواندن و راستی‌آزمایی پیام؛ بدون امضای معتبر `null` (هیچ متنی از آدرس نمایش داده نمی‌شود) */
export function readFlash(sp: FlashParams | undefined | null): Flash | null {
  if (!sp || (sp.pay !== "ok" && sp.pay !== "error")) return null;
  const msg = typeof sp.msg === "string" ? sp.msg : "";
  const sig = typeof sp.sig === "string" ? sp.sig : "";
  if (!msg || !sig || msg.length > 240) return null;
  const pidNum = sp.pid && /^\d{1,9}$/.test(sp.pid) ? Number(sp.pid) : "";
  const expect = sign(sp.pay, msg, pidNum);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { pay: sp.pay, msg, ...(pidNum ? { pid: pidNum } : {}) };
}

/**
 * اگر کاربر هنگام بازگشت از درگاه نشستش تمام شده باشد، پس از ورود به همان صفحه (با همان نتیجه) برمی‌گردد.
 * فقط مسیر داخلی و با نویسه‌های مجاز `safeNext` ساخته می‌شود.
 */
export function loginNextFor(path: string, sp: FlashParams): string {
  const f = readFlash(sp);
  const target = f ? `${path}?${flashQuery(f.pay, f.msg, f.pid)}` : path;
  return `/login?next=${encodeURIComponent(target)}`;
}
