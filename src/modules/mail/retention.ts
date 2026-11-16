import { sql } from "drizzle-orm";
import { db } from "@/db";
import { REDACTED_BODY, bodyTtlMinutes, retentionDays } from "@/lib/outbox-policy";

/**
 * D-04: پاک‌سازی دوره‌ای صندوق ارتباطات.
 *  ۱) متن ایمیل/پیامک قدیمی‌تر از TTL با نشانگر جایگزین می‌شود (در production: همه‌ی متن‌های به‌جامانده از نسخه‌های قبلی، فوراً).
 *  ۲) ردیف‌های قدیمی‌تر از دوره‌ی نگهداری حذف می‌شوند.
 * idempotent و ارزان است (ردیف‌های پاک‌شده دوباره لمس نمی‌شوند).
 */
export async function purgeOutbox(): Promise<{ scrubbed: number; deleted: number }> {
  const ttl = bodyTtlMinutes();
  const scrub = await db.execute(sql`
    update notifications set body = ${REDACTED_BODY}
     where body <> ${REDACTED_BODY} and body <> ''
       and created_at <= now() - (${ttl}::int * interval '1 minute')
    returning id`);
  const del = await db.execute(sql`delete from notifications where created_at < now() - (${retentionDays()}::int * interval '1 day') returning id`);
  return { scrubbed: scrub.rows.length, deleted: del.rows.length };
}
