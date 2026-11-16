import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { notifyTeam } from "@/modules/inbox/service";
import { enqueueJob, registerJobHandler } from "@/modules/jobs/queue";
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS, deliver, isPermanentFailure, type WebhookEvent } from "./deliver";
import { explainLine } from "./explain";
import { withJitter } from "@/lib/resilience";

/**
 * تلاش مجدد وب‌هوک‌های خروجی (مثل صف پیام‌رسان‌ها).
 *
 * حالت هر ارسال در جدول webhook_deliveries ذخیره می‌شود (منبع حقیقت):
 *   ok     ← موفق (بدنه‌ی رویداد پاک می‌شود)
 *   failed ← آخرین تلاش ناموفق؛ اگر next_retry_at دارد در صف تلاش مجدد است
 *   dead   ← تلاش‌ها تمام شد / خطای دائمی (4xx) / مقصد حذف یا غیرفعال شد؛ فقط «تلاش دستی» آن را زنده می‌کند
 * بیدارکننده‌ها: ۱) کار صف ماندگار `webhook.retry` با تاخیر دقیق؛ ۲) جاروکننده‌ی زمان‌بند (processDueWebhookRetries) برای ری‌استارت/هاست بدون پردازه‌ی دائمی.
 * هر دو از یک «claim اتمیک» (اجاره‌ی ۱۰ دقیقه‌ای روی next_retry_at) می‌گذرند؛ پس یک ارسال هرگز هم‌زمان دوبار تلاش نمی‌شود.
 */
const LEASE_MS = 10 * 60_000;

export type StoredEvent = Pick<WebhookEvent, "event" | "contractId" | "text" | "data" | "at" | "deliveryKey" | "workspaceId">;

/** ثبت یک ارسال ناموفق و زمان‌بندی تلاش بعدی (یا dead) — از مسیر ارسال اول فراخوانی می‌شود */
export async function recordFailure(p: { endpointId: number; ev: StoredEvent; error: string; provider: string }): Promise<void> {
  // رویداد «test» (دکمه‌ی آزمایش) هرگز در صف نمی‌ماند؛ کاربر همان لحظه نتیجه را می‌بیند
  const permanent = isPermanentFailure(p.error, p.provider) || p.ev.event === "test";
  // R-0x: jitter — مقصدهای هم‌خرابِ یک قطعی سراسری یک‌جا دوباره زده نشوند
  const delay = withJitter(RETRY_DELAYS_MS[0]);
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      endpointId: p.endpointId,
      event: p.ev.event,
      status: permanent ? "dead" : "failed",
      error: p.error,
      contractId: p.ev.contractId ?? null,
      attempts: 1,
      lastAttemptAt: new Date(),
      payload: p.ev.event === "test" ? null : JSON.stringify(p.ev),
      nextRetryAt: permanent ? null : new Date(Date.now() + delay),
    })
    .returning({ id: webhookDeliveries.id });
  // خطای دائمی در همان ارسال اول (توکن/آدرس اشتباه): بی‌صدا نماند. برای جلوگیری از اسپم، فقط اگر در ۲۴ ساعت اخیر هشدار مشابهی برای همین مقصد نبوده
  if (permanent && p.ev.event !== "test") {
    const [prior] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.endpointId, p.endpointId), eq(webhookDeliveries.status, "dead"), sql`${webhookDeliveries.id} <> ${row.id}`, sql`${webhookDeliveries.createdAt} > now() - interval '24 hours'`));
    if ((prior?.n ?? 0) === 0) {
      const [ep] = await db.select({ name: webhookEndpoints.name, workspaceId: webhookEndpoints.workspaceId }).from(webhookEndpoints).where(eq(webhookEndpoints.id, p.endpointId));
      if (ep) await notifyTeam(ep.workspaceId, { kind: "warning", title: `مقصد «${ep.name}» پیام را نپذیرفت`, body: `${explainLine(p.error, p.provider)} پس از اصلاح مقصد، از «اعلان پیام‌رسان‌ها ← تلاش دوباره» پیام‌های معلق را بفرستید.`, href: "/admin/webhooks" }, [], ["owner", "admin"]).catch(() => 0);
    }
  }
  if (!permanent) await enqueueJob("webhook.retry", { deliveryId: row.id }, { delayMs: delay, dedupeKey: `wh:${row.id}:1`, maxAttempts: 2 }).catch(() => undefined);
}

