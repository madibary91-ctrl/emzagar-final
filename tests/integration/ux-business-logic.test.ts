import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collectCampaigns, contracts, users } from "@/db/schema";
import { loginAction, registerAction } from "@/modules/auth/actions";
import { issueContractsAction, updateMetaAction } from "@/modules/contracts/actions";
import { setTermAction } from "@/modules/renewals/actions";
import { getSigners, issueContract } from "@/modules/contracts/service";
import { describeWaitingSigner, getOrCreateSigningLink, resolveSigningToken } from "@/modules/signing/links";
import { createCampaignAction } from "@/modules/collect/actions";
import { env, form, freshBrowser, run, uniq } from "../helpers";
import { newClient, setupWorkspace, signAll } from "../flows";

const OWNER_PASS = "Owner123x";
const BODY = "<p>متن آزمایشی قرارداد برای آزمون منطق تجاری و تجربه‌ی کاربر.</p>";

async function loginOwner(email: string) {
  freshBrowser();
  const r = await run(() => loginAction({}, form({ email, password: OWNER_PASS })));
  expect(env.cookies.has("amz_session"), JSON.stringify(r)).toBe(true);
}

describe("ثبت‌نام با کیبورد فارسی", () => {
  beforeEach(() => freshBrowser());
  const reg = (mobile: string, email: string) =>
    run(() => registerAction({}, form({ name: "کاربر فارسی‌نویس", email, mobile, password: "Passw0rdX9", workspaceName: "کسب‌وکار" })));

  it("موبایل با ارقام فارسی یا +98 پذیرفته و استاندارد ذخیره می‌شود", async () => {
    for (const [raw, i] of [["۰۹۱۲۳۴۵۶۷۸۹", 1], ["+989121234567", 2], ["۹۱۲ ۱۲۳ ۴۵۶۷", 3]] as const) {
      freshBrowser();
      const email = `${uniq("fa")}${i}@example.com`;
      const r = await reg(raw, email);
      expect(r.redirect, `${raw} → ${JSON.stringify(r.result)}`).toMatch(/^\/verify-email/);
      const [u] = await db.select().from(users).where(eq(users.email, email));
      expect(u.mobile).toMatch(/^09\d{9}$/);
    }
  });

  it("موبایل نامعتبر پیام راهنمای روشن می‌دهد (و حساب نمی‌سازد)", async () => {
    const email = `${uniq("bad")}@example.com`;
    const r = await reg("0812345", email);
    expect(r.result?.error).toMatch(/موبایل/);
    expect(r.result?.error).toMatch(/09123456789/);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });
});

describe("فرم‌های قرارداد: ورودی عددی فارسی و خطاهای صریح", () => {
  let email = "";
  let wsId = 0;
  let ownerId = 0;
  let customerId = 0;
  beforeEach(async () => {
    const { owner, wsId: w } = await setupWorkspace("فضای UX");
    email = owner.email;
    wsId = w;
    ownerId = owner.id;
    customerId = (await newClient(wsId, "مشتری", "09123334444")).userId;
    await loginOwner(email);
  });
  const issue = (extra: Record<string, string>) => run(() => issueContractsAction({}, form({ title: "قرارداد UX", body: BODY, customerId: String(customerId), ...extra })));

  it("مهلت «۳۰» (ارقام فارسی) واقعاً ۳۰ روز می‌شود، نه «بدون انقضا»ی بی‌صدا؛ ارزش با جداکننده‌ی فارسی ذخیره می‌شود", async () => {
    const r = await issue({ expiryDays: "۳۰", contractValue: "۵٬۰۰۰٬۰۰۰" });
    expect(r.redirect).toMatch(/^\/contracts\/\d+$/);
    const id = Number(r.redirect!.split("/").pop());
    const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
    const days = (c.expiresAt!.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(c.contractValue).toBe(5_000_000);
  });

  it("مهلت یا ارزش نامعتبر خطای روشن می‌دهد و قراردادی ساخته نمی‌شود", async () => {
    const before = (await db.select().from(contracts).where(eq(contracts.workspaceId, wsId))).length;
    const a = await issue({ expiryDays: "سی روز" });
    expect(a.result?.error).toContain("مهلت امضا");
    const b = await issue({ expiryDays: "99999" });
    expect(b.result?.error).toContain("مهلت امضا");
    const c = await issue({ contractValue: "پنجاه میلیون" });
    expect(c.result?.error).toContain("ارزش قرارداد");
    expect((await db.select().from(contracts).where(eq(contracts.workspaceId, wsId))).length).toBe(before);
  });

  it("ورودی نامعتبر ارزش ذخیره‌شده را پاک نمی‌کند؛ فقط «خالی» پاک می‌کند", async () => {
    const id = await issueContract({ workspaceId: wsId, title: "ارزش‌دار", bodyHtml: BODY, customerId, createdBy: ownerId, contractValue: 7_000_000 });
    const bad = await run(() => updateMetaAction(form({ id: String(id), tags: "", contractValue: "هفت میلیون" })));
    expect(decodeURIComponent(bad.redirect!)).toContain("meta_error=");
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].contractValue).toBe(7_000_000);
    const fa = await run(() => updateMetaAction(form({ id: String(id), tags: "", contractValue: "۸٬۰۰۰٬۰۰۰" })));
    expect(fa.redirect).toContain("meta=1");
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].contractValue).toBe(8_000_000);
    const clear = await run(() => updateMetaAction(form({ id: String(id), tags: "", contractValue: "" })));
    expect(clear.redirect).toContain("meta=1");
    expect((await db.select().from(contracts).where(eq(contracts.id, id)))[0].contractValue).toBeNull();
  });

  it("یادآوری تمدید: عدد نامعتبر به «۳۰ روز» بی‌صدا تبدیل نمی‌شود", async () => {
    const id = await issueContract({ workspaceId: wsId, title: "تمدید", bodyHtml: BODY, customerId, createdBy: ownerId });
    const r = await run(() => setTermAction(form({ id: String(id), termEnds: "", noticeDays: "زود", termDays: "" })));
    expect(decodeURIComponent(r.redirect!)).toMatch(/term_error=.*یادآوری/);
    const r2 = await run(() => setTermAction(form({ id: String(id), termEnds: "", noticeDays: "۱۵", termDays: "" })));
    expect(decodeURIComponent(r2.redirect!)).toMatch(/term_error=.*تاریخ پایان/);
  });
});

