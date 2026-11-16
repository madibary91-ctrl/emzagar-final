import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, kycDocuments, payments, referrals, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createWorkspace } from "@/modules/tenancy/service";
import { acquireIssueQuota, PlanLimitError } from "@/modules/billing/service";
import { getSubscription } from "@/modules/billing/subscription";
import { applyWalletOps, getWallet, grantCredits, purchasePack } from "@/modules/wallet/service";
import { payPlanWithWallet } from "@/modules/wallet/purchase";
import { startPayment, verifyPayment } from "@/modules/payments/service";
import { resetGatewayHealth, saveCredential, savePrefs } from "@/modules/payments/registry";
import { attachReferral, getOrCreateCode, qualifyReferralForWorkspace, saveReferralConfig } from "@/modules/referral/service";
import { DEFAULT_REFERRAL } from "@/modules/referral/config";
import { assertKycForValue, KycRequiredError, readKycDocument, reviewKyc, saveKycThreshold, submitKyc } from "@/modules/kyc/service";
import { makeNationalCode, uniq } from "../helpers";

const origin = "http://localhost:3000";
let seq = 0;
async function newUser(label: string, mobile?: string) {
  const [u] = await db.insert(users).values({ name: label, email: `${uniq("c")}@example.com`, mobile: mobile ?? `0912${String(1000000 + ++seq * 7)}`, passwordHash: hashPassword("Comm12345x"), emailVerifiedAt: new Date() }).returning();
  const ws = await createWorkspace(u.id, `فضای ${label}`);
  return { u, ws };
}
const png = () => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("fake-image-bytes-for-test")]);

beforeAll(async () => {
  await saveReferralConfig(DEFAULT_REFERRAL);
  await saveKycThreshold(100_000_000);
});

afterAll(async () => {
  // تنظیمات سراسری مشترک بین فایل‌های آزمون: پاک‌سازی تا آزمون‌های بعدی (مثلاً payment) درگاه آزمایشی ببینند
  for (const id of ["zarinpal", "zibal", "idpay", "payir"] as const) await saveCredential(id, "");
  await savePrefs({ order: ["zarinpal", "zibal", "idpay", "payir"], disabled: [] });
  await saveKycThreshold(100_000_000);
  await saveReferralConfig(DEFAULT_REFERRAL);
});

