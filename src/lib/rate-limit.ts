/**
 * محدودکننده‌ی نرخ درون‌حافظه‌ای (پنجره‌ی ثابت).
 * برای استقرار چندنمونه‌ای می‌توان آن را با Redis جایگزین کرد؛ رابط ثابت می‌ماند.
 */
const buckets = new Map<string, { n: number; reset: number }>();

/** سقف سخت تعداد سطل‌ها: حمله‌ی پراکنده (کلیدهای بی‌شمار) نمی‌تواند حافظه‌ی سرور را پر کند */
const MAX_BUCKETS = 20_000;
/** کلیدهای ساخته‌شده از ورودی کاربر (مثل ایمیل) کوتاه می‌شوند تا هر سطل حافظه‌ی زیادی نگیرد */
const MAX_KEY_LENGTH = 200;

export function rateLimit(rawKey: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const key = rawKey.length > MAX_KEY_LENGTH ? rawKey.slice(0, MAX_KEY_LENGTH) : rawKey;
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    // اگر بعد از پاک‌سازی منقضی‌ها هنوز پر است، قدیمی‌ترین‌ها (ترتیب درج Map) حذف می‌شوند
    if (buckets.size > MAX_BUCKETS) {
      let drop = buckets.size - MAX_BUCKETS;
      for (const k of buckets.keys()) {
        if (drop-- <= 0) break;
        buckets.delete(k);
      }
    }
  }
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.n++;
  if (b.n > limit) return { ok: false, retryAfter: Math.ceil((b.reset - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

export function resetRateLimit(key: string) {
  buckets.delete(key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key);
}
