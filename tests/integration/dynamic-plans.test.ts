import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments, subscriptionPlans, subscriptions, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";
import { createPlan, deletePlan, getDefaultPlan, getPlanById, getRewardPlan, listAllPlans, listPublicPlans, setDefaultPlan, updatePlan } from "@/modules/billing/catalog";
import { DEFAULT_PLANS, parsePlanInput, planPrice, priceFor, type PlanInput } from "@/modules/billing/plans";
import { quotePurchase } from "@/modules/billing/purchase";
import { acquireIssueQuota, assertCanAddMember, getPlan, PlanLimitError, startCheckout } from "@/modules/billing/service";
import { activateSubscription, getSubscription, grantFreeDays, revokeSubscription } from "@/modules/billing/subscription";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { creditToman } from "@/modules/wallet/service";
import { uniq } from "../helpers";

/**
 * طرح‌های اشتراک پویا: کاتالوگ در دیتابیس است و مدیر کل بدون تغییر کد می‌تواند بسازد/ویرایش/حذف کند.
 * (این فایل جدید است؛ هیچ آزمون موجودی تغییر نکرده است.)
 */
let seq = 0;
async function makeUser() {
  const [u] = await db.insert(users).values({ name: "پلن", email: `${uniq("pl")}@example.com`, mobile: `0913${String(2000000 + ++seq * 11)}`, passwordHash: hashPassword("Plan12345x"), emailVerifiedAt: new Date() }).returning();
  const ws = await createWorkspace(u.id, `فضای پلن ${seq}`);
  return { ...u, ws };
}

const input = (o: Partial<PlanInput> = {}): PlanInput => ({
  id: "starter", name: "استارتر", tagline: "", priceToman: 100_000, contractsPerMonth: 5, members: 3, aiPerDay: 4,
  features: [], durations: { 1: 0, 12: 30 }, highlight: false, isPublic: true, isActive: true, isRewardPlan: false, sortOrder: 15, ...o,
});

