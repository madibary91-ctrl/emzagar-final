import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { payments, subscriptions } from "@/db/schema";
import { getRewardPlan, listAllPlans, pickDefault } from "./catalog";
import { DAY_MS, DAYS_PER_MONTH, MIN_PAYABLE, effectiveDailyRate, remainingCredit } from "./proration";
import type { PlanId } from "./plans";

/**
 * وضعیت مؤثر اشتراک (اشتراک منقضی‌شده یا طرحِ ناشناخته خودکار به «طرح پیش‌فرض» برمی‌گردد).
 * طرح پیش‌فرض را مدیر کل در کاتالوگ تعیین می‌کند (نصب اولیه: «free»).
 */
export async function getSubscription(workspaceId: number) {
  const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  const plans = await listAllPlans();
  const def = pickDefault(plans);
  const known = !!row && plans.some((p) => p.id === row.plan);
  const active = !!row && known && row.plan !== def.id && !!row.currentPeriodEnd && row.currentPeriodEnd > new Date();
  return { planId: (active ? row!.plan : def.id) as PlanId, periodEnd: active ? row!.currentPeriodEnd : null, expired: !!row && row.plan !== def.id && !active };
}

/** مجری پرسش: خود db یا تراکنشِ در جریان */
export type SubscriptionExecutor = Pick<typeof db, "select" | "insert" | "update" | "execute" | "transaction">;

async function writePeriod(workspaceId: number, plan: PlanId, end: Date, exec: SubscriptionExecutor = db, dailyRate: number | null = null) {
  await exec
    .insert(subscriptions)
    .values({ workspaceId, plan, currentPeriodEnd: end, dailyRate })
    .onConflictDoUpdate({ target: subscriptions.workspaceId, set: { plan, currentPeriodEnd: end, dailyRate, updatedAt: new Date() } });
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
    // طرح باید در کاتالوگ باشد (بایگانی‌شده هم مجاز است: پرداختِ انجام‌شده همیشه باید فعال شود) و نباید طرح پایه باشد
    const plans = await listAllPlans(tx);
    const def = pickDefault(plans);
    if (!plans.some((p) => p.id === plan) || plan === def.id) throw new Error("طرح نامعتبر است");
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
    // پرداخت مبنا (برای Proration و ارزش روزانه)؛ بدون paymentId (فعال‌سازی دستی/آزمون) ارزش روزانه نامعلوم می‌ماند و اعتباری ساخته نمی‌شود
    const [pay] =
      opts.paymentId !== undefined
        ? await tx.select({ amount: payments.amount, listPrice: payments.listPrice, creditToman: payments.creditToman, bonusDays: payments.bonusDays }).from(payments).where(eq(payments.id, opts.paymentId))
        : [];
    const [row] = await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
    const now = new Date();
    const active = !!row && plans.some((p) => p.id === row.plan) && row.plan !== def.id && !!row.currentPeriodEnd && row.currentPeriodEnd > now;
    const sameplan = active && row!.plan === plan;
    const periodDays = months * DAYS_PER_MONTH;
    const newRate = pay ? Math.max(0, (pay.listPrice ?? pay.amount) / periodDays) : null;
    // اعتبار Proration هنگام شروع پرداخت محاسبه شده؛ اگر تا لحظه‌ی اعمال دیگر وجود ندارد (مثلاً دو پرداخت هم‌زمان از یک اعتبار)،
    // کسری اعتبار از طول دوره کم می‌شود تا یک اعتبار دوبار مصرف نشود (تلورانس: حداقل مبلغ درگاه برای گردشدن‌ها).
    let cutDays = 0;
    if (pay && pay.creditToman > 0 && newRate && newRate > 0) {
      const avail = active && !sameplan ? ((await remainingCredit(workspaceId, tx, now))?.value ?? 0) : 0;
      const shortfall = pay.creditToman - avail - MIN_PAYABLE;
      if (shortfall > 0) cutDays = Math.ceil(shortfall / newRate);
    }
    const totalDays = Math.max(1, periodDays + (pay?.bonusDays ?? 0) - cutDays);
    const base = sameplan ? row!.currentPeriodEnd! : now;
    const end = new Date(base.getTime() + totalDays * DAY_MS);
    let rate: number | null = null;
    if (sameplan) {
      // تمدید هم‌طرح: ارزش روزانه‌ی دوره‌ی ترکیبی (باقی‌مانده با نرخ قبلی + روزهای جدید با نرخ جدید)
      const remaining = Math.max(0, (base.getTime() - now.getTime()) / DAY_MS);
      const oldRate = pay ? await effectiveDailyRate({ workspaceId, plan: row!.plan, dailyRate: row!.dailyRate }, tx) : row!.dailyRate;
      if (oldRate !== null) rate = (remaining * oldRate + (pay ? totalDays * (newRate ?? 0) : 0)) / (remaining + totalDays);
    } else rate = newRate;
    await writePeriod(workspaceId, plan, end, tx, rate);
    return { applied: true, periodEnd: end };
  };
  return opts.exec ? run(opts.exec) : db.transaction(run);
}

/**
 * اشتراک رایگان هدیه (پاداش دعوت): اگر طرح پولی فعال باشد همان طرح تمدید می‌شود، وگرنه «طرح پاداش» (قابل تنظیم در پنل مدیر کل) فعال می‌شود.
 * این تابع هرگز طرح فعال را تنزل نمی‌دهد. اگر هیچ طرح پولی‌ای وجود نداشته باشد، اثری ندارد و طرح پایه برمی‌گردد.
 */
export async function grantFreeDays(workspaceId: number, days: number): Promise<PlanId> {
  const cur = await getSubscription(workspaceId);
  const def = pickDefault(await listAllPlans());
  const paid = cur.planId !== def.id;
  const target: PlanId | undefined = paid ? cur.planId : (await getRewardPlan())?.id;
  if (!target) return cur.planId;
  const now = new Date();
  const base = paid && cur.periodEnd ? cur.periodEnd : now;
  // روزهای هدیه ارزش پولی ندارند: ارزش روزانه‌ی دوره رقیق می‌شود (هدیه هرگز اعتبار Proration نمی‌سازد)
  let rate: number | null = null;
  if (paid && cur.periodEnd) {
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
    const remaining = Math.max(0, (cur.periodEnd.getTime() - now.getTime()) / DAY_MS);
    if (row) rate = (remaining * (await effectiveDailyRate(row))) / (remaining + days);
  }
  await writePeriod(workspaceId, target, new Date(base.getTime() + days * DAY_MS), db, rate);
  return target;
}

/** لغو/پایان فوری اشتراک پولی یک فضای کاری (بازگشت به طرح پیش‌فرض)؛ ابزار مدیر کل */
export async function revokeSubscription(workspaceId: number): Promise<void> {
  await db.delete(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
}
