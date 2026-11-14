import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { payments, users, walletTransactions } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";
import { activateSubscription, getSubscription } from "@/modules/billing/subscription";
import { reconcilePendingPayments, startPayment, verifyPayment } from "@/modules/payments/service";
import { startCheckout } from "@/modules/billing/service";
import { creditToman, getWallet } from "@/modules/wallet/service";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { uniq } from "../helpers";

/**
 * CR-02 / DB-06: اعمال پرداخت باید اتمی و ایدمپوتنت باشد.
 *  - «paid شدن» و «اعمال اثر» در یک تراکنش‌اند؛ شکست/کرش وسط کار = rollback کامل (نه paid بدون اثر)
 *  - activateSubscription با شناسه‌ی پرداخت دوبار تمدید نمی‌کند
 *  - باقیمانده‌ی «paid بدون اثر» (داده‌ی قدیمی) توسط reconcile ترمیم می‌شود
 */
const origin = "http://localhost:3000";
const DAY = 86400_000;
let userId = 0;
let seq = 0;

beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "اتمیک", email: `${uniq("atom")}@example.com`, mobile: "09120000077", passwordHash: hashPassword("Atom12345x"), emailVerifiedAt: new Date() }).returning();
  userId = u.id;
});

const newWs = () => createWorkspace(userId, `فضای اتمیک ${++seq}`);
const authorityOf = (url: string) => new URL(url).searchParams.get("Authority")!;
const rowOf = async (authority: string) => (await db.select().from(payments).where(eq(payments.authority, authority)))[0];
const near = (t: number, days: number) => Math.abs(t - (Date.now() + days * DAY)) < 60_000;

/** تریگر دیتابیس که هر نوشتن روی subscriptions را رد می‌کند = شبیه‌سازی مرگ/خطا بعد از «paid» شدن و پیش از فعال‌سازی */
async function breakSubscriptionWrites() {
  await db.execute(sql.raw(`create or replace function atom_test_fail() returns trigger language plpgsql as $$ begin raise exception 'simulated crash'; end $$`));
  await db.execute(sql.raw(`create trigger atom_test_block before insert or update on subscriptions for each row execute function atom_test_fail()`));
}
async function repairSubscriptionWrites() {
  await db.execute(sql.raw(`drop trigger if exists atom_test_block on subscriptions`));
}
afterEach(repairSubscriptionWrites);

async function insertPayment(ws: number, v: Partial<typeof payments.$inferInsert>) {
  const [row] = await db
    .insert(payments)
    .values({ workspaceId: ws, userId, plan: "pro", months: 1, amount: 490_000, gateway: "sandbox", kind: "subscription", authority: `legacy-${uniq("a")}`, ...v })
    .returning();
  return row;
}