type Delivery = typeof webhookDeliveries.$inferSelect;

/** برداشتن اتمیک یک ارسال سررسیده‌ی در صف تلاش مجدد (null = کسی دیگر برداشته یا هنوز زمانش نرسیده) */
async function claim(id: number): Promise<Delivery | null> {
  const [row] = await db
    .update(webhookDeliveries)
    .set({ nextRetryAt: new Date(Date.now() + LEASE_MS), lastAttemptAt: new Date() })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "failed"), lte(webhookDeliveries.nextRetryAt, new Date())))
    .returning();
  return row ?? null;
}

export type RetryOutcome = "ok" | "failed" | "dead" | "skipped";

/** یک تلاش مجدد برای ارسال `id` (پس از claim) */
export async function attemptDelivery(id: number): Promise<RetryOutcome> {
  const d = await claim(id);
  if (!d) return "skipped";
  const attempt = d.attempts + 1;
  const [ep] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId));
  const ev = parseEvent(d.payload);
  if (!ep || !ep.active || !ev) {
    await db.update(webhookDeliveries).set({ status: "dead", nextRetryAt: null, payload: null, error: !ep ? "مقصد حذف شده است" : !ep.active ? "مقصد غیرفعال شد" : "بدنه‌ی رویداد در دسترس نیست" }).where(eq(webhookDeliveries.id, d.id));
    return "dead";
  }
  try {
    await deliver(ep, ev, attempt);
    await db.update(webhookDeliveries).set({ status: "ok", attempts: attempt, error: null, nextRetryAt: null, payload: null, lastAttemptAt: new Date() }).where(eq(webhookDeliveries.id, d.id));
    return "ok";
  } catch (e) {
    const error = (e instanceof Error ? e.message : "خطای ناشناخته").slice(0, 300);
    const dead = attempt >= MAX_DELIVERY_ATTEMPTS || isPermanentFailure(error, ep.provider);
    if (dead) {
      await db.update(webhookDeliveries).set({ status: "dead", attempts: attempt, error, nextRetryAt: null, lastAttemptAt: new Date() }).where(eq(webhookDeliveries.id, d.id));
      await notifyTeam(ep.workspaceId, { kind: "warning", title: `ارسال وب‌هوک «${ep.name}» ناموفق ماند`, body: `رویداد «${d.event}» پس از ${attempt} تلاش به مقصد نرسید. ${explainLine(error, ep.provider)} پس از رفع مشکل، از «اعلان پیام‌رسان‌ها ← تلاش دوباره» می‌توانید دوباره بفرستید.`, href: "/admin/webhooks" }, [], ["owner", "admin"]).catch(() => 0);
      return "dead";
    }
    const delay = withJitter(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
    await db.update(webhookDeliveries).set({ status: "failed", attempts: attempt, error, nextRetryAt: new Date(Date.now() + delay), lastAttemptAt: new Date() }).where(eq(webhookDeliveries.id, d.id));
    await enqueueJob("webhook.retry", { deliveryId: d.id }, { delayMs: delay, dedupeKey: `wh:${d.id}:${attempt}`, maxAttempts: 2 }).catch(() => undefined);
    return "failed";
  }
}

function parseEvent(payload: string | null): StoredEvent | null {
  if (!payload) return null;
  try {
    const v = JSON.parse(payload) as StoredEvent;
    return typeof v?.event === "string" && typeof v.text === "string" ? v : null;
  } catch {
    return null;
  }
}

