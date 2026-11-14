import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { payments, subscriptionPlans, subscriptions } from "@/db/schema";
import { DEFAULT_PLANS, comparePlans, setPlanRegistry, type Plan, type PlanId, type PlanInput } from "./plans";

/**
 * کاتالوگ پویای طرح‌های اشتراک (خواندن و مدیریت توسط مدیر کل).
 *
 * قواعد ثابت:
 *  - همیشه دقیقاً یک «طرح پیش‌فرض» وجود دارد (ایندکس یکتای جزئی)؛ باید رایگان و فعال باشد و حذف/بایگانی نمی‌شود.
 *  - طرحی که تا به حال اشتراک یا پرداختی داشته حذف سخت نمی‌شود؛ «بایگانی» می‌شود تا تاریخچه و مشترکان فعلی سالم بمانند.
 *  - تغییر قیمت/مدت فقط روی خریدهای بعدی اثر دارد؛ سقف‌ها (قرارداد/عضو/AI) برای همه‌ی مشترکان فوری اعمال می‌شود.
 */
export type CatalogExecutor = Pick<typeof db, "select" | "insert">;

type Row = typeof subscriptionPlans.$inferSelect;

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function rowToPlan(r: Row): Plan {
  const durations: Record<number, number> = {};
  const rawDurations = parseJson<Record<string, unknown>>(r.durations, {});
  for (const [m, d] of Object.entries(rawDurations && typeof rawDurations === "object" ? rawDurations : {})) {
    const months = Number(m);
    if (Number.isInteger(months) && months >= 1) durations[months] = Number(d) || 0;
  }
  return {
    id: r.id,
    name: r.name,
    tagline: r.tagline,
    priceToman: r.priceToman,
    contractsPerMonth: r.contractsPerMonth,
    members: r.members,
    aiPerDay: r.aiPerDay,
    features: ((f) => (Array.isArray(f) ? f.map(String) : []))(parseJson<unknown>(r.features, [])),
    highlight: r.highlight || undefined,
    durations,
    isPublic: r.isPublic,
    isDefault: r.isDefault,
    isActive: r.isActive,
    isRewardPlan: r.isRewardPlan,
    sortOrder: r.sortOrder,
  };
}

const planValues = (p: Plan) => ({
  id: p.id,
  name: p.name,
  tagline: p.tagline,
  priceToman: p.priceToman,
  contractsPerMonth: p.contractsPerMonth,
  members: p.members,
  aiPerDay: p.aiPerDay,
  features: JSON.stringify(p.features),
  durations: JSON.stringify(Object.fromEntries(Object.entries(p.durations).map(([m, d]) => [String(m), d]))),
  highlight: !!p.highlight,
  isPublic: p.isPublic,
  isDefault: p.isDefault,
  isActive: p.isActive,
  isRewardPlan: p.isRewardPlan,
  sortOrder: p.sortOrder,
});

/** همه‌ی طرح‌ها (به‌همراه بایگانی‌شده‌ها)؛ اگر جدول خالی باشد طرح‌های اولیه کاشته می‌شود */
export async function listAllPlans(exec: CatalogExecutor = db): Promise<Plan[]> {
  let rows = await exec.select().from(subscriptionPlans);
  if (rows.length === 0) {
    // دیتابیس تازه/ارتقاءیافته: کاشت یک‌باره‌ی طرح‌های اولیه (هم‌زمانی ایمن است: onConflictDoNothing)
    await exec.insert(subscriptionPlans).values(DEFAULT_PLANS.map(planValues)).onConflictDoNothing();
    rows = await exec.select().from(subscriptionPlans);
  }
  const plans = rows.map(rowToPlan).sort(comparePlans);
  setPlanRegistry(plans);
  return plans;
}

/** طرح‌های فعال (غیربایگانی) */
export async function listPlans(exec: CatalogExecutor = db): Promise<Plan[]> {
  return (await listAllPlans(exec)).filter((p) => p.isActive);
}

/** طرح‌های قابل نمایش عمومی (صفحه‌ی تعرفه، لندینگ، SEO): فعال و عمومی */
export async function listPublicPlans(exec: CatalogExecutor = db): Promise<Plan[]> {
  return (await listAllPlans(exec)).filter((p) => p.isActive && p.isPublic);
}