describe("اعمال اتمی پرداخت (CR-02)", () => {
  it("خطا/کرش بین «paid» و «فعال‌سازی»: وضعیت paid ثبت نمی‌شود و بعداً خودکار یک‌بار اعمال می‌شود", async () => {
    const ws = await newWs();
    const authority = authorityOf(await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin }));

    await breakSubscriptionWrites();
    const first = await verifyPayment(authority, "OK");
    expect(first.ok).toBe(false);
    let row = await rowOf(authority);
    expect(row.status).toBe("pending"); // نه paid-بدون-اثر
    expect(row.paidAt).toBeNull();
    expect(row.fulfilledAt).toBeNull();
    expect(row.error).toContain("verify_pending");
    expect((await getSubscription(ws)).planId).toBe("free");

    await repairSubscriptionWrites();
    const rec = await reconcilePendingPayments();
    expect(rec.paid).toBeGreaterThanOrEqual(1);
    row = await rowOf(authority);
    expect(row.status).toBe("paid");
    expect(row.fulfilledAt).not.toBeNull();
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    expect(near(end, 30)).toBe(true);

    // اجرای دوباره‌ی همه‌چیز (reconcile، callback تکراری) تاریخ را تغییر نمی‌دهد
    await reconcilePendingPayments();
    expect((await verifyPayment(authority, "OK")).ok).toBe(true);
    expect((await getSubscription(ws)).periodEnd!.getTime()).toBe(end);
  });

  it("شارژ کیف پول: اگر دفتر کل از قبل ثبت شده (اعمال نیمه‌کاره‌ی قدیمی) موجودی دوبار شارژ نمی‌شود", async () => {
    const ws = await newWs();
    const url = await startPayment({ kind: "topup", workspaceId: ws, userId, amountToman: 120_000, origin, description: "شارژ" });
    const authority = authorityOf(url);
    const row0 = await rowOf(authority);
    await creditToman(ws, 120_000, { kind: "topup", ref: `topup:${row0.id}`, description: "قبلی" });
    expect((await verifyPayment(authority, "OK")).ok).toBe(true);
    expect((await getWallet(ws)).balance).toBe(120_000);
    expect((await rowOf(authority)).fulfilledAt).not.toBeNull();
    await verifyPayment(authority, "OK");
    await reconcilePendingPayments();
    expect((await getWallet(ws)).balance).toBe(120_000);
  });

  it("paid ماندگار قدیمی (بدون اثر) توسط reconcile دقیقاً یک‌بار ترمیم می‌شود — اشتراک", async () => {
    const ws = await newWs();
    const p = await insertPayment(ws, { status: "paid", paidAt: new Date(), refId: "R1" });
    expect((await getSubscription(ws)).planId).toBe("free");
    const r1 = await reconcilePendingPayments();
    expect(r1.recovered).toBeGreaterThanOrEqual(1);
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    expect(near(end, 30)).toBe(true);
    expect((await rowOf(p.authority)).fulfilledAt).not.toBeNull();
    await reconcilePendingPayments();
    await reconcilePendingPayments();
    expect((await getSubscription(ws)).periodEnd!.getTime()).toBe(end);
  });

  it("paid ماندگار قدیمی — شارژ کیف پول: یک‌بار شارژ و سپس بی‌اثر", async () => {
    const ws = await newWs();
    const p = await insertPayment(ws, { status: "paid", paidAt: new Date(), refId: "R2", kind: "topup", plan: "wallet", amount: 75_000, gateway: "zarinpal" });
    await reconcilePendingPayments();
    await reconcilePendingPayments();
    expect((await getWallet(ws)).balance).toBe(75_000);
    const ledger = await db.select().from(walletTransactions).where(eq(walletTransactions.ref, `topup:${p.id}`));
    expect(ledger).toHaveLength(1);
  });

  it("بازگشت دوباره‌ی کاربر روی paid ماندگار قدیمی هم آن را ترمیم می‌کند (نه فقط «قبلاً تایید شده»)", async () => {
    const ws = await newWs();
    const p = await insertPayment(ws, { status: "paid", paidAt: new Date(), refId: "R3", authority: `legacy-${uniq("cb")}-0123456789` });
    const r = await verifyPayment(p.authority, "OK");
    expect(r.ok).toBe(true);
    expect((await getSubscription(ws)).planId).toBe("pro");
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    await verifyPayment(p.authority, "OK");
    expect((await getSubscription(ws)).periodEnd!.getTime()).toBe(end);
  });

  it("پرداخت اشتراک با کیف پول هم علامت اعمال می‌گیرد و reconcile دوباره تمدیدش نمی‌کند", async () => {
    const ws = await newWs();
    await creditToman(ws, 1_000_000, { kind: "topup", ref: `seed-${ws}`, description: "seed" });
    expect((await payPlanWithWallet({ workspaceId: ws, userId, plan: "pro", months: 1 })).ok).toBe(true);
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    const [row] = await db.select().from(payments).where(eq(payments.workspaceId, ws));
    expect(row.status).toBe("paid");
    expect(row.fulfilledAt).not.toBeNull();
    await reconcilePendingPayments();
    expect((await getSubscription(ws)).periodEnd!.getTime()).toBe(end);
  });
});

describe("activateSubscription ایدمپوتنت (DB-06)", () => {
  it("همان پرداخت را هرچندبار اجرا کنی فقط یک‌بار تمدید می‌شود", async () => {
    const ws = await newWs();
    const p = await insertPayment(ws, {});
    const a = await activateSubscription(ws, "pro", 1, { paymentId: p.id });
    expect(a.applied).toBe(true);
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    for (let i = 0; i < 3; i++) expect((await activateSubscription(ws, "pro", 1, { paymentId: p.id })).applied).toBe(false);
    expect((await getSubscription(ws)).periodEnd!.getTime()).toBe(end);
  });

  it("فراخوانی موازیِ همان پرداخت فقط یک‌بار اعمال می‌شود", async () => {
    const ws = await newWs();
    const p = await insertPayment(ws, {});
    const res = await Promise.all(Array.from({ length: 8 }, () => activateSubscription(ws, "pro", 1, { paymentId: p.id })));
    expect(res.filter((r) => r.applied)).toHaveLength(1);
    expect(near((await getSubscription(ws)).periodEnd!.getTime(), 30)).toBe(true);
  });

  it("دو پرداخت متفاوتِ هم‌زمان برای یک فضا هر دو شمرده می‌شوند (بدون lost update)", async () => {
    const ws = await newWs();
    const [p1, p2] = [await insertPayment(ws, {}), await insertPayment(ws, {})];
    await Promise.all([activateSubscription(ws, "pro", 1, { paymentId: p1.id }), activateSubscription(ws, "pro", 1, { paymentId: p2.id })]);
    expect(near((await getSubscription(ws)).periodEnd!.getTime(), 60)).toBe(true);
  });

  it("در تراکنش بیرونی: rollback بیرونی، علامت اعمال و تمدید را با هم برمی‌گرداند", async () => {
    const ws = await newWs();
    const p = await insertPayment(ws, {});
    await expect(
      db.transaction(async (tx) => {
        await activateSubscription(ws, "pro", 1, { exec: tx, paymentId: p.id });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await getSubscription(ws)).planId).toBe("free");
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].fulfilledAt).toBeNull();
    expect((await activateSubscription(ws, "pro", 1, { paymentId: p.id })).applied).toBe(true);
  });

  it("پرداخت ناموجود یا مدت نامعتبر رد می‌شود", async () => {
    const ws = await newWs();
    await expect(activateSubscription(ws, "pro", 1, { paymentId: 999_999_999 })).rejects.toThrow();
    await expect(activateSubscription(ws, "pro", 0)).rejects.toThrow();
    expect((await getSubscription(ws)).planId).toBe("free");
  });
});
