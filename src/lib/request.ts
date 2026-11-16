import net from "node:net";
import { headers } from "next/headers";
import { bootstrapOriginFromHeaders, resolveTrustedOrigin } from "@/lib/origin";
import { PEER_IP_HEADER } from "@/lib/peer-ip";
import { isPrivateIp } from "@/lib/ssrf";

/**
 * تعداد پراکسی‌های مورد اعتماد پیش روی برنامه (TRUSTED_PROXY_HOPS).
 *  - تنظیم‌نشده  → ۱ (استقرار استاندارد: Caddy/Nginx جلوی برنامه) — اما «حالت خودکار» (H-04): اگر آدرس واقعی سوکت
 *                  عمومی (غیرخصوصی) باشد، یعنی اتصال مستقیم از اینترنت است و هدرهای forwarded نادیده گرفته می‌شوند
 *  - ۰           → «هیچ پراکسی مورد اعتماد نیست»: X-Forwarded-For / X-Real-IP نادیده؛ IP همان آدرس واقعی سوکت است
 *  - ۱..۱۰       → همان تعداد
 *  - مقدار نامعتبر → ۰ (fail-closed؛ هدر جعلی هرگز پذیرفته نمی‌شود)
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 1;
  if (!/^\d{1,2}$/.test(raw.trim())) return 0;
  return Math.min(10, Number(raw.trim()));
}

const hopsConfigured = () => (process.env.TRUSTED_PROXY_HOPS ?? "").trim() !== "";

/** یک عنصر X-Forwarded-For را به IP خالص تبدیل می‌کند (حذف پورت و براکت)؛ نامعتبر = "" */
function parseIp(token: string): string {
  let t = token.trim();
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(t);
  if (bracket) t = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(t)) t = t.slice(0, t.lastIndexOf(":"));
  t = t.replace(/^::ffff:(?=\d)/i, ""); // IPv4-mapped IPv6 ⇒ IPv4 (یک کلید برای یک کلاینت)
  return net.isIP(t) ? t : "";
}

/** آدرس واقعی سوکت که قلاب سرور (lib/peer-ip.ts) نوشته است؛ ""= نامعلوم (مثلاً آزمون یا سوکت یونیکس) */
export function peerIpFrom(get: (name: string) => string | null): string {
  const raw = (get(PEER_IP_HEADER) || "").trim();
  const t = raw.replace(/^::ffff:(?=\d)/i, "").replace(/%.*$/, "");
  return net.isIP(t) ? t : "";
}

/**
 * IP کلاینت. چپ‌ترین عنصر X-Forwarded-For را خود کلاینت می‌تواند جعل کند، پس از «سمت راست» می‌خوانیم:
 * فقط عنصری که n-امین پراکسی مورد اعتماد افزوده معتبر است.
 * H-04: به‌جای «unknown» مشترک (که یک سطل جهانی می‌سازد)، هر جا ممکن باشد آدرس واقعی سوکت برگردانده می‌شود:
 *   • hops=0 یا مقدار نامعتبر ⇒ آدرس سوکت؛
 *   • تنظیم‌نشده و سوکت عمومی ⇒ اتصال مستقیم است؛ هدر forwarded جعلی و نادیده گرفته می‌شود؛
 *   • زنجیره‌ی کوتاه/نامعتبر ⇒ آدرس سوکت.
 * فقط وقتی هیچ منبع قابل اعتمادی نباشد "unknown" برمی‌گردد (و rateLimit برای آن سقف جهانی جداگانه دارد).
 */
export function clientIpFrom(get: (name: string) => string | null): string {
  const peer = peerIpFrom(get);
  const hops = trustedProxyHops();
  if (hops === 0) return peer || "unknown";
  if (!hopsConfigured() && peer && !isPrivateIp(peer)) return peer;
  const fwd = get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
    // زنجیره کوتاه‌تر از تعداد پراکسی‌های مورد اعتماد = درخواست از مسیر پراکسی نگذشته؛ مقدار جعلی است
    if (parts.length < hops) return peer || "unknown";
    return parseIp(parts[parts.length - hops]) || peer || "unknown";
  }
  return parseIp(get("x-real-ip") || "") || peer || "unknown";
}

export async function getRequestInfo(): Promise<{ ip: string; userAgent: string }> {
  const h = await headers();
  const ip = clientIpFrom((n) => h.get(n));
  const userAgent = (h.get("user-agent") || "unknown").slice(0, 500);
  return { ip, userAgent };
}

/**
 * آدرس پایه‌ی مورد اعتماد برای ساخت لینک‌های مطلق (ایمیل، پرداخت، QR).
 * هیچ‌گاه از هدرهای Host / X-Forwarded-Host «بدون اعتماد» ساخته نمی‌شود؛ منطق در lib/origin.ts است.
 * اگر منبع معتبری نباشد رشته‌ی خالی برمی‌گردد.
 */
export async function getOrigin(): Promise<string> {
  const h = await headers();
  return resolveTrustedOrigin((n) => h.get(n));
}

/** فقط برای نصب‌کننده‌ی وب (پشت کلید نصب): آدرس سایت را از هدر Host می‌خواند و ریشه‌ی اعتماد می‌شود */
export async function getBootstrapOrigin(): Promise<string> {
  const h = await headers();
  return bootstrapOriginFromHeaders((n) => h.get(n));
}
