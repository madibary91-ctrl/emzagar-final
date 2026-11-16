/**
 * محدودکننده‌ی نرخ درون‌حافظه‌ای (پنجره‌ی ثابت) — «لایه‌ی سریع و هم‌زمان».
 *
 * M-04: این لایه دیگر مرجع «سقف‌های امنیتی» نیست. ورود، 2FA، فراموشی رمز، ثبت‌نام، OTP و کلیدهای API از
 * `rateLimitDb` (lib/rate-limit-db.ts؛ پایدار در PostgreSQL، مشترک بین نمونه‌ها، ماندگار پس از ری‌استارت) استفاده می‌کنند.
 * این نسخه فقط برای سقف‌های «راحتی/ضدسوءاستفاده‌ی سبک» می‌ماند و در برابر تخلیه‌ی عمدی سخت شده است:
 *  • سطل‌های «فعال» (شمارش بیش از ۱) و سطل‌های مسدودشده هرگز با سرریز تعداد کلیدها حذف نمی‌شوند؛
 *    فقط سطل‌های کم‌ارزشِ تک‌ضربه‌ای قدیمی حذف می‌شوند، پس مهاجم با کلیدهای متنوع نمی‌تواند شمارنده‌ی قربانی را صفر کند؛
 *  • برش کلیدهای بلند (۲۰۰ نویسه) برای سازگاری با آزمون‌های موجود همین‌جا می‌ماند؛ اما چون سقف‌های امنیتی دیگر
 *    از این لایه نمی‌آیند، برخورد پیشوند (M-03) اثر امنیتی ندارد: `rateLimitDb` کلید را «کامل» هش می‌کند.
 */
type Bucket = { n: number; reset: number };
const buckets = new Map<string, Bucket>();

/** سقف نرم تعداد سطل‌ها؛ فقط سطل‌های کم‌ارزش (n ≤ 1) برای رسیدن به آن حذف می‌شوند */
const MAX_BUCKETS = 20_000;
const GC_AT = 5_000;
/** کلیدهای ساخته‌شده از ورودی کاربر کوتاه می‌شوند تا هر سطل حافظه‌ی زیادی نگیرد (فقط در لایه‌ی حافظه) */
const MAX_KEY_LENGTH = 200;
let lastGc = 0;

/**
 * H-04: وقتی IP کلاینت نامعلوم است (کلید شامل "unknown")، همه‌ی کاربران یک سطل مشترک می‌شوند؛ با سقف عادی، یک مهاجم
 * با چند درخواست ورود/ثبت‌نام/امضای همه را قفل می‌کرد. برای این سطل مشترک سقفی چند برابر اعمال می‌شود تا فقط جلوی
 * سیل واقعی را بگیرد؛ دفاع اصلی در این حالت محدودیت‌های «غیر-IP» (ایمیل، کاربر، موبایل، توکن) است.
 */
export const UNKNOWN_IP_LIMIT_MULTIPLIER = 40;
const UNKNOWN_KEY_RE = /(^|:)unknown(:|$)/;

export function normalizeRateKey(rawKey: string): string {
  return rawKey.length > MAX_KEY_LENGTH ? rawKey.slice(0, MAX_KEY_LENGTH) : rawKey;
}

export const effectiveLimit = (rawKey: string, rawLimit: number): number => (UNKNOWN_KEY_RE.test(rawKey) ? rawLimit * UNKNOWN_IP_LIMIT_MULTIPLIER : rawLimit);

function collect(now: number): void {
  if (buckets.size <= GC_AT) return;
  // پاک‌سازی منقضی‌ها حداکثر ثانیه‌ای یک‌بار (قبلاً در هر فراخوانی O(n) بود)
  if (now - lastGc > 1000 || buckets.size > MAX_BUCKETS) {
    lastGc = now;
    for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  }
  if (buckets.size > MAX_BUCKETS) {
    // فقط سطل‌های کم‌ارزش و قدیمی (ترتیب درج Map) حذف می‌شوند؛ سطل‌های فعال/مسدود دست‌نخورده می‌مانند
    let drop = buckets.size - Math.floor(MAX_BUCKETS * 0.9);
    for (const [k, v] of buckets) {
      if (drop <= 0) break;
      if (v.n <= 1) {
        buckets.delete(k);
        drop--;
      }
    }
  }
}

export function rateLimit(rawKey: string, rawLimit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const limit = effectiveLimit(rawKey, rawLimit);
  const key = normalizeRateKey(rawKey);
  const now = Date.now();
  collect(now);
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    // سقف سخت حافظه: اگر هنوز پر است (همه‌ی سطل‌ها فعال‌اند) کلید جدید ردیابی نمی‌شود، اما هیچ سطل فعالی حذف نمی‌شود
    if (!b && buckets.size >= MAX_BUCKETS * 1.5) return { ok: true, retryAfter: 0 };
    buckets.set(key, { n: 1, reset: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  b.n++;
  if (b.n > limit) return { ok: false, retryAfter: Math.ceil((b.reset - now) / 1000) };
  return { ok: true, retryAfter: 0 };
}

/**
 * `resetRateLimit` «همه‌جا» را بازنشانی می‌کند: لایه‌ی حافظه (هم‌زمان) و، اگر لایه‌ی پایدار بارگذاری شده باشد، دیتابیس.
 * بازنشانی دیتابیس ناهمگام است؛ `rateLimitDb` پیش از هر شمارش منتظر بازنشانی‌های در جریان می‌ماند، پس ترتیب
 * «reset ← rateLimit» برای فراخواننده‌ی هم‌زمان همیشه رعایت می‌شود.
 */
type ResetHook = (key: string) => Promise<void>;
let resetHook: ResetHook | null = null;
const pendingResets = new Set<Promise<void>>();
export function registerPersistentReset(hook: ResetHook): void {
  resetHook = hook;
}
export async function settlePendingResets(): Promise<void> {
  if (pendingResets.size) await Promise.all([...pendingResets]);
}

export function resetRateLimit(key: string) {
  buckets.delete(normalizeRateKey(key));
  if (resetHook) {
    const p = resetHook(key).catch(() => undefined).finally(() => pendingResets.delete(p));
    pendingResets.add(p);
  }
}
