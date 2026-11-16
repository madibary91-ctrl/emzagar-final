import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import { db, inTransaction, lockScope, withTransaction } from "@/db";
import { aiGenerations, contracts, payments, workspaceInvites, workspaceMembers } from "@/db/schema";
import { assertKycForValue } from "@/modules/kyc/service";
import { checkoutMode } from "@/modules/payments/registry";
import { reconcilePendingPayments, startPayment, verifyPayment, type VerifyResult } from "@/modules/payments/service";
import { consumeCredits, getWallet } from "@/modules/wallet/service";
import { getSubscription } from "./subscription";
import { getDefaultPlan, getPlanById } from "./catalog";
import { quotePurchase } from "./purchase";
import { aiCountedCondition } from "@/modules/ai/quota-status";
import type { Plan } from "./plans";

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

/** طرح مؤثر فضای کاری (اشتراک منقضی‌شده خودکار به طرح پیش‌فرض برمی‌گردد) — از کاتالوگ پویای دیتابیس */
export async function getPlan(workspaceId: number): Promise<Plan> {
  const { planId } = await getSubscription(workspaceId);
  const plan = (await getPlanById(planId)) ?? (await getDefaultPlan());
  const envAi = Number(process.env.AI_DAILY_LIMIT);
  // سازگاری رو به عقب: AI_DAILY_LIMIT سقف طرح پیش‌فرض (رایگان) را تنظیم می‌کند
  return plan.isDefault && envAi > 0 ? { ...plan, aiPerDay: envAi } : plan;
}

export async function getUsage(workspaceId: number) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [[c], [m], [a]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(contracts).where(and(eq(contracts.workspaceId, workspaceId), sql`${contracts.status} <> 'draft'`, gte(contracts.publishedAt, monthStart), sql`not exists (select 1 from demo_records d where d.entity = 'contract' and d.entity_id = ${contracts.id})`)),
    db.select({ n: sql<number>`count(*)::int` }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), sql`${workspaceMembers.role} <> 'client'`)),
    db.select({ n: sql<number>`count(*)::int` }).from(aiGenerations).where(and(eq(aiGenerations.workspaceId, workspaceId), aiCountedCondition(), gte(aiGenerations.createdAt, new Date(Date.now() - 24 * 3600_000)))),
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
 *
 * HX-02 (TOCTOU): «شمارش مصرف ← تصمیم ← درج قرارداد» فقط وقتی اتمی است که همه در یک تراکنش و پشت یک قفل
 * سریال‌کننده‌ی «هر فضای کاری» باشند. اگر فراخواننده داخل `withTransaction` باشد، این تابع پیش از شمارش، قفل
 * `issue-quota:<workspace>` را می‌گیرد؛ قفل تا commit/rollback همان تراکنش (یعنی پس از درج ردیف قرارداد) نگه داشته می‌شود
 * و درخواست هم‌زمان بعدی شمارنده‌ی تازه را می‌بیند. برای مسیرهای تولیدی از `withIssueQuota` استفاده کنید که خودش تراکنش می‌سازد؛
 * فراخوانی «بدون تراکنش» فقط یک سنجش لحظه‌ای است (سازگاری رو به عقب) و ضمانت هم‌زمانی ندارد.
 */
export async function acquireIssueQuota(workspaceId: number, count = 1, opts: { contractValue?: number | null } = {}): Promise<IssueQuota> {
  await assertLicensedForIssue();
  await assertKycForValue(workspaceId, opts.contractValue);
  if (inTransaction()) await lockScope("issue-quota", workspaceId);
  const plan = await getPlan(workspaceId);
  if (plan.contractsPerMonth < 0) return { release: NO_RELEASE, usedCredits: false };
  const { contracts: used } = await getUsage(workspaceId);
  if (used + count <= plan.contractsPerMonth) return { release: NO_RELEASE, usedCredits: false };
  const credit = await consumeCredits(workspaceId, count);
  if (credit.ok) return { release: credit.release, usedCredits: true };
  throw limitError(plan);
}

/**
 * اجرای یک «عمل مصرف‌کننده‌ی سهمیه‌ی صدور» (درج قرارداد / تبدیل پیش‌نویس به منتشرشده) به‌صورت اتمی:
 * تراکنش + قفل سریال‌کننده + سنجش سقف/کسر اعتبار + خودِ عمل؛ هر خطا ⇒ rollback کامل (اعتبار هم خودکار برمی‌گردد).
 * `fn` هرگز نباید کار شبکه‌ای انجام دهد (قفل را نگه می‌دارد)؛ کارهای شبکه‌ای را با `afterCommit` یا پس از بازگشت انجام دهید.
 */
