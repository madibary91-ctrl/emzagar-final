import net from "node:net";

/**
 * S00-F06: هر کاربر IPv6 (خانگی/VPS) معمولاً یک بلوک /64 یعنی ۲^۶۴ آدرس دارد؛ سقفِ «به‌ازای IP» با چرخاندن آدرس
 * منبع کاملاً دور زده می‌شد (حدس رمز ورود/OTP/ثبت‌نام). برای «کلید شمارنده»، هر IPv6 داخل کلید به پیشوند /64 برمی‌گردد
 * (`v6/2001:db8:0:1`). IP ثبت‌شده در شواهد/ممیزی دست‌نخورده می‌ماند.
 *
 * چرا ثبت‌نام (registry) و نه تحلیل متن کلید؟ کلیدها با «:» ساخته می‌شوند و بخش‌های هگزمانند (شناسه‌ی ۴ رقمی، `bad`، `b`)
 * با آدرس IPv6 قاطی می‌شوند. تنها منبع IP برنامه `clientIpFrom` است؛ هر IPv6ای که تحویل می‌دهد اینجا ثبت می‌شود و فقط
 * «همان رشته‌ی دقیق» داخل کلید فشرده می‌شود (بدون ابهام). ثبت‌نشده (مثلاً پردازه‌ی دیگر) ⇒ رفتار قبلی، نه خطا.
 */
const MAX_SEEN = 20_000;
const seen = new Map<string, string>(); // آدرس IPv6 (همان متن تحویلی) → پیشوند /64

/** ۴ گروه‌ی اول (پیشوند /64) یک آدرس IPv6 معتبر، یا null */
export function ipv6Prefix64(addr: string): string | null {
  if (!net.isIPv6(addr)) return null;
  let a = addr.replace(/%.*$/, "").toLowerCase();
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a); // ::ffff:1.2.3.4 → دو گروه‌ی هگز
  if (v4) {
    const o = v4[1].split(".").map(Number);
    a = a.slice(0, a.length - v4[1].length) + (((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16));
  }
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return groups.slice(0, 4).map((g) => parseInt(g || "0", 16).toString(16)).join(":");
}

/** `clientIpFrom` هر IP تحویل‌شده را اینجا اعلام می‌کند (IPv4 و "unknown" بی‌اثرند) */
export function noteClientIp(ip: string): string {
  if (ip.length >= 3 && ip.includes(":") && !seen.has(ip)) {
    const p = ipv6Prefix64(ip);
    if (p) {
      if (seen.size >= MAX_SEEN) seen.delete(seen.keys().next().value as string);
      seen.set(ip, p);
    }
  }
  return ip;
}

export function canonicalRateKey(rawKey: string): string {
  if (seen.size === 0 || !rawKey.includes(":")) return rawKey;
  const parts = rawKey.split(":");
  if (parts.length < 3) return rawKey;
  // بلندترین زیرزنجیره‌ی پیوسته‌ی بخش‌ها که دقیقاً یکی از IPv6های ثبت‌شده است
  for (let len = Math.min(parts.length, 9); len >= 2; len--) {
    for (let i = 0; i + len <= parts.length; i++) {
      const p = seen.get(parts.slice(i, i + len).join(":"));
      if (p) return [...parts.slice(0, i), `v6/${p}`, ...parts.slice(i + len)].join(":");
    }
  }
  return rawKey;
}

/** فقط برای آزمون */
export function __resetSeenIps(): void {
  seen.clear();
}
