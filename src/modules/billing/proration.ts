import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { payments, subscriptions } from "@/db/schema";
import { listAllPlans, pickDefault } from "./catalog";
import type { Plan } from "./plans";
import { planPrice } from "./plans";

/**
 * Proration — محاسبه‌ی «اعتبار روزهای باقی‌مانده» هنگام تغییر طرح در میانه‌ی دوره.
 *
 * مدل: هر دوره‌ی پولی «ارزش هر روز» دارد (subscriptions.daily_rate = آنچه مشتری واقعاً برای هر روز آن دوره پرداخته است).
 * وقتی مشتری وسط دوره طرح دیگری می‌خرد، ارزش باقی‌مانده‌ی طرح قبلی (روزهای باقی‌مانده × ارزش روزانه) «می‌سوزد» نه؛ به‌جایش:
 *   ۱) از قیمت طرح جدید کسر می‌شود (تا جایی که مبلغ قابل پرداخت از حداقل درگاه کمتر نشود)؛
 *   ۲) اگر اعتبار از قیمت طرح جدید هم بیشتر باشد (مثلاً کاهش طرح)، مازاد به «روزهای هدیه‌ی» طرح جدید تبدیل می‌شود.
 * پس در هیچ حالتی پول مشتری از بین نمی‌رود. همه‌چیز سمت سرور و از داده‌ی دیتابیس محاسبه می‌شود.
 */

export const DAY_MS = 86_400_000;
/** مدت یک «ماه اشتراک» (همان قاعده‌ی activateSubscription) */
export const DAYS_PER_MONTH = 30;
/** کمترین مبلغ قابل پرداخت از درگاه (تومان) — با startPayment یکی است */
export const MIN_PAYABLE = 1000;

type Reader = Pick<typeof db, "select" | "insert">;

export type Proration = {
  /** طرح فعلی که اعتبارش مصرف می‌شود (null = اعتباری نیست) */
  fromPlanId: string | null;
  remainingDays: number;
  /** ارزش کل باقی‌مانده‌ی طرح فعلی (تومان) */
  creditValue: number;
  /** سهمی که مستقیم از قیمت کم می‌شود */
  discount: number;
  /** روزهای هدیه (برای اعتبارِ مازاد بر قیمت طرح جدید) */
  bonusDays: number;
  /** قیمت کامل طرح جدید برای این مدت */
  listPrice: number;
  /** مبلغ نهایی قابل پرداخت */
  payable: number;
};

export const NO_PRORATION = (listPrice: number): Proration => ({ fromPlanId: null, remainingDays: 0, creditValue: 0, discount: 0, bonusDays: 0, listPrice, payable: listPrice });

/** ارزش روزانه‌ی دوره‌ی جاری یک اشتراک؛ در نبود مقدار ذخیره‌شده از آخرین پرداخت واقعی همان طرح برآورد می‌شود (داده‌ی قدیمی) */
export async function effectiveDailyRate(row: { workspaceId: number; plan: string; dailyRate: number | null }, exec: Reader = db): Promise<number> {
  if (row.dailyRate !== null && row.dailyRate !== undefined) return Math.max(0, row.dailyRate);
  const [last] = await exec
    .select({ amount: payments.amount, listPrice: payments.listPrice, months: payments.months, gateway: payments.gateway })
    .from(payments)
    .where(and(eq(payments.workspaceId, row.workspaceId), eq(payments.plan, row.plan), eq(payments.kind, "subscription"), eq(payments.status, "paid"), isNotNull(payments.fulfilledAt)))
    .orderBy(desc(payments.id))
    .limit(1);
  if (!last) return 0;
  return Math.max(0, (last.listPrice ?? last.amount) / (Math.max(1, last.months) * DAYS_PER_MONTH));
}

/** اعتبار باقی‌مانده‌ی اشتراک فعال فضای کاری (برای طرحی غیر از target). `now` برای آزمون‌پذیری است. */
export async function remainingCredit(workspaceId: number, exec: Reader = db, now = new Date()): Promise<{ planId: string; remainingDays: number; value: number; rate: number } | null> {
  const [row] = await exec.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  if (!row || !row.currentPeriodEnd || row.currentPeriodEnd <= now) return null;
  const plans = await listAllPlans(exec);
  const def = pickDefault(plans);
  if (row.plan === def.id || !plans.some((p) => p.id === row.plan)) return null;
  const rate = await effectiveDailyRate(row, exec);
  const remainingDays = (row.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS;
  return { planId: row.plan, remainingDays, value: Math.floor(remainingDays * rate), rate };
}

/**
 * محاسبه‌ی Proration برای خرید `plan` به مدت `months` ماه.
 * فقط وقتی اعتبار دارد که اشتراک فعالِ «طرح دیگری» وجود داشته باشد؛ تمدید هم‌طرح، اعتبار لازم ندارد (به انتهای دوره اضافه می‌شود).
 */
export async function computeProration(workspaceId: number, plan: Plan, months: number, exec: Reader = db, now = new Date()): Promise<Proration> {
  const listPrice = planPrice(plan, months);
  const cur = await remainingCredit(workspaceId, exec, now);
  if (!cur || cur.planId === plan.id || cur.value <= 0) return NO_PRORATION(listPrice);
  const room = Math.max(0, listPrice - MIN_PAYABLE);
  const discount = Math.min(cur.value, room);
  const leftover = cur.value - discount;
  const newRate = listPrice / (months * DAYS_PER_MONTH);
  const bonusDays = newRate > 0 ? Math.floor(leftover / newRate) : 0;
  return { fromPlanId: cur.planId, remainingDays: Math.round(cur.remainingDays * 10) / 10, creditValue: cur.value, discount, bonusDays, listPrice, payable: listPrice - discount };
}
