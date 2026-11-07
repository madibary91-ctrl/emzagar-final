import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiGenerations, contracts, payments, workspaceMembers } from "@/db/schema";
import { assertKycForValue } from "@/modules/kyc/service";
import { checkoutMode } from "@/modules/payments/registry";
import { reconcilePendingPayments, startPayment, verifyPayment, type VerifyResult } from "@/modules/payments/service";
import { consumeCredits } from "@/modules/wallet/service";
import { getSubscription } from "./subscription";
import { MONTH_DISCOUNT, PLANS, isPlanId, priceFor, type Plan, type PlanId } from "./plans";

/** خطای رسیدن به سقف طرح؛ API آن را به 402 تبدیل می‌کند */
export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

/** سازگاری رو به عقب: «zarinpal» = دست‌کم یک درگاه واقعی فعال است، «demo» = فقط درگاه آزمایشی */
export async function gatewayMode(): Promise<"zarinpal" | "demo" | "none"> {
  const m = await checkoutMode();
  return m === "live" ? "zarinpal" : m;
}

/** طرح مؤثر فضای کاری (اشتراک منقضی‌شده خودکار به رایگان برمی‌گردد) */
export async function getPlan(workspaceId: number): Promise<Plan> {
  const { planId } = await getSubscription(workspaceId);
  const plan = PLANS[planId];
  const envAi = Number(process.env.AI_DAILY_LIMIT);
  // سازگاری رو به عقب: AI_DAILY_LIMIT سقف طرح رایگان را تنظیم می‌کند
  return planId === "free" && envAi > 0 ? { ...plan, aiPerDay: envAi } : plan;
}

export async function getUsage(workspaceId: number) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [[c], [m], [a]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(contracts).where(and(eq(contracts.workspaceId, workspaceId), sql`${contracts.status} <> 'draft'`, gte(contracts.publishedAt, monthStart), sql`not exists (select 1 from demo_records d where d.entity = 'contract' and d.entity_id = ${contracts.id})`)),
    db.select({ n: sql<number>`count(*)::int` }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), sql`${workspaceMembers.role} <> 'client'`)),
    db.select({ n: sql<number>`count(*)::int` }).from(aiGenerations).where(and(eq(aiGenerations.workspaceId, workspaceId), eq(aiGenerations.status, "ok"), gte(aiGenerations.createdAt, new Date(Date.now() - 24 * 3600_000)))),
  ]);
  return { contracts: c?.n ?? 0, members: m?.n ?? 0, ai: a?.n ?? 0 };
}

/** نتیجه‌ی رزرو سهمیه‌ی صدور؛ اگر کار بعدی شکست بخورد release() اعتبار مصرف‌شده را برمی‌گرداند */
export type IssueQuota = { release: () => Promise<void>; usedCredits: boolean };
const NO_RELEASE = async () => undefined;

/**
 * پیش از صدور/انتشار:
 *  ۱) لایسنس (نسخه‌ی تجاری)  ۲) احراز هویت برای قراردادهای پرمبلغ (KYC)  ۳) سقف ماهانه‌ی طرح.
 * اگر سقف ماهانه پر باشد، از «اعتبار قرارداد» کیف پول (بسته‌های خریداری‌شده) به‌صورت اتمی مصرف می‌شود.
 */
export async function acquireIssueQuota(workspaceId: number, count = 1, opts: { contractValue?: number | null } = {}): Promise<IssueQuota> {
  // نسخه‌ی تجاری: با LICENSE_REQUIRED=1 بدون لایسنس معتبر صدور قرارداد جدید ممکن نیست (قراردادهای موجود و امضا همچنان کار می‌کنند)
  if (process.env.LICENSE_REQUIRED === "1" && !(await (await import("@/modules/license/client")).isLicensed())) {
    throw new PlanLimitError("لایسنس محصول فعال نیست؛ برای صدور قرارداد جدید لایسنس را در «مدیریت پلتفرم ← لایسنس و به‌روزرسانی» فعال کنید.");
  }
  await assertKycForValue(workspaceId, opts.contractValue);
  const plan = await getPlan(workspaceId);
  if (plan.contractsPerMonth < 0) return { release: NO_RELEASE, usedCredits: false };
  const { contracts: used } = await getUsage(workspaceId);
  if (used + count <= plan.contractsPerMonth) return { release: NO_RELEASE, usedCredits: false };
  const credit = await consumeCredits(workspaceId, count);
  if (credit.ok) return { release: credit.release, usedCredits: true };
  throw new PlanLimitError(`سقف ${plan.contractsPerMonth} قرارداد در ماه برای طرح «${plan.name}» تکمیل شده است. برای ادامه، طرح خود را ارتقا دهید یا از بخش «کیف پول» بسته‌ی اعتباری قرارداد بخرید.`);
}

/** سازگاری رو به عقب: بررسی سهمیه (در صورت مصرف اعتبار، بازگردانی خودکار انجام نمی‌شود؛ ترجیحاً acquireIssueQuota را به‌کار ببرید) */
export async function assertCanIssue(workspaceId: number, count = 1, opts: { contractValue?: number | null } = {}) {
  await acquireIssueQuota(workspaceId, count, opts);
}

/** پیش از دعوت عضو جدید تیم */
export async function assertCanAddMember(workspaceId: number) {
  const plan = await getPlan(workspaceId);
  const { members } = await getUsage(workspaceId);
  if (members >= plan.members) {
    throw new PlanLimitError(`طرح «${plan.name}» حداکثر ${plan.members} عضو تیم را پشتیبانی می‌کند. برای افزودن عضو، طرح را ارتقا دهید.`);
  }
}

export async function listPayments(workspaceId: number, limit = 20) {
  return db.select().from(payments).where(eq(payments.workspaceId, workspaceId)).orderBy(desc(payments.createdAt)).limit(limit);
}

/** شروع پرداخت اشتراک. مبلغ همیشه سمت سرور از روی طرح محاسبه می‌شود. */
export async function startCheckout(p: { workspaceId: number; userId: number; plan: string; months: number; origin: string; gateway?: string }): Promise<string> {
  if (!isPlanId(p.plan) || p.plan === "free") throw new Error("طرح نامعتبر است");
  if (!(p.months in MONTH_DISCOUNT)) throw new Error("مدت اشتراک نامعتبر است");
  return startPayment({
    kind: "subscription",
    workspaceId: p.workspaceId,
    userId: p.userId,
    plan: p.plan,
    months: p.months,
    amountToman: priceFor(p.plan, p.months),
    origin: p.origin,
    gateway: p.gateway,
    description: `اشتراک ${PLANS[p.plan].name} — ${p.months} ماه`,
  });
}

export { getSubscription, verifyPayment, reconcilePendingPayments };
export type { VerifyResult };

export async function platformRevenue() {
  const [r] = await db
    .select({
      total: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'paid' and not ${payments.test} and ${payments.gateway} <> 'wallet'), 0)::bigint`,
      month: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'paid' and not ${payments.test} and ${payments.gateway} <> 'wallet' and ${payments.paidAt} >= date_trunc('month', now())), 0)::bigint`,
      paying: sql<number>`(select count(*) from subscriptions where plan <> 'free' and current_period_end > now())::int`,
    })
    .from(payments);
  return { total: Number(r?.total ?? 0), month: Number(r?.month ?? 0), paying: r?.paying ?? 0 };
}
