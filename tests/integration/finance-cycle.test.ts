import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, invoices, payments, refunds, subscriptionNotices, subscriptions, userNotifications, users, webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";
import { listAllPlans } from "@/modules/billing/catalog";
import { quotePurchase } from "@/modules/billing/purchase";
import { activateSubscription, getSubscription } from "@/modules/billing/subscription";
import { computeProration } from "@/modules/billing/proration";
import { getInvoice, invoiceByPayment, invoiceItems, issueInvoiceForPayment, issueMissingInvoices, renderInvoicePdf, splitInclusiveTax } from "@/modules/billing/invoices";
import { refundPayment } from "@/modules/billing/refunds";
import { noticeStageFor, runSubscriptionReminders } from "@/modules/billing/reminders";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { creditToman, getWallet } from "@/modules/wallet/service";
import { queryContracts } from "@/modules/contracts/service";
import { buildTsQuery, normalizeSearchText } from "@/modules/contracts/service/fulltext";
import { emitEvent } from "@/modules/webhooks/service";
import { processDueWebhookRetries, retryDeliveryNow } from "@/modules/webhooks/retry";
import * as deliverMod from "@/modules/webhooks/deliver";
import { uniq } from "../helpers";

/**
 * چرخه‌ی مالی بالغ: فاکتور رسمی، Proration، یادآوری/بازپرداخت، تلاش مجدد وب‌هوک و جستجوی متن کامل.
 * (فایل جدید؛ هیچ آزمون موجودی تغییر نکرده است.)
 */
vi.mock("@/modules/webhooks/deliver", async (orig) => {
  const real = await orig<typeof import("@/modules/webhooks/deliver")>();
  return { ...real, deliver: vi.fn(async () => undefined) };
});

let seq = 0;
async function makeUser() {
  const [u] = await db.insert(users).values({ name: "مالی", email: `${uniq("fin")}@example.com`, mobile: `0914${String(3000000 + ++seq * 13)}`, passwordHash: hashPassword("Fin12345xy"), emailVerifiedAt: new Date() }).returning();
  const ws = await createWorkspace(u.id, `فضای مالی ${seq}`);
  return { ...u, ws };
}
const topup = (ws: number, amount: number) => creditToman(ws, amount, { kind: "topup", ref: uniq("tp"), description: "شارژ آزمون" });
const DAY = 86_400_000;

describe("مالیات و شماره‌ی فاکتور", () => {
  it("مالیات شامل‌شده در قیمت درست جدا می‌شود", () => {
    expect(splitInclusiveTax(110_000, 10)).toEqual({ subtotal: 100_000, tax: 10_000 });
    expect(splitInclusiveTax(490_000, 0)).toEqual({ subtotal: 490_000, tax: 0 });
    const neg = splitInclusiveTax(-110_000, 10);
    expect(neg).toEqual({ subtotal: -100_000, tax: -10_000 });
  });
});

