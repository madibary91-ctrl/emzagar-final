import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { payments, subscriptions } from "@/db/schema";
import { isPlanId, type PlanId } from "./plans";

/** وضعیت مؤثر اشتراک (اشتراک منقضی‌شده خودکار به رایگان برمی‌گردد) */
export async function getSubscription(workspaceId: number) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  const active = !!row && isPlanId(row.plan) && row.plan !== "free" && !!row.currentPeriodEnd && row.currentPeriodEnd > new Date();
  return { planId: (active ? row!.plan : "free") as PlanId, periodEnd: active ? row!.currentPeriodEnd : null, expired: !!row && row.plan !== "free" && !active };
}

/** مجری پرسش: خود db یا تراکنشِ در جریان */
export type SubscriptionExecutor = Pick<typeof db, "select" | "insert" | "update" | "execute" | "transaction">;

async function writePeriod(workspaceId: number, plan: PlanId, end: Date, exec: SubscriptionExecutor = db) {
  await exec
    .insert(subscriptions)
    .values({ workspaceId, plan, currentPeriodEnd: end })
    .onConflictDoUpdate({ target: subscriptions.workspaceId, set: { plan, currentPeriodEnd: end, updatedAt: new Date() } });
}

/** فضای نام قفل‌های اشتراک (pg_advisory_xact_lock با دو کلید int) */
const SUBSCRIPTION_LOCK_NS = 727_002;

export type ActivationResult = { applied: boolean; periodEnd: Date | null };

/**
 * تمدید/فعال‌سازی اشتراک: اگر اشتراک فعلی هم‌طرح و هنوز معتبر باشد، به انتهای آن اضافه می‌شود.
 *
 * ایدمپوتنت و اتمی:
 *  - با `paymentId`، «علامت اعمال» (payments.fulfilled_at) در همان تراکنشی که اشتراک را می‌نویسد گرفته می‌شود؛
 *    پس یا هر دو انجام می‌شوند یا هیچ‌کدام، و اجرای دوباره‌ی همان پرداخت بی‌اثر است (`applied: false`).
 *  - `exec` اجازه می‌دهد فعال‌سازی بخشی از تراکنش بزرگ‌تر (مثلاً تایید پرداخت) باشد.
 *  - خواندن-محاسبه-نوشتنِ تاریخ پایان زیر قفل مشاوره‌ایِ هر فضای کاری انجام می‌شود تا دو پرداخت هم‌زمانِ یک فضا، یکدیگر را گم نکنند (lost update).
 * بدون `paymentId` رفتار قدیمی (هر فراخوانی یک تمدید) حفظ می‌شود؛ مسئولیت یکتایی با فراخواننده است.
 */
export async function activateSubscription(workspaceId: number, plan: PlanId, months: number, opts: { exec?: SubscriptionExecutor; paymentId?: number } = {}): Promise<ActivationResult> {
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("مدت اشتراک نامعتبر است");
  const run = async (tx: SubscriptionExecutor): Promise<ActivationResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SUBSCRIPTION_LOCK_NS}::int, ${workspaceId}::int)`);
    if (opts.paymentId !== undefined) {
      const claimed = await tx
        .update(payments)
        .set({ fulfilledAt: new Date() })
        .where(and(eq(payments.id, opts.paymentId), eq(payments.workspaceId, workspaceId), isNull(payments.fulfilledAt)))
        .returning({ id: payments.id });
      if (claimed.length === 0) {
        const [exists] = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.id, opts.paymentId), eq(payments.workspaceId, workspaceId)));
        if (!exists) throw new Error("پرداخت یافت نشد");
        return { applied: false, periodEnd: null }; // قبلاً اعمال شده است
      }
    }
    const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
    const now = new Date();
    const active = !!row && isPlanId(row.plan) && row.plan !== "free" && !!row.currentPeriodEnd && row.currentPeriodEnd > now;
    const base = active && row!.plan === plan ? row!.currentPeriodEnd! : now;
    const end = new Date(base.getTime() + months * 30 * 86400_000);
    await writePeriod(workspaceId, plan, end, tx);
    return { applied: true, periodEnd: end };
  };
  return opts.exec ? run(opts.exec) : db.transaction(run);
}

/**
 * اشتراک رایگان هدیه (پاداش دعوت): اگر طرح پولی فعال باشد همان طرح تمدید می‌شود، وگرنه «حرفه‌ای» فعال می‌شود.
 * این تابع هرگز طرح فعال را تنزل نمی‌دهد.
 */
export async function grantFreeDays(workspaceId: number, days: number): Promise<PlanId> {
  const cur = await getSubscription(workspaceId);
  const plan: PlanId = cur.planId === "free" ? "pro" : cur.planId;
  const base = cur.planId !== "free" && cur.periodEnd ? cur.periodEnd : new Date();
  await writePeriod(workspaceId, plan, new Date(base.getTime() + days * 86400_000));
  return plan;
}
