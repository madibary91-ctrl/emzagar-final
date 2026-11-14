import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import { db, outsideTransaction } from "@/db";

/**
 * قفل توزیع‌شده‌ی سبک با اجاره (lease) روی PostgreSQL (M-05: ایدمپوتنسی در استقرار چندنمونه‌ای).
 * قفل درون‌فرایندی (`Set` در حافظه) فقط در یک پردازه کار می‌کرد؛ این قفل بین همه‌ی نمونه‌ها مشترک است
 * و اگر پردازه وسط کار بمیرد، با پایان اجاره (ttl) خودبه‌خود آزاد می‌شود.
 */
const lockKey = (name: string) => `lock:${crypto.createHash("sha256").update(name).digest("hex")}`;

/** تلاش برای گرفتن قفل؛ true = گرفته شد. اگر دیتابیس خطا دهد false برمی‌گردد (fail-closed برای عملیات حساس) */
export async function tryAcquireLock(name: string, ttlMs = 60_000): Promise<boolean> {
  const key = lockKey(name);
  try {
    const res = await outsideTransaction(() =>
      db.execute(sql`
        INSERT INTO rate_limit_buckets (key, hits, reset_at)
        VALUES (${key}, 1, (now() AT TIME ZONE 'utc') + (${Math.max(1000, Math.floor(ttlMs))}::double precision * interval '1 millisecond'))
        ON CONFLICT (key) DO UPDATE SET hits = 1, reset_at = EXCLUDED.reset_at
        WHERE rate_limit_buckets.reset_at <= (now() AT TIME ZONE 'utc')
        RETURNING key
      `),
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

export async function releaseLock(name: string): Promise<void> {
  try {
    await outsideTransaction(() => db.execute(sql`DELETE FROM rate_limit_buckets WHERE key = ${lockKey(name)}`));
  } catch {
    /* با پایان اجاره آزاد می‌شود */
  }
}