describe("Proration + فاکتور رسمی + بازپرداخت", () => {
  beforeAll(async () => {
    await listAllPlans();
  });

  it("ارتقا وسط دوره: روزهای باقی‌مانده کسر می‌شود و فاکتور شامل ردیف اعتبار است", async () => {
    const u = await makeUser();
    await topup(u.ws, 5_000_000);
    expect((await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 })).ok).toBe(true);
    // وسط دوره: ۱۵ روز مانده
    await db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + 15 * DAY) }).where(eq(subscriptions.workspaceId, u.ws));
    const q = await quotePurchase(u.ws, "business", 1);
    if (!q.ok) throw new Error(q.error);
    const expectedCredit = Math.floor(15 * (490_000 / 30));
    expect(Math.abs(q.proration.creditValue - expectedCredit)).toBeLessThan(500);
    expect(q.amount).toBe(q.proration.listPrice - q.proration.discount);
    expect(q.amount).toBeLessThan(q.proration.listPrice);
    // تمدید هم‌طرح اعتبار ندارد
    const same = await quotePurchase(u.ws, "pro", 1);
    expect(same.ok && same.proration.creditValue).toBe(0);

    const before = (await getWallet(u.ws)).balance;
    expect((await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "business", months: 1 })).ok).toBe(true);
    expect(before - (await getWallet(u.ws)).balance).toBe(q.amount);
    expect((await getSubscription(u.ws)).planId).toBe("business");
    const [pay] = await db.select().from(payments).where(and(eq(payments.workspaceId, u.ws), eq(payments.plan, "business")));
    expect(pay.amount).toBe(q.amount);
    expect(pay.listPrice).toBe(q.proration.listPrice);
    const inv = await invoiceByPayment(pay.id);
    expect(inv).not.toBeNull();
    expect(inv!.total).toBe(q.amount);
    expect(inv!.taxAmount + inv!.subtotal).toBe(inv!.total);
    expect(invoiceItems(inv!).some((i) => i.amount < 0)).toBe(true);
    expect(inv!.number).toMatch(/^INV-\d{4}-\d{6}$/);
  });

  it("کاهش طرح: اعتبار مازاد به روزهای هدیه تبدیل می‌شود و هیچ‌چیز نمی‌سوزد", async () => {
    const u = await makeUser();
    await topup(u.ws, 20_000_000);
    expect((await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "business", months: 12 })).ok).toBe(true);
    await db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + 300 * DAY) }).where(eq(subscriptions.workspaceId, u.ws));
    const plans = await listAllPlans();
    const pro = plans.find((p) => p.id === "pro")!;
    const pr = await computeProration(u.ws, pro, 1);
    expect(pr.payable).toBeGreaterThanOrEqual(1000);
    expect(pr.bonusDays).toBeGreaterThan(0);
    const r = await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    expect(r.ok).toBe(true);
    const sub = await getSubscription(u.ws);
    expect(sub.planId).toBe("pro");
    const days = (sub.periodEnd!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(30 + pr.bonusDays - 1);
  });

  it("شماره‌ی فاکتور پیوسته، صدور ایدمپوتنت و PDF معتبر", async () => {
    const u = await makeUser();
    await topup(u.ws, 3_000_000);
    await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    const [pay] = await db.select().from(payments).where(eq(payments.workspaceId, u.ws));
    const a = await db.transaction((tx) => issueInvoiceForPayment(tx, pay.id));
    const b = await db.transaction((tx) => issueInvoiceForPayment(tx, pay.id));
    expect(a!.id).toBe(b!.id);
    expect(await db.select().from(invoices).where(eq(invoices.paymentId, pay.id))).toHaveLength(1);
    const pdf = await renderInvoicePdf((await getInvoice(a!.id))!);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // شارژ کیف پول فاکتور ندارد
    expect(await issueMissingInvoices()).toBeGreaterThanOrEqual(0);
    const u2 = await makeUser();
    await topup(u2.ws, 3_000_000);
    await payPlanWithWallet({ workspaceId: u2.ws, userId: u2.id, plan: "pro", months: 1 });
    const [p2] = await db.select().from(payments).where(eq(payments.workspaceId, u2.ws));
    const second = await invoiceByPayment(p2.id);
    expect(second!.seq).toBe(a!.seq + 1);
  });

  it("بازپرداخت: کیف پول شارژ، اعلامیه‌ی بستانکاری، سقف مبلغ و لغو اشتراک", async () => {
    const u = await makeUser();
    await topup(u.ws, 2_000_000);
    await payPlanWithWallet({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1 });
    const [pay] = await db.select().from(payments).where(eq(payments.workspaceId, u.ws));
    const walletBefore = (await getWallet(u.ws)).balance;
    expect((await refundPayment({ paymentId: pay.id, amount: 100_000, reason: "", method: "wallet", revokeSubscription: false, actorId: u.id })).ok).toBe(false); // دلیل الزامی
    const r1 = await refundPayment({ paymentId: pay.id, amount: 100_000, reason: "نارضایتی", method: "wallet", revokeSubscription: false, actorId: u.id });
    expect(r1.ok).toBe(true);
    expect((await getWallet(u.ws)).balance).toBe(walletBefore + 100_000);
    const inv = (await invoiceByPayment(pay.id))!;
    expect(inv.status).toBe("partially_refunded");
    const [note] = await db.select().from(invoices).where(and(eq(invoices.relatedInvoiceId, inv.id), eq(invoices.kind, "credit_note")));
    expect(note.total).toBe(-100_000);
    expect(note.number).toMatch(/^CN-\d{4}-\d{6}$/);
    // بیش از باقی‌مانده ممکن نیست؛ دو بازپرداخت هم‌زمان هم از سقف نمی‌گذرد
    expect((await refundPayment({ paymentId: pay.id, amount: pay.amount, reason: "زیاد", method: "wallet", revokeSubscription: false, actorId: u.id })).ok).toBe(false);
    const rest = pay.amount - 100_000;
    const results = await Promise.all([1, 2, 3].map(() => refundPayment({ paymentId: pay.id, reason: "تسویه", method: "wallet", revokeSubscription: true, actorId: u.id })));
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    const [after] = await db.select().from(payments).where(eq(payments.id, pay.id));
    expect(after.refundedAmount).toBe(pay.amount);
    expect((await getWallet(u.ws)).balance).toBe(walletBefore + 100_000 + rest);
    expect((await invoiceByPayment(pay.id))!.status).toBe("refunded");
    expect((await getSubscription(u.ws)).planId).toBe("free");
    expect(await db.select().from(refunds).where(eq(refunds.paymentId, pay.id))).toHaveLength(2);
  });

  it("پرداخت آزمایشی فقط «دستی» قابل بازپرداخت است (پول جعلی وارد کیف پول نمی‌شود)", async () => {
    const u = await makeUser();
    const [pay] = await db.insert(payments).values({ workspaceId: u.ws, userId: u.id, plan: "pro", months: 1, amount: 490_000, gateway: "sandbox", kind: "subscription", test: true, authority: uniq("sbx-auth-0000"), status: "paid", paidAt: new Date(), fulfilledAt: new Date(), refId: "T1" }).returning();
    const bad = await refundPayment({ paymentId: pay.id, reason: "تست", method: "wallet", revokeSubscription: false, actorId: u.id });
    expect(bad.ok).toBe(false);
    const ok = await refundPayment({ paymentId: pay.id, reason: "تست", method: "manual", revokeSubscription: false, actorId: u.id });
    expect(ok.ok).toBe(true);
    expect((await getWallet(u.ws)).balance).toBe(0);
  });
});