describe("کیف پول", () => {
  it("شارژ، برداشت، موجودی ناکافی و ref تکراری", async () => {
    const { ws } = await newUser("w1");
    expect((await applyWalletOps(ws, [{ asset: "toman", delta: 100_000, kind: "topup", ref: "t1" }])).ok).toBe(true);
    expect((await applyWalletOps(ws, [{ asset: "toman", delta: 100_000, kind: "topup", ref: "t1" }])).ok).toBe(false); // duplicate
    expect((await getWallet(ws)).balance).toBe(100_000);
    const r = await applyWalletOps(ws, [{ asset: "toman", delta: -500_000, kind: "pack_purchase" }]);
    expect(r).toEqual({ ok: false, reason: "insufficient" });
    expect((await getWallet(ws)).balance).toBe(100_000);
  });

  it("برداشت‌های موازی هرگز موجودی را منفی نمی‌کنند", async () => {
    const { ws } = await newUser("w2");
    await applyWalletOps(ws, [{ asset: "toman", delta: 100, kind: "topup", ref: `p-${ws}` }]);
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => applyWalletOps(ws, [{ asset: "toman", delta: -30, kind: "pack_purchase", ref: `d-${ws}-${i}` }])));
    expect(res.filter((r) => r.ok).length).toBe(3);
    expect((await getWallet(ws)).balance).toBe(10);
  });

  it("خرید بسته اتمی است و اشتراک با کیف پول فعال می‌شود", async () => {
    const { u, ws } = await newUser("w3");
    expect((await purchasePack(ws, u.id, "c10")).ok).toBe(false);
    await applyWalletOps(ws, [{ asset: "toman", delta: 1_000_000, kind: "topup", ref: `pk-${ws}` }]);
    const p = await purchasePack(ws, u.id, "c10");
    expect(p).toEqual({ ok: true, credits: 10 });
    expect(await getWallet(ws)).toEqual({ balance: 880_000, credits: 10 });
    const sub = await payPlanWithWallet({ workspaceId: ws, userId: u.id, plan: "pro", months: 1 });
    expect(sub.ok).toBe(true);
    expect((await getSubscription(ws)).planId).toBe("pro");
    expect((await getWallet(ws)).balance).toBe(880_000 - 490_000);
    expect((await payPlanWithWallet({ workspaceId: ws, userId: u.id, plan: "business", months: 12 })).ok).toBe(false);
  });

  it("وقتی سقف ماهانه پر شود اعتبار مصرف و در صورت خطا برگردانده می‌شود", async () => {
    const { u, ws } = await newUser("w4");
    for (let i = 0; i < 10; i++) {
      await db.insert(contracts).values({ workspaceId: ws, number: `Q-${ws}-${i}`, title: "t", customerId: u.id, bodyHtml: "x", status: "sent", publishedAt: new Date() });
    }
    await expect(acquireIssueQuota(ws)).rejects.toBeInstanceOf(PlanLimitError);
    await grantCredits(ws, 2, { kind: "referral_reward", ref: `g-${ws}`, description: "t" });
    const q = await acquireIssueQuota(ws);
    expect(q.usedCredits).toBe(true);
    expect((await getWallet(ws)).credits).toBe(1);
    await q.release();
    await q.release(); // idempotent
    expect((await getWallet(ws)).credits).toBe(2);
  });
});

describe("پرداخت چنددرگاهی", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetGatewayHealth();
  });

  it("شارژ کیف پول از درگاه فقط یک‌بار اعمال می‌شود", async () => {
    const { u, ws } = await newUser("p1");
    const url = await startPayment({ kind: "topup", workspaceId: ws, userId: u.id, amountToman: 250_000, origin, description: "شارژ" });
    const authority = new URL(url).searchParams.get("Authority")!;
    const [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.kind).toBe("topup");
    expect(row.test).toBe(true);
    const r = await verifyPayment(authority, "OK");
    expect(r).toMatchObject({ ok: true, kind: "topup" });
    await Promise.all(Array.from({ length: 5 }, () => verifyPayment(authority, "OK")));
    expect((await getWallet(ws)).balance).toBe(250_000);
  });

  it("اگر درگاه اول قطع باشد، خودکار به درگاه بعدی می‌رود (Failover)", async () => {
    const { u, ws } = await newUser("p2");
    await saveCredential("zarinpal", "12345678-1234-1234-1234-123456789012");
    await saveCredential("zibal", "zibal");
    await savePrefs({ order: ["zarinpal", "zibal", "idpay", "payir"], disabled: [] });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const u2 = String(input);
      calls.push(u2);
      if (u2.includes("zarinpal")) return new Response("down", { status: 503 });
      if (u2.includes("zibal.ir/v1/request")) return Response.json({ result: 100, trackId: 987654321, message: "success" });
      if (u2.includes("zibal.ir/v1/verify")) return Response.json({ result: 100, status: 1, amount: 3_000_000, refNumber: "REF123" });
      return new Response("?", { status: 404 });
    });
    const url = await startPayment({ kind: "topup", workspaceId: ws, userId: u.id, amountToman: 300_000, origin, description: "شارژ" });
    expect(url).toBe("https://gateway.zibal.ir/start/987654321");
    expect(calls[0]).toContain("zarinpal");
    const [row] = await db.select().from(payments).where(eq(payments.authority, "zibal:987654321"));
    expect(row.gateway).toBe("zibal");
    // بازگشت از زیبال: تایید با مبلغ درست
    const ok = await verifyPayment("zibal:987654321", "OK");
    expect(ok.ok).toBe(true);
    expect((await getWallet(ws)).balance).toBe(300_000);
  });

  it("مبلغ تاییدشده‌ی ناهمخوان درگاه، پرداخت را رد می‌کند", async () => {
    const { u, ws } = await newUser("p3");
    await saveCredential("zibal", "zibal");
    await savePrefs({ order: ["zibal", "zarinpal", "idpay", "payir"], disabled: ["zarinpal"] });
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const s = String(input);
      if (s.includes("/v1/request")) return Response.json({ result: 100, trackId: 555000111, message: "success" });
      return Response.json({ result: 100, status: 1, amount: 10_000, refNumber: "X" }); // مبلغ اشتباه
    });
    await startPayment({ kind: "topup", workspaceId: ws, userId: u.id, amountToman: 300_000, origin, description: "شارژ", gateway: "zibal" });
    const r = await verifyPayment("zibal:555000111", "OK");
    expect(r.ok).toBe(false);
    expect((await getWallet(ws)).balance).toBe(0);
    const [row] = await db.select().from(payments).where(eq(payments.authority, "zibal:555000111"));
    expect(row.status).toBe("failed");
  });
});