export async function withIssueQuota<T>(workspaceId: number, count: number, opts: { contractValue?: number | null }, fn: (quota: IssueQuota) => Promise<T>): Promise<T> {
  return withTransaction(async () => fn(await acquireIssueQuota(workspaceId, count, opts)));
}

/** نسخه‌ی تجاری: با LICENSE_REQUIRED=1 بدون لایسنس معتبر صدور قرارداد جدید ممکن نیست (قراردادهای موجود و امضا همچنان کار می‌کنند) */
async function assertLicensedForIssue(): Promise<void> {
  if (process.env.LICENSE_REQUIRED === "1" && !(await (await import("@/modules/license/client")).isLicensed())) {
    throw new PlanLimitError("لایسنس محصول فعال نیست؛ برای صدور قرارداد جدید لایسنس را در «مدیریت پلتفرم ← لایسنس و به‌روزرسانی» فعال کنید.");
  }
}
const limitError = (plan: Plan) =>
  new PlanLimitError(`سقف ${plan.contractsPerMonth} قرارداد در ماه برای طرح «${plan.name}» تکمیل شده است. برای ادامه، طرح خود را ارتقا دهید یا از بخش «کیف پول» بسته‌ی اعتباری قرارداد بخرید.`);

/**
 * GLM-5: بررسی «فقط‌خواندنی» ظرفیت صدور (لایسنس، KYC، سقف ماهانه یا اعتبار کافی در کیف پول) — هیچ اعتباری مصرف نمی‌کند.
 * پیش‌تر این تابع همان acquireIssueQuota بود و برای ارسال انبوه (startBatch/retryFailed) `count` اعتبار را «واقعاً» کسر می‌کرد؛
 * سپس issueContract برای هر ردیف دوباره ۱ اعتبار کسر می‌کرد ⇒ کسر مضاعف. مصرف واقعی فقط و فقط هنگام صدور هر قرارداد (acquireIssueQuota) رخ می‌دهد.
 */
export async function assertCanIssue(workspaceId: number, count = 1, opts: { contractValue?: number | null } = {}): Promise<void> {
  await assertLicensedForIssue();
  await assertKycForValue(workspaceId, opts.contractValue);
  const plan = await getPlan(workspaceId);
  if (plan.contractsPerMonth < 0) return;
  const { contracts: used } = await getUsage(workspaceId);
  if (used + count <= plan.contractsPerMonth) return;
  const { credits } = await getWallet(workspaceId);
  if (credits >= count) return;
  throw limitError(plan);
}

/**
 * تعداد «صندلی‌های رزروشده» با دعوت‌نامه‌های باز: دعوت‌نامه‌ی منقضی‌نشده و پذیرفته‌نشده‌ی نقش تیمی.
 * فقط «ایمیل‌های متمایز» شمرده می‌شوند (ارسال دوباره‌ی لینک برای یک نفر، صندلی دوم نمی‌گیرد) و
 * ایمیلی که همین حالا عضو تیمی است دوباره شمرده نمی‌شود.
 */
export async function pendingSeatEmails(workspaceId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ email: sql<string>`lower(${workspaceInvites.email})` })
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        sql`${workspaceInvites.acceptedAt} is null`,
        sql`${workspaceInvites.expiresAt} > now()`,
        sql`${workspaceInvites.role} <> 'client'`,
        sql`not exists (select 1 from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${workspaceInvites.workspaceId} and lower(u.email) = lower(${workspaceInvites.email}) and m.role <> 'client')`,
      ),
    );
  return rows.map((r) => r.email);
}

const seatError = (plan: Plan) => new PlanLimitError(`طرح «${plan.name}» حداکثر ${plan.members} عضو تیم را پشتیبانی می‌کند. برای افزودن عضو، طرح را ارتقا دهید.`);