describe("یادآوری انقضای اشتراک", () => {
  it("مرحله‌ی یادآوری از روی روزهای مانده تعیین می‌شود", () => {
    const now = new Date();
    expect(noticeStageFor(new Date(now.getTime() + 20 * DAY), now)).toBeNull();
    expect(noticeStageFor(new Date(now.getTime() + 6 * DAY), now)).toBe("d7");
    expect(noticeStageFor(new Date(now.getTime() + 2 * DAY), now)).toBe("d3");
    expect(noticeStageFor(new Date(now.getTime() + 5 * 3600_000), now)).toBe("d1");
    expect(noticeStageFor(new Date(now.getTime() - DAY), now)).toBe("expired");
    expect(noticeStageFor(new Date(now.getTime() - 10 * DAY), now)).toBeNull();
  });

  it("هر مرحله برای هر دوره فقط یک‌بار؛ با تمدید دوباره یادآوری می‌شود", async () => {
    const u = await makeUser();
    await activateSubscription(u.ws, "pro", 1);
    await db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + 2 * DAY) }).where(eq(subscriptions.workspaceId, u.ws));
    await runSubscriptionReminders();
    const mine = () => db.select().from(subscriptionNotices).where(eq(subscriptionNotices.workspaceId, u.ws));
    expect((await mine()).map((n) => n.stage)).toEqual(["d3"]);
    const notices = await db.select().from(userNotifications).where(eq(userNotifications.userId, u.id));
    expect(notices.some((n) => n.title.includes("۳ روز"))).toBe(true);
    await runSubscriptionReminders();
    expect(await mine()).toHaveLength(1);
    await db.update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() + 20 * 3600_000) }).where(eq(subscriptions.workspaceId, u.ws));
    await runSubscriptionReminders();
    expect((await mine()).map((n) => n.stage).sort()).toEqual(["d1", "d3"]);
  });
});