describe("دعوت از دوستان", () => {
  it("پاداش فقط یک‌بار و فقط پس از اولین قرارداد واقعی پرداخت می‌شود", async () => {
    const a = await newUser("ref-a");
    const b = await newUser("ref-b");
    const code = await getOrCreateCode(a.u.id);
    expect(await getOrCreateCode(a.u.id)).toBe(code);
    expect((await attachReferral({ code, referred: { id: b.u.id, mobile: b.u.mobile }, workspaceId: b.ws, ip: "1.1.1.1" })).ok).toBe(true);
    expect((await attachReferral({ code, referred: { id: b.u.id, mobile: b.u.mobile }, workspaceId: b.ws, ip: "1.1.1.1" })).ok).toBe(false); // دوباره
    expect((await getWallet(a.ws)).balance).toBe(0);
    await Promise.all([qualifyReferralForWorkspace(b.ws), qualifyReferralForWorkspace(b.ws), qualifyReferralForWorkspace(b.ws)]);
    expect(await getWallet(a.ws)).toEqual({ balance: DEFAULT_REFERRAL.referrerWallet, credits: DEFAULT_REFERRAL.referrerCredits });
    expect(await getWallet(b.ws)).toEqual({ balance: DEFAULT_REFERRAL.referredWallet, credits: DEFAULT_REFERRAL.referredCredits });
    const [r] = await db.select().from(referrals).where(eq(referrals.referredUserId, b.u.id));
    expect(r.status).toBe("qualified");
  });

  it("خودمعرفی، موبایل یکسان و چند ثبت‌نام از یک IP پاداش نمی‌گیرد؛ نقطه‌ی عطف اشتراک رایگان می‌دهد", async () => {
    const a = await newUser("ref-c", "09121110000");
    const code = await getOrCreateCode(a.u.id);
    expect((await attachReferral({ code, referred: { id: a.u.id, mobile: a.u.mobile }, workspaceId: a.ws, ip: "2.2.2.2" })).ok).toBe(false);
    const same = await newUser("ref-same", "09121110000");
    expect((await attachReferral({ code, referred: { id: same.u.id, mobile: same.u.mobile }, workspaceId: same.ws, ip: "2.2.2.3" })).ok).toBe(false);
    const [rej] = await db.select().from(referrals).where(eq(referrals.referredUserId, same.u.id));
    expect(rej.status).toBe("rejected");

    await saveReferralConfig({ ...DEFAULT_REFERRAL, milestoneEvery: 1, milestoneDays: 30 });
    const d = await newUser("ref-d");
    await attachReferral({ code, referred: { id: d.u.id, mobile: d.u.mobile }, workspaceId: d.ws, ip: "9.9.9.9" });
    await qualifyReferralForWorkspace(d.ws);
    expect((await getSubscription(a.ws)).planId).toBe("pro");
    await saveReferralConfig(DEFAULT_REFERRAL);
  });
});