/** جاروکننده‌ی زمان‌بند: ارسال‌های سررسیده‌ی در صف را (حداکثر `limit` تا) تلاش می‌کند */
export async function processDueWebhookRetries(limit = 25): Promise<number> {
  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "failed"), lte(webhookDeliveries.nextRetryAt, new Date())))
    .orderBy(webhookDeliveries.nextRetryAt)
    .limit(limit);
  // بدنه‌ی ارسال‌های متوقف‌شده‌ی قدیمی (بیش از ۷ روز) پاک می‌شود
  await db.update(webhookDeliveries).set({ payload: null }).where(and(eq(webhookDeliveries.status, "dead"), sql`${webhookDeliveries.payload} is not null`, sql`${webhookDeliveries.lastAttemptAt} < now() - interval '7 days'`)).catch(() => undefined);
  let n = 0;
  for (const r of due) if ((await attemptDelivery(r.id)) !== "skipped") n++;
  return n;
}

/** «تلاش دوباره‌ی دستی» از پنل (فقط ارسال‌های همین فضای کاری). ارسالی که بدنه‌اش پاک شده (قدیمی‌تر از ۷ روز یا آزمایشی) قابل تلاش نیست. */
export async function retryDeliveryNow(deliveryId: number, workspaceId: number): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db
    .select({ d: webhookDeliveries, ws: webhookEndpoints.workspaceId })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!row || row.ws !== workspaceId) return { ok: false, error: "ارسال یافت نشد" };
  if (row.d.status === "ok") return { ok: false, error: "این ارسال قبلاً موفق بوده است" };
  if (!row.d.payload) return { ok: false, error: "بدنه‌ی این رویداد دیگر نگهداری نمی‌شود؛ رویداد را دوباره ایجاد کنید" };
  // صف دستی: همین حالا سررسید می‌شود (و در صورت dead، دقیقاً یک تلاش دیگر مجاز است)
  await db
    .update(webhookDeliveries)
    .set({ status: "failed", nextRetryAt: new Date(Date.now() - 1000), attempts: sql`least(${webhookDeliveries.attempts}, ${MAX_DELIVERY_ATTEMPTS - 1})` })
    .where(and(eq(webhookDeliveries.id, deliveryId), sql`${webhookDeliveries.status} in ('failed','dead')`));
  const r = await attemptDelivery(deliveryId);
  if (r === "ok") return { ok: true };
  if (r === "skipped") return { ok: false, error: "ارسال هم‌اکنون در حال پردازش است" };
  const [after] = await db.select({ error: webhookDeliveries.error, status: webhookDeliveries.status, provider: webhookEndpoints.provider }).from(webhookDeliveries).innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId)).where(eq(webhookDeliveries.id, deliveryId));
  const why = after?.error ? ` ${explainLine(after.error, after.provider)}` : "";
  return { ok: false, error: `${after?.status === "dead" ? "تلاش دوباره هم ناموفق بود و ارسال متوقف ماند." : "تلاش دوباره هم ناموفق بود؛ در صف تلاش خودکار می‌ماند."}${why}` };
}

/**
 * «تلاش دوباره‌ی همه»: پس از اصلاح توکن/آدرس، همه‌ی ارسال‌های ناموفق (قابل‌تلاش) این فضای کاری را یک‌جا می‌فرستد
 * (به‌جای کلیک روی ده‌ها ردیف). حداکثر `limit` ارسال در هر نوبت.
 */
export async function retryAllFailed(workspaceId: number, limit = 25): Promise<{ total: number; ok: number; failed: number }> {
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.active, true), sql`${webhookDeliveries.status} in ('failed','dead')`, sql`${webhookDeliveries.payload} is not null`))
    .orderBy(webhookDeliveries.id)
    .limit(limit);
  let ok = 0;
  for (const r of rows) if ((await retryDeliveryNow(r.id, workspaceId)).ok) ok++;
  return { total: rows.length, ok, failed: rows.length - ok };
}

registerJobHandler("webhook.retry", {
  async run(p) {
    const id = Number(p.deliveryId);
    if (Number.isInteger(id)) await attemptDelivery(id);
  },
});