export function pickDefault(plans: Plan[]): Plan {
  return (
    plans.find((p) => p.isDefault) ??
    // دیتابیس دست‌کاری‌شده و بدون طرح پیش‌فرض: ارزان‌ترین طرح فعال، وگرنه طرح اولیه (سیستم هرگز بدون طرح پایه نمی‌ماند)
    [...plans].filter((p) => p.isActive).sort((a, b) => a.priceToman - b.priceToman)[0] ??
    DEFAULT_PLANS[0]
  );
}

export async function getDefaultPlan(exec: CatalogExecutor = db): Promise<Plan> {
  return pickDefault(await listAllPlans(exec));
}

/** یک طرح با شناسه (بایگانی‌شده هم برگردانده می‌شود تا تاریخچه و مشترکان قدیمی نمایش داده شوند) */
export async function getPlanById(id: PlanId | null | undefined, exec: CatalogExecutor = db): Promise<Plan | null> {
  if (!id) return null;
  return (await listAllPlans(exec)).find((p) => p.id === id) ?? null;
}

/** طرحی که پاداش دعوت روی آن فعال می‌شود: طرح پاداش، وگرنه ارزان‌ترین طرح پولی فعال */
export async function getRewardPlan(exec: CatalogExecutor = db): Promise<Plan | null> {
  const plans = (await listAllPlans(exec)).filter((p) => p.isActive && !p.isDefault);
  return plans.find((p) => p.isRewardPlan) ?? [...plans].sort((a, b) => a.priceToman - b.priceToman)[0] ?? null;
}

export type PlanStat = { activeSubscribers: number; totalSubscribers: number; payments: number };

/** آمار هر طرح برای پنل مدیر: مشترک فعال/کل و تعداد پرداخت‌ها */
export async function planStats(): Promise<Record<PlanId, PlanStat>> {
  const [subs, pays] = await Promise.all([
    db
      .select({
        plan: subscriptions.plan,
        total: sql<number>`count(*)::int`,
        active: sql<number>`(count(*) filter (where ${subscriptions.currentPeriodEnd} > now()))::int`,
      })
      .from(subscriptions)
      .groupBy(subscriptions.plan),
    db.select({ plan: payments.plan, n: sql<number>`count(*)::int` }).from(payments).groupBy(payments.plan),
  ]);
  const out: Record<PlanId, PlanStat> = {};
  const at = (id: string) => (out[id] ??= { activeSubscribers: 0, totalSubscribers: 0, payments: 0 });
  for (const s of subs) Object.assign(at(s.plan), { activeSubscribers: s.active, totalSubscribers: s.total });
  for (const p of pays) at(p.plan).payments = p.n;
  return out;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; error: string };

const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