/**
 * پیش از «ساخت دعوت‌نامه»: اعضای فعلی + صندلی‌های رزروشده با دعوت‌های باز باید جای یک نفر دیگر داشته باشند.
 * (HX-01) پیش‌تر دعوت‌های باز شمرده نمی‌شدند ⇒ با ساخت انبوه دعوت‌نامه می‌شد بی‌نهایت صندلی «رزرو» کرد.
 * `email`: اگر برای همین ایمیل دعوت بازی هست، صندلی اضافه لازم نیست (ارسال دوباره‌ی لینک).
 * برای یکپارچگی «بخوان ← بنویس» فراخواننده باید داخل تراکنش و پس از `lockScope("team-seats", ws)` باشد (createInvite همین کار را می‌کند).
 */
export async function assertCanAddMember(workspaceId: number, opts: { email?: string } = {}) {
  const plan = await getPlan(workspaceId);
  if (plan.members < 0) return;
  const { members } = await getUsage(workspaceId);
  const pending = await pendingSeatEmails(workspaceId);
  const email = opts.email?.trim().toLowerCase();
  const reuses = !!email && pending.includes(email);
  if (!reuses && members + pending.length >= plan.members) throw seatError(plan);
}

/**
 * هنگام «پذیرش دعوت» (HX-01): سقف واقعی؛ عضو تیمیِ جدید فقط وقتی اضافه می‌شود که اعضای فعلی < سقف طرح.
 * دعوت‌نامه‌ی خودِ این فرد همان صندلی رزروشده است، پس فقط اعضا شمرده می‌شوند (نه دعوت‌های باز دیگر).
 * این سد «دیوار آخر» است: حتی دعوت‌های قدیمی (پیش از رفع)، دعوت‌های ساخته‌شده پیش از تنزل طرح، یا درخواست‌های هم‌زمان
 * نمی‌توانند تعداد اعضا را از سقف بالاتر ببرند. فراخواننده باید داخل تراکنش و پشت `lockScope("team-seats", ws)` باشد.
 */
export async function assertSeatFreeForAccept(workspaceId: number) {
  const plan = await getPlan(workspaceId);
  if (plan.members < 0) return;
  const { members } = await getUsage(workspaceId);
  if (members >= plan.members) throw seatError(plan);
}

export async function listPayments(workspaceId: number, limit = 20) {
  return db.select().from(payments).where(and(eq(payments.workspaceId, workspaceId), ne(payments.kind, "contract"))).orderBy(desc(payments.createdAt)).limit(limit);
}

/** شروع پرداخت اشتراک. مبلغ همیشه سمت سرور از روی طرح محاسبه می‌شود. */
export async function startCheckout(p: { workspaceId: number; userId: number; plan: string; months: number; origin: string; gateway?: string }): Promise<string> {
  const quote = await quotePurchase(p.workspaceId, p.plan, p.months);
  if (!quote.ok) throw new Error(quote.error);
  return startPayment({
    kind: "subscription",
    workspaceId: p.workspaceId,
    userId: p.userId,
    plan: quote.plan.id,
    months: p.months,
    amountToman: quote.amount,
    origin: p.origin,
    gateway: p.gateway,
    description: `اشتراک ${quote.plan.name} — ${p.months} ماه${quote.proration.creditValue > 0 ? " (با کسر اعتبار طرح قبلی)" : ""}`,
    proration: { listPrice: quote.proration.listPrice, credit: quote.proration.discount + Math.floor((quote.proration.bonusDays * quote.proration.listPrice) / (p.months * 30)), bonusDays: quote.proration.bonusDays },
  });
}

export { getSubscription, verifyPayment, reconcilePendingPayments };
export type { VerifyResult };

/** درآمد خالص = مبلغ پرداخت‌ها منهای بازپرداخت‌ها */
export async function platformRevenue() {
  const [r] = await db
    .select({
      total: sql<number>`coalesce(sum(${payments.amount} - ${payments.refundedAmount}) filter (where ${payments.status} = 'paid' and not ${payments.test} and ${payments.gateway} <> 'wallet' and ${payments.kind} <> 'contract'), 0)::bigint`,
      month: sql<number>`coalesce(sum(${payments.amount} - ${payments.refundedAmount}) filter (where ${payments.status} = 'paid' and not ${payments.test} and ${payments.gateway} <> 'wallet' and ${payments.kind} <> 'contract' and ${payments.paidAt} >= date_trunc('month', now())), 0)::bigint`,
      paying: sql<number>`(select count(*) from subscriptions where plan <> coalesce((select id from subscription_plans where is_default limit 1), 'free') and current_period_end > now())::int`,
    })
    .from(payments);
  return { total: Number(r?.total ?? 0), month: Number(r?.month ?? 0), paying: r?.paying ?? 0 };
}