describe("کاتالوگ پویای طرح‌ها", () => {
  beforeAll(async () => {
    await listAllPlans(); // کاشت یک‌باره
  });
  // دیتابیس بین فایل‌های آزمون مشترک است: کاتالوگ را به حالت اولیه برگردان (بقیه‌ی آزمون‌ها به «pro»/«business» اولیه وابسته‌اند)
  afterAll(async () => {
    await db.delete(subscriptionPlans);
    await listAllPlans();
  });

  it("طرح‌های اولیه کاشته می‌شوند و دقیقاً یک پیش‌فرض دارند؛ قیمت‌ها با نسخه‌ی قدیمی یکی است", async () => {
    const all = await listAllPlans();
    for (const d of DEFAULT_PLANS) expect(all.find((p) => p.id === d.id)?.priceToman).toBe(d.priceToman);
    expect(all.filter((p) => p.isDefault)).toHaveLength(1);
    expect((await getDefaultPlan()).id).toBe("free");
    expect(priceFor("pro", 1)).toBe(490_000);
    expect(priceFor("pro", 12)).toBe(Math.round((490_000 * 12 * 0.75) / 1000) * 1000);
  });

  it("ساخت طرح: بلافاصله قابل خرید، با قیمت و مدت‌های خودش؛ شناسه‌ی تکراری رد می‌شود", async () => {
    const r = await createPlan(input());
    expect(r.ok).toBe(true);
    expect((await createPlan(input())).ok).toBe(false);
    const u = await makeUser();
    const q = await quotePurchase(u.ws, "starter", 12);
    expect(q.ok && q.amount).toBe(planPrice({ priceToman: 100_000, durations: { 1: 0, 12: 30 } }, 12));
    // مدتی که تعریف نشده خرید ندارد
    expect((await quotePurchase(u.ws, "starter", 3)).ok).toBe(false);
    expect(priceFor("starter", 1)).toBe(100_000);
  });

  it("تغییر قیمت و سقف‌ها فوراً اعمال می‌شود (پرداخت، سقف قرارداد و عضو)", async () => {
    const u = await makeUser();
    await activateSubscription(u.ws, "starter", 1);
    expect((await getSubscription(u.ws)).planId).toBe("starter");
    expect((await getPlan(u.ws)).contractsPerMonth).toBe(5);
    await updatePlan("starter", input({ priceToman: 250_000, contractsPerMonth: 2, members: 1 }));
    expect((await getPlan(u.ws)).contractsPerMonth).toBe(2);
    const q = await quotePurchase(u.ws, "starter", 1);
    expect(q.ok && q.amount).toBe(250_000);
    await expect(assertCanAddMember(u.ws)).rejects.toBeInstanceOf(PlanLimitError); // مالک خودش ۱ عضو است
    await updatePlan("starter", input({ contractsPerMonth: -1, members: -1, priceToman: 250_000 }));
    await expect(acquireIssueQuota(u.ws, 50)).resolves.toBeTruthy(); // نامحدود
    await expect(assertCanAddMember(u.ws)).resolves.toBeUndefined();
  });

  it("مبلغ پرداخت و پرداخت با کیف پول از قیمت دیتابیس محاسبه می‌شود", async () => {
    const u = await makeUser();
    await createPlan(input({ id: "wallet-plan", name: "کیف پولی", priceToman: 70_000, durations: { 2: 10 } }));
    await creditToman(u.ws, 500_000, { kind: "topup", ref: `t:${u.ws}`, description: "test", userId: u.id });
    const r = await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "wallet-plan", months: 2 });
    expect(r.ok).toBe(true);
    const [pay] = await db.select().from(payments).where(eq(payments.workspaceId, u.ws));
    expect(pay.amount).toBe(planPrice({ priceToman: 70_000, durations: { 2: 10 } }, 2));
    expect((await getSubscription(u.ws)).planId).toBe("wallet-plan");
    await expect(startCheckout({ workspaceId: u.ws, userId: u.id, plan: "wallet-plan", months: 1, origin: "http://localhost:3000" })).rejects.toThrow(/مدت/);
  });

  it("طرح خصوصی در فهرست عمومی نیست و فقط با اختصاص دستی (یا تمدید) قابل استفاده است", async () => {
    await createPlan(input({ id: "vip", name: "ویژه", isPublic: false, priceToman: 900_000, durations: { 1: 0 } }));
    expect((await listPublicPlans()).some((p) => p.id === "vip")).toBe(false);
    const u = await makeUser();
    expect((await quotePurchase(u.ws, "vip", 1)).ok).toBe(false);
    await activateSubscription(u.ws, "vip", 1);
    expect((await getSubscription(u.ws)).planId).toBe("vip");
    expect((await quotePurchase(u.ws, "vip", 1)).ok).toBe(true); // تمدید
  });

  it("پیش‌فرض: باید رایگان باشد؛ تعویض اتمی است و حذف طرح پیش‌فرض ممنوع", async () => {
    expect((await deletePlan("free")).ok).toBe(false);
    expect((await setDefaultPlan("pro")).ok).toBe(false); // قیمت‌دار
    await createPlan(input({ id: "basic0", name: "پایه", priceToman: 0, isPublic: false, durations: { 1: 0 } }));
    expect((await setDefaultPlan("basic0")).ok).toBe(true);
    expect((await listAllPlans()).filter((p) => p.isDefault).map((p) => p.id)).toEqual(["basic0"]);
    const u = await makeUser();
    expect((await getSubscription(u.ws)).planId).toBe("basic0");
    expect((await updatePlan("basic0", input({ id: "basic0", priceToman: 10 }))).ok).toBe(false);
    expect((await setDefaultPlan("free")).ok).toBe(true);
    expect((await listAllPlans()).filter((p) => p.isDefault).map((p) => p.id)).toEqual(["free"]);
  });

  it("حذف: بدون سابقه کامل حذف می‌شود؛ با اشتراک بایگانی می‌شود و مشترک فعلی تا پایان دوره حفظ می‌شود", async () => {
    await createPlan(input({ id: "temp", name: "موقت" }));
    expect(await deletePlan("temp")).toEqual({ ok: true, mode: "deleted" });
    expect(await getPlanById("temp")).toBeNull();

    const u = await makeUser();
    await activateSubscription(u.ws, "starter", 1);
    expect(await deletePlan("starter")).toEqual({ ok: true, mode: "archived" });
    const arch = await getPlanById("starter");
    expect(arch?.isActive).toBe(false);
    expect((await getSubscription(u.ws)).planId).toBe("starter"); // مشترک فعلی حفظ شد
    const other = await makeUser();
    expect((await quotePurchase(other.ws, "starter", 1)).ok).toBe(false); // دیگر فروخته نمی‌شود
    expect((await listPublicPlans()).some((p) => p.id === "starter")).toBe(false);
    // پرداخت از پیش انجام‌شده‌ی طرح بایگانی‌شده همچنان فعال می‌شود
    await expect(activateSubscription(other.ws, "starter", 1)).resolves.toMatchObject({ applied: true });
  });

  it("پاداش دعوت روی طرح پاداش (قابل تنظیم) فعال می‌شود و پس از انقضا به پیش‌فرض برمی‌گردد", async () => {
    expect((await getRewardPlan())?.id).toBe("pro");
    await updatePlan("business", { ...input({ id: "business", name: "سازمانی", priceToman: 1_490_000, isRewardPlan: true }) });
    expect((await getRewardPlan())?.id).toBe("business");
    const u = await makeUser();
    expect(await grantFreeDays(u.ws, 7)).toBe("business");
    expect((await getSubscription(u.ws)).planId).toBe("business");
    await updatePlan("pro", input({ id: "pro", name: "حرفه‌ای", priceToman: 490_000, isRewardPlan: true }));
    expect((await getRewardPlan())?.id).toBe("pro");
    await revokeSubscription(u.ws);
    expect((await getSubscription(u.ws)).planId).toBe("free");
    // اشتراک منقضی‌شده‌ی طرح پولی → طرح پیش‌فرض
    await db.insert(subscriptions).values({ workspaceId: u.ws, plan: "pro", currentPeriodEnd: new Date(Date.now() - 1000) });
    const exp = await getSubscription(u.ws);
    expect(exp).toMatchObject({ planId: "free", expired: true });
  });

  it("ورودی نامعتبر مدیر رد می‌شود", () => {
    const base = { id: "ok-plan", name: "x", priceToman: "1000", contractsPerMonth: "5", members: "2", aiPerDay: "1", durations: "1:0" };
    expect(parsePlanInput(base, { requireId: true }).ok).toBe(true);
    expect(parsePlanInput({ ...base, id: "Bad Id" }, { requireId: true }).ok).toBe(false);
    expect(parsePlanInput({ ...base, priceToman: "-5" }, { requireId: true }).ok).toBe(false);
    expect(parsePlanInput({ ...base, durations: "0:5" }, { requireId: true }).ok).toBe(false);
    expect(parsePlanInput({ ...base, durations: "1:95" }, { requireId: true }).ok).toBe(false);
    expect(parsePlanInput({ ...base, name: " " }, { requireId: true }).ok).toBe(false);
    const fa = parsePlanInput({ ...base, priceToman: "۴۹۰٬۰۰۰", durations: "۱:۰، ۱۲:۲۵", contractsUnlimited: "on" }, { requireId: true });
    expect(fa.ok && fa.value.priceToman).toBe(490_000);
    expect(fa.ok && fa.value.contractsPerMonth).toBe(-1);
    expect(fa.ok && fa.value.durations).toEqual({ 1: 0, 12: 25 });
  });

  it("پایگاه داده: بیش از یک پیش‌فرض ممکن نیست", async () => {
    await expect(db.update(subscriptionPlans).set({ isDefault: true }).where(eq(subscriptionPlans.id, "pro"))).rejects.toThrow();
  });
});