describe("تلاش مجدد وب‌هوک‌های خروجی", () => {
  const deliver = vi.mocked(deliverMod.deliver);
  async function setup() {
    const u = await makeUser();
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: u.ws, name: "وردپرس", provider: "generic", target: "https://example.com/hook", secret: "s", events: "*" }).returning();
    return { u, ep };
  }
  const rowsOf = (epId: number) => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, epId)).orderBy(desc(webhookDeliveries.id));
  async function waitRows(epId: number) {
    for (let i = 0; i < 50; i++) {
      const r = await rowsOf(epId);
      if (r.length) return r;
      await new Promise((r2) => setTimeout(r2, 40));
    }
    return [];
  }

  it("خطای موقت در صف می‌ماند و در تلاش بعدی موفق می‌شود (با شناسه‌ی یکتا)", async () => {
    const { u, ep } = await setup();
    deliver.mockRejectedValueOnce(new Error("HTTP 503"));
    emitEvent({ event: "test", workspaceId: u.ws, text: "x" });
    // «test» هرگز retry نمی‌شود
    const t = await waitRows(ep.id);
    expect(t[0].status).toBe("dead");
    await db.delete(webhookDeliveries).where(eq(webhookDeliveries.endpointId, ep.id));

    deliver.mockRejectedValueOnce(new Error("HTTP 503"));
    emitEvent({ event: "contract.signed", workspaceId: u.ws, text: "قرارداد امضا شد" });
    const [d] = await waitRows(ep.id);
    expect(d.status).toBe("failed");
    expect(d.attempts).toBe(1);
    expect(d.nextRetryAt).not.toBeNull();
    expect(d.payload).toContain("deliveryKey");
    // هنوز سررسید نشده: جاروکننده کاری نمی‌کند
    expect(await processDueWebhookRetries()).toBe(0);
    await db.update(webhookDeliveries).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(webhookDeliveries.id, d.id));
    deliver.mockResolvedValueOnce(undefined);
    expect(await processDueWebhookRetries()).toBeGreaterThanOrEqual(1);
    const [done] = await rowsOf(ep.id);
    expect(done.status).toBe("ok");
    expect(done.attempts).toBe(2);
    expect(done.payload).toBeNull();
    const call = deliver.mock.calls.at(-1)!;
    expect(call[1].deliveryKey).toBeTruthy();
    expect(call[2]).toBe(2);
  });

  it("خطای دائمی (403) مستقیم متوقف می‌شود؛ پس از رفع، «تلاش دستی» موفق است", async () => {
    const { u, ep } = await setup();
    deliver.mockRejectedValueOnce(new Error("HTTP 403"));
    emitEvent({ event: "contract.signed", workspaceId: u.ws, text: "الف" });
    const [d] = await waitRows(ep.id);
    expect(d.status).toBe("dead");
    expect(d.nextRetryAt).toBeNull();
    deliver.mockResolvedValueOnce(undefined);
    expect((await retryDeliveryNow(d.id, u.ws)).ok).toBe(true);
    expect((await rowsOf(ep.id))[0].status).toBe("ok");
    // فضای کاری دیگر نمی‌تواند تلاش دستی بزند
    const other = await makeUser();
    expect((await retryDeliveryNow(d.id, other.ws)).ok).toBe(false);
  });

  it("پس از ۶ تلاش ناموفق dead می‌شود و تیم باخبر می‌شود", async () => {
    const { u, ep } = await setup();
    deliver.mockRejectedValue(new Error("fetch failed"));
    emitEvent({ event: "contract.signed", workspaceId: u.ws, text: "ب" });
    const [d] = await waitRows(ep.id);
    for (let i = 0; i < 5; i++) {
      await db.update(webhookDeliveries).set({ nextRetryAt: new Date(Date.now() - 1000) }).where(eq(webhookDeliveries.id, d.id));
      await processDueWebhookRetries();
    }
    const [last] = await rowsOf(ep.id);
    expect(last.status).toBe("dead");
    expect(last.attempts).toBe(6);
    const notices = await db.select().from(userNotifications).where(eq(userNotifications.userId, u.id));
    expect(notices.some((n) => n.title.includes("وب‌هوک"))).toBe(true);
    deliver.mockReset();
    deliver.mockResolvedValue(undefined);
  });
});

describe("جستجوی متن کامل قراردادها", () => {
  it("نرمال‌سازی و ساخت عبارت جستجو", () => {
    expect(normalizeSearchText("كتاب ي ۱۲۳")).toBe("کتاب ی 123");
    expect(buildTsQuery("حق فسخ")).toBe("'حق':* & 'فسخ':*");
    expect(buildTsQuery("a'b); drop")).toBe("'a':* & 'b':* & 'drop':*");
    expect(buildTsQuery("  «» ")).toBeNull();
  });

  it("متن قرارداد (نه فقط عنوان) جستجو می‌شود؛ تگ‌های HTML نه", async () => {
    const u = await makeUser();
    const mk = (title: string, bodyHtml: string) => db.insert(contracts).values({ workspaceId: u.ws, number: uniq("FT-"), title, customerId: u.id, bodyHtml, status: "sent" }).returning();
    const [a] = await mk("قرارداد خدمات", "<p>طرفین در صورت تاخیر بیش از ۳۰ روز، <b>حق فسخ</b> دارند. ضمانت‌نامه ي بانکی</p>");
    const [b] = await mk("قرارداد اجاره", `<p class="secret-class">مدت اجاره یک سال است.</p>`);
    const ids = async (q: string) => (await queryContracts(u.ws, { q })).rows.map((r) => r.id);
    expect(await ids("حق فسخ")).toEqual([a.id]);
    expect(await ids("فس")).toEqual([a.id]); // پیشوند
    expect(await ids("ضمانت نامه")).toEqual([a.id]); // نیم‌فاصله ≡ فاصله
    expect(await ids("ضمانت‌نامه")).toEqual([a.id]); // نیم‌فاصله
    expect(await ids("بانكی")).toEqual([a.id]); // «ك» عربی
    expect(await ids("۳۰ روز")).toEqual([a.id]); // رقم فارسی
    expect(await ids("اجاره")).toEqual([b.id]); // عنوان هم جستجو می‌شود
    expect(await ids("secret-class")).toEqual([]); // ویژگی تگ، متن قرارداد نیست
    const { rows } = await queryContracts(u.ws, { q: "حق فسخ" });
    expect(rows[0].snippet).toContain("⟦");
    // فضای دیگر هرگز نتیجه نمی‌گیرد
    const other = await makeUser();
    expect((await queryContracts(other.ws, { q: "حق فسخ" })).rows).toHaveLength(0);
  });
});
