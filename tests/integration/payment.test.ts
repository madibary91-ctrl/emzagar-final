import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { getSubscription, startCheckout, verifyPayment } from "@/modules/billing/service";
import { priceFor } from "@/modules/billing/plans";
import { createWorkspace } from "@/modules/tenancy/service";
import { uniq } from "../helpers";

let ws = 0;
let userId = 0;
const origin = "http://localhost:3000";

beforeAll(async () => {
  const [u] = await db.insert(users).values({ name: "پرداخت", email: `${uniq("p")}@example.com`, mobile: "09120000008", passwordHash: hashPassword("Pay12345x"), emailVerifiedAt: new Date() }).returning();
  userId = u.id;
  ws = await createWorkspace(u.id, "فضای پرداخت");
});

const authorityOf = (url: string) => new URL(url).searchParams.get("Authority")!;

describe("پرداخت اشتراک", () => {
  it("مبلغ سمت سرور از روی طرح محاسبه می‌شود و پرداخت موفق اشتراک را فعال می‌کند", async () => {
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    const authority = authorityOf(url);
    const [pay] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(pay.amount).toBe(priceFor("pro", 1));
    expect(pay.status).toBe("pending");
    const r = await verifyPayment(authority, "OK");
    expect(r.ok).toBe(true);
    expect((await getSubscription(ws)).planId).toBe("pro");
  });

  it("بازگشت دوباره از درگاه اشتراک را دوبار تمدید نمی‌کند (idempotent)", async () => {
    const ws2 = await createWorkspace(userId, "فضای دوم");
    const authority = authorityOf(await startCheckout({ workspaceId: ws2, userId, plan: "pro", months: 1, origin }));
    await verifyPayment(authority, "OK");
    const end1 = (await getSubscription(ws2)).periodEnd!.getTime();
    const again = await verifyPayment(authority, "OK");
    expect(again.ok).toBe(true);
    expect((await getSubscription(ws2)).periodEnd!.getTime()).toBe(end1);
  });

  it("درخواست‌های موازی verify فقط یک‌بار فعال‌سازی می‌کنند", async () => {
    const ws3 = await createWorkspace(userId, "فضای سوم");
    const authority = authorityOf(await startCheckout({ workspaceId: ws3, userId, plan: "pro", months: 1, origin }));
    await Promise.all(Array.from({ length: 6 }, () => verifyPayment(authority, "OK")));
    const end = (await getSubscription(ws3)).periodEnd!.getTime();
    const expected = Date.now() + 30 * 86400_000;
    expect(Math.abs(end - expected)).toBeLessThan(60_000); // یک ماه، نه شش ماه
  });

  it("پرداخت لغوشده فعال‌سازی نمی‌کند و تراکنش ناشناخته/نامعتبر رد می‌شود", async () => {
    const ws4 = await createWorkspace(userId, "فضای چهارم");
    const authority = authorityOf(await startCheckout({ workspaceId: ws4, userId, plan: "business", months: 1, origin }));
    const r = await verifyPayment(authority, "NOK");
    expect(r.ok).toBe(false);
    expect((await getSubscription(ws4)).planId).toBe("free");
    expect((await verifyPayment("DEMO-" + "f".repeat(24), "OK")).ok).toBe(false);
    expect((await verifyPayment("x'; drop table payments;--", "OK")).ok).toBe(false);
    // تراکنش ناموفق قبلی بعداً با Status=OK هم زنده نمی‌شود
    expect((await verifyPayment(authority, "OK")).ok).toBe(false);
  });

  it("طرح یا مدت نامعتبر (دستکاری فرم) رد می‌شود", async () => {
    await expect(startCheckout({ workspaceId: ws, userId, plan: "free", months: 1, origin })).rejects.toThrow();
    await expect(startCheckout({ workspaceId: ws, userId, plan: "enterprise", months: 1, origin })).rejects.toThrow();
    await expect(startCheckout({ workspaceId: ws, userId, plan: "pro", months: 99, origin })).rejects.toThrow();
  });
});
