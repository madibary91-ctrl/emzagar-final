import { createHash, timingSafeEqual } from "node:crypto";

/**
 * مقایسه‌ی زمان‌ثابت دو رشته که «هرگز پرتاب نمی‌کند».
 * `timingSafeEqual(Buffer.from(a), Buffer.from(b))` وقتی طول «بایتی» دو طرف فرق کند (مثلاً کلید ۳۲ نویسه‌ای یونیکد)
 * RangeError می‌دهد و صفحه ۵۰۰ می‌شود. با هش‌کردن، طول هر دو همیشه ۳۲ بایت است.
 */
export function safeEqualStr(a: unknown, b: string, maxLen = 512): boolean {
  if (typeof a !== "string" || a.length > maxLen) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