describe("احراز هویت KYC", () => {
  it("قرارداد پرمبلغ تا تایید مدیر مسدود است و مدارک رمزنگاری‌شده خوانده می‌شوند", async () => {
    const { u, ws } = await newUser("kyc1");
    await expect(assertKycForValue(ws, 5_000_000)).resolves.toBeUndefined();
    await expect(assertKycForValue(ws, 150_000_000)).rejects.toBeInstanceOf(KycRequiredError);
    await expect(acquireIssueQuota(ws, 1, { contractValue: 150_000_000 })).rejects.toBeInstanceOf(KycRequiredError);

    const files = [
      { kind: "national_front" as const, name: "front.png", buffer: png() },
      { kind: "selfie" as const, name: "selfie.png", buffer: png() },
    ];
    const bad = await submitKyc({ workspaceId: ws, userId: u.id, fullName: "علی رضایی", nationalCode: "1234567890", birthDate: "", files });
    expect(bad.ok).toBe(false);
    const noSelfie = await submitKyc({ workspaceId: ws, userId: u.id, fullName: "علی رضایی", nationalCode: makeNationalCode("123456789"), birthDate: "", files: files.slice(0, 1) });
    expect(noSelfie.ok).toBe(false);
    const notImage = await submitKyc({ workspaceId: ws, userId: u.id, fullName: "علی رضایی", nationalCode: makeNationalCode("123456789"), birthDate: "", files: [files[0], { kind: "selfie", name: "x.png", buffer: Buffer.from("not an image at all") }] });
    expect(notImage.ok).toBe(false);

    const sub = await submitKyc({ workspaceId: ws, userId: u.id, fullName: "علی رضایی", nationalCode: makeNationalCode("123456789"), birthDate: "1370/01/01", files });
    expect(sub.ok).toBe(true);
    if (!sub.ok) return;
    // در حال بررسی: هنوز مسدود، و ارسال دوباره مجاز نیست
    await expect(assertKycForValue(ws, 150_000_000)).rejects.toThrow(/بررسی/);
    expect((await submitKyc({ workspaceId: ws, userId: u.id, fullName: "علی رضایی", nationalCode: makeNationalCode("123456789"), birthDate: "", files })).ok).toBe(false);

    const [doc] = await db.select().from(kycDocuments).where(eq(kycDocuments.submissionId, sub.id));
    const read = await readKycDocument(doc.id);
    expect(read?.buffer.equals(png())).toBe(true);

    // رد بدون دلیل ممکن نیست؛ با دلیل: ارسال دوباره و سپس تایید
    expect((await reviewKyc(sub.id, u.id, "reject", "")).ok).toBe(false);
    expect((await reviewKyc(sub.id, u.id, "reject", "تصویر ناخوانا است")).ok).toBe(true);
    expect((await reviewKyc(sub.id, u.id, "approve", "")).ok).toBe(false); // دیگر در حال بررسی نیست
    const again = await submitKyc({ workspaceId: ws, userId: u.id, fullName: "علی رضایی", nationalCode: makeNationalCode("123456789"), birthDate: "", files });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect((await reviewKyc(again.id, u.id, "approve", "")).ok).toBe(true);
    await expect(assertKycForValue(ws, 150_000_000)).resolves.toBeUndefined();
  });

  it("آستانه‌ی صفر الزام را غیرفعال می‌کند", async () => {
    const { ws } = await newUser("kyc2");
    await saveKycThreshold(0);
    await expect(assertKycForValue(ws, 900_000_000)).resolves.toBeUndefined();
    await saveKycThreshold(100_000_000);
  });
});
