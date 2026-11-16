/**
 * پشتیبانی از «ادامه‌ی دانلود» (HTTP Range، RFC 9110 §14) برای PDFهایی که کاربر روی شبکه‌ی ناپایدار موبایل می‌گیرد.
 * فقط «یک» بازه پشتیبانی می‌شود؛ چندبازه‌ای/نحو نامعتبر طبق استاندارد نادیده گرفته می‌شود (پاسخ کامل ۲۰۰).
 */
export type ByteRange = { start: number; end: number };

/** null = بدون بازه/نادیده‌گرفته (پاسخ کامل)، "unsatisfiable" = ۴۱۶ */
export function parseByteRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // «آخرین n بایت»
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end };
}

/** If-Range: فقط وقتی با ETag فعلی یکی است، بازه معتبر است؛ وگرنه فایل کامل (نسخه عوض شده) */
export function ifRangeAllows(ifRange: string | null | undefined, etag: string): boolean {
  if (!ifRange) return true;
  return ifRange.trim() === etag;
}