describe("منطق درونی قرارداد", () => {
  it("یک نفر دوبار طرف قرارداد نمی‌شود (مشتری هم در فهرست امضاکنندگان) و چیزی نیمه‌کاره ذخیره نمی‌شود", async () => {
    const { owner, wsId } = await setupWorkspace("فضای تکراری");
    const a = await newClient(wsId, "الف", "09125550001");
    const before = (await db.select().from(contracts).where(eq(contracts.workspaceId, wsId))).length;
    await expect(
      issueContract({ workspaceId: wsId, title: "تکراری", bodyHtml: BODY, customerId: a.userId, extraSigners: [{ label: "ضامن", userId: a.userId }], createdBy: owner.id }),
    ).rejects.toThrow(/دوبار/);
    expect((await db.select().from(contracts).where(eq(contracts.workspaceId, wsId))).length).toBe(before);
  });

  it("امضاکننده‌ای که نوبتش نرسیده «در انتظار» می‌بیند، نه «لینک نامعتبر»؛ نوبتِ فعلی/بسته/ناشناس null است", async () => {
    const { owner, wsId } = await setupWorkspace("فضای نوبت");
    const seller = await newClient(wsId, "فروشنده", "09126660001");
    const buyer = await newClient(wsId, "خریدار", "09126660002");
    const id = await issueContract({ workspaceId: wsId, title: "قرارداد نوبتی", bodyHtml: BODY, customerId: buyer.userId, extraSigners: [{ label: "فروشنده", userId: seller.userId }], createdBy: owner.id });
    const signers = await getSigners(id);
    const l1 = (await getOrCreateSigningLink(signers[0].id))!;
    const l2 = (await getOrCreateSigningLink(signers[1].id))!;
    // رفتار امنیتی قبلی دست‌نخورده: حالت resolve همچنان invalid است
    expect((await resolveSigningToken(l2.token)).status).toBe("invalid");
    const w = await describeWaitingSigner(l2.token);
    expect(w).toMatchObject({ title: "قرارداد نوبتی", ahead: 1, waitingFor: ["فروشنده"] });
    expect(await describeWaitingSigner(l1.token)).toBeNull(); // نوبت اوست
    expect(await describeWaitingSigner("A".repeat(43))).toBeNull(); // توکن ناشناس هیچ اطلاعاتی نمی‌دهد
    expect(await describeWaitingSigner("short")).toBeNull();
    await signAll(id);
    expect(await describeWaitingSigner(l2.token)).toBeNull(); // پس از پایان قرارداد
  });
});

describe("آخرین مهلت فرم جمع‌آوری امضا", () => {
  it("تاریخ گذشته و نامعتبر رد می‌شود؛ تاریخ آینده تا «پایان همان روز» تهران ذخیره می‌شود", async () => {
    const { owner } = await setupWorkspace("فضای جمع‌آوری");
    await loginOwner(owner.email);
    const base = { title: "فرم آزمون", bodyHtml: BODY, requireOtp: false, requireSignature: false, fields: [] } as unknown as Parameters<typeof createCampaignAction>[0];
    const past = await createCampaignAction({ ...base, closesAtIso: "2020-01-01" });
    expect(past.ok).toBe(false);
    expect(past.error).toMatch(/گذشته/);
    const bad = await createCampaignAction({ ...base, closesAtIso: "2026-02-30" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/معتبر/);
    const d = new Date(Date.now() + 10 * 86400000);
    const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(d);
    const ok = await createCampaignAction({ ...base, closesAtIso: iso });
    expect(ok.ok, ok.error).toBe(true);
    const [c] = await db.select().from(collectCampaigns).where(eq(collectCampaigns.id, ok.id!));
    expect(c.closesAt!.toISOString()).toBe(`${iso}T20:29:59.000Z`);
  });
});