/** ایجاد طرح جدید (هرگز پیش‌فرض نیست؛ برای پیش‌فرض کردن از setDefaultPlan استفاده کنید) */
export async function createPlan(input: PlanInput): Promise<PlanResult> {
  const plans = await listAllPlans();
  if (plans.some((p) => p.id === input.id)) return { ok: false, error: `شناسه‌ی «${input.id}» قبلاً استفاده شده است.` };
  if (input.isRewardPlan && !input.isActive) return { ok: false, error: "طرح بایگانی‌شده نمی‌تواند طرح پاداش دعوت باشد." };
  const plan: Plan = { ...input, highlight: input.highlight, isDefault: false };
  try {
    await db.transaction(async (tx) => {
      if (plan.isRewardPlan) await tx.update(subscriptionPlans).set({ isRewardPlan: false }).where(eq(subscriptionPlans.isRewardPlan, true));
      await tx.insert(subscriptionPlans).values(planValues(plan));
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: `شناسه‌ی «${input.id}» قبلاً استفاده شده است.` };
    throw e;
  }
  return { ok: true, plan: (await getPlanById(input.id))! };
}

/** ویرایش طرح (شناسه تغییر نمی‌کند) */
export async function updatePlan(id: PlanId, input: PlanInput): Promise<PlanResult> {
  const cur = await getPlanById(id);
  if (!cur) return { ok: false, error: "طرح پیدا نشد." };
  let next: Plan = { ...input, id, isDefault: cur.isDefault };
  if (cur.isDefault) {
    if (input.priceToman !== 0) return { ok: false, error: "طرح پیش‌فرض باید رایگان باشد؛ برای قیمت‌دار کردن آن، ابتدا طرح پیش‌فرض دیگری انتخاب کنید." };
    if (input.isRewardPlan) return { ok: false, error: "طرح پیش‌فرض نمی‌تواند طرح پاداش دعوت باشد." };
    next = { ...next, isActive: true }; // پایه همیشه فعال است
  }
  if (!next.isActive) next = { ...next, isRewardPlan: false };
  await db.transaction(async (tx) => {
    if (next.isRewardPlan) await tx.update(subscriptionPlans).set({ isRewardPlan: false }).where(and(eq(subscriptionPlans.isRewardPlan, true), ne(subscriptionPlans.id, id)));
    const { id: _id, ...values } = planValues(next);
    await tx.update(subscriptionPlans).set({ ...values, updatedAt: new Date() }).where(eq(subscriptionPlans.id, id));
  });
  return { ok: true, plan: (await getPlanById(id))! };
}

/** انتخاب طرح پیش‌فرض: باید فعال و رایگان باشد؛ اتمی (هیچ‌وقت صفر یا دو پیش‌فرض نداریم) */
export async function setDefaultPlan(id: PlanId): Promise<PlanResult> {
  const target = await getPlanById(id);
  if (!target) return { ok: false, error: "طرح پیدا نشد." };
  if (!target.isActive) return { ok: false, error: "طرح بایگانی‌شده را نمی‌توان پیش‌فرض کرد؛ ابتدا آن را فعال کنید." };
  if (target.priceToman !== 0) return { ok: false, error: "طرح پیش‌فرض باید رایگان باشد؛ ابتدا قیمت این طرح را صفر کنید." };
  await db.transaction(async (tx) => {
    await tx.update(subscriptionPlans).set({ isDefault: false, updatedAt: new Date() }).where(and(eq(subscriptionPlans.isDefault, true), ne(subscriptionPlans.id, id)));
    await tx.update(subscriptionPlans).set({ isDefault: true, isRewardPlan: false, updatedAt: new Date() }).where(eq(subscriptionPlans.id, id));
  });
  return { ok: true, plan: (await getPlanById(id))! };
}

export type DeleteResult = { ok: true; mode: "deleted" | "archived" } | { ok: false; error: string };

/**
 * حذف طرح. طرح بدون سابقه‌ی اشتراک/پرداخت کاملاً حذف می‌شود؛ در غیر این صورت بایگانی می‌شود
 * (از فروش و نمایش خارج می‌شود، ولی مشترکان فعلی تا پایان دوره و تاریخچه‌ی پرداخت‌ها دست‌نخورده می‌مانند).
 */
export async function deletePlan(id: PlanId): Promise<DeleteResult> {
  const cur = await getPlanById(id);
  if (!cur) return { ok: false, error: "طرح پیدا نشد." };
  if (cur.isDefault) return { ok: false, error: "طرح پیش‌فرض قابل حذف نیست؛ ابتدا طرح پیش‌فرض دیگری را انتخاب کنید." };
  return db.transaction(async (tx) => {
    const [s] = await tx.select({ n: sql<number>`count(*)::int` }).from(subscriptions).where(eq(subscriptions.plan, id));
    const [p] = await tx.select({ n: sql<number>`count(*)::int` }).from(payments).where(eq(payments.plan, id));
    if ((s?.n ?? 0) + (p?.n ?? 0) > 0) {
      await tx.update(subscriptionPlans).set({ isActive: false, isPublic: false, isRewardPlan: false, updatedAt: new Date() }).where(eq(subscriptionPlans.id, id));
      return { ok: true as const, mode: "archived" as const };
    }
    await tx.delete(subscriptionPlans).where(eq(subscriptionPlans.id, id));
    return { ok: true as const, mode: "deleted" as const };
  });
}
