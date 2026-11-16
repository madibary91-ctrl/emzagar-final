import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db, outsideTransaction } from "@/db";
import { effectiveLimit, rateLimit, registerPersistentReset, settlePendingResets } from "@/lib/rate-limit";

/**
 * M-04 — محدودکننده‌ی نرخ «پایدار» روی PostgreSQL (پنجره‌ی ثابت، اتمیک).
 *
 *  • مشترک بین همه‌ی نمونه‌ها و ماندگار پس از ری‌استارت/به‌روزرسانی (سقف‌ها «ضرب» یا ریست نمی‌شوند).
 *  • شمارش با یک دستور `INSERT … ON CONFLICT DO UPDATE` انجام می‌شود: هیچ شرایط رقابتی بین «چک» و «ثبت» وجود ندارد.
 *  • زمان همیشه ساعت دیتابیس است (نه ساعت هر نمونه) ← هم‌گامی بین نمونه‌ها.
 *  • کلید «کامل» با SHA-256 هش می‌شود: نه برش (برخورد پیشوند) و نه سقف تعداد/حذف قدیمی‌ترین (تخلیه‌ی سطل قربانی) دارد.
 *  • خارج از تراکنش محیطی اجرا می‌شود تا تلاش‌های شکست‌خورده با rollback برنگردند (وگرنه حدس زدن رایگان می‌شد).
 *  • اگر دیتابیس در لحظه در دسترس نباشد، به لایه‌ی حافظه برمی‌گردد (بدون سقف نبودن؛ در دسترس‌پذیری حفظ می‌شود).
 */
const hashKey = (k: string) => crypto.createHash("sha256").update(k).digest("hex");

let lastPurge = 0;
const PURGE_EVERY_MS = 60_000;

export type RateResult = { ok: boolean; retryAfter: number };

export async function rateLimitDb(rawKey: string, rawLimit: number, windowMs: number): Promise<RateResult> {
  const limit = effectiveLimit(rawKey, rawLimit);
  const key = hashKey(rawKey);
  const ms = Math.max(1, Math.floor(windowMs));
  await settlePendingResets();
  try {
    const res = await outsideTransaction(() =>
      db.execute(sql`
        INSERT INTO rate_limit_buckets (key, hits, reset_at)
        VALUES (${key}, 1, (now() AT TIME ZONE 'utc') + (${ms}::double precision * interval '1 millisecond'))
        ON CONFLICT (key) DO UPDATE SET
          hits = CASE WHEN rate_limit_buckets.reset_at <= (now() AT TIME ZONE 'utc') THEN 1 ELSE rate_limit_buckets.hits + 1 END,
          reset_at = CASE WHEN rate_limit_buckets.reset_at <= (now() AT TIME ZONE 'utc') THEN (now() AT TIME ZONE 'utc') + (${ms}::double precision * interval '1 millisecond') ELSE rate_limit_buckets.reset_at END
        RETURNING hits, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (reset_at - (now() AT TIME ZONE 'utc')))))::int AS ttl
      `),
    );
    const row = res.rows[0] as { hits: number; ttl: number } | undefined;
    if (!row) return rateLimit(rawKey, rawLimit, windowMs);
    void purgeExpired();
    return Number(row.hits) > limit ? { ok: false, retryAfter: Math.max(1, Number(row.ttl)) } : { ok: true, retryAfter: 0 };
  } catch (e) {
    console.error("[rate-limit-db] fallback to memory:", e instanceof Error ? e.message : e);
    return rateLimit(rawKey, rawLimit, windowMs);
  }
}

/** بازنشانی یک سطل (مثلاً پس از ورود موفق) — هم دیتابیس و هم لایه‌ی حافظه‌ی همان کلید */
export async function resetRateLimitDb(rawKey: string): Promise<void> {
  try {
    await outsideTransaction(() => db.execute(sql`DELETE FROM rate_limit_buckets WHERE key = ${hashKey(rawKey)}`));
  } catch {
    /* بازنشانی بهترین-تلاش است؛ شکستش فقط یعنی سطل خودبه‌خود منقضی می‌شود */
  }
}

registerPersistentReset(resetRateLimitDb);

/** خواندن بدون افزایش (برای نمایش/تصمیم‌گیری): آیا کلید هم‌اکنون از سقف گذشته است؟ */
export async function isBlockedDb(rawKey: string, rawLimit: number): Promise<boolean> {
  try {
    const res = await outsideTransaction(() => db.execute(sql`SELECT hits FROM rate_limit_buckets WHERE key = ${hashKey(rawKey)} AND reset_at > (now() AT TIME ZONE 'utc')`));
    const row = res.rows[0] as { hits: number } | undefined;
    return !!row && Number(row.hits) > effectiveLimit(rawKey, rawLimit);
  } catch {
    return false;
  }
}

/** پاک‌سازی ردیف‌های منقضی (حداکثر دقیقه‌ای یک‌بار در هر پردازه؛ فقط ردیف‌های «منقضی» حذف می‌شوند) */
async function purgeExpired(): Promise<void> {
  const now = Date.now();
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  try {
    await outsideTransaction(() => db.execute(sql`DELETE FROM rate_limit_buckets WHERE reset_at < (now() AT TIME ZONE 'utc') - interval '10 minutes'`));
  } catch {
    /* نادیده */
  }
}
