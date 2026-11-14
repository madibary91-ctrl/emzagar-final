import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mobileVerifications, referrals, users, vaultProfiles } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { getSigners, issueContract } from "@/modules/contracts/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { ensureGuestSigner } from "@/modules/guests/service";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { guestSendOtpAction, guestSignAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { GET as vaultPdfRoute } from "@/app/api/vault/contracts/[id]/pdf/route";
import { GET as vaultSignRoute } from "@/app/api/vault/contracts/[id]/sign/route";
import { GET as vaultExportRoute } from "@/app/api/vault/export/route";
import { vaultEnterFromTokenAction, vaultLogoutAction, vaultPrefAction, vaultSendCodeAction, vaultUpgradeAction, vaultVerifyCodeAction } from "@/modules/vault/actions";
import { firstTouchSender, getGrowthOffer, vaultFunnel } from "@/modules/vault/growth";
import { getVaultAccess, listVaultDocs, vaultStats } from "@/modules/vault/service";
import { readVaultSession } from "@/modules/vault/session";
import { freshBrowser, form, makePng, resetRateLimit, run, setIp, uniq } from "../helpers";

const MOBILE = "09125550001";
const STRANGER = "09125550002";
let ownerA: { id: number };
let ownerB: { id: number };
let wsA: number;
let wsB: number;
const ids: { a: number; b: number; pending: number } = { a: 0, b: 0, pending: 0 };
let tokenA = "";

async function sign(contractId: number): Promise<string> {
  const [s] = await getSigners(contractId);
  const link = (await getOrCreateSigningLink(s.id))!;
  const sent = await guestSendOtpAction(link.token);
  expect((await guestVerifyOtpAction(link.token, sent.devCode!)).ok).toBe(true);
  expect((await guestSignAction(link.token, { signature: makePng(), method: "draw", agree: true })).ok).toBe(true);
  return link.token;
}

beforeAll(async () => {
  const mk = async (n: string, mobile: string) => (await db.insert(users).values({ name: n, email: `${uniq("v")}@example.com`, mobile, passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() }).returning())[0];
  ownerA = await mk("فروشنده الف", "09120000071");
  ownerB = await mk("فروشنده ب", "09120000072");
  wsA = await createWorkspace(ownerA.id, "کسب‌وکار الف");
  wsB = await createWorkspace(ownerB.id, "کسب‌وکار ب");
  const body = "<h2>قرارداد</h2><p>این قرارداد برای آزمون کیف اسناد میان [USER_NAME] و فروشنده منعقد شد و الزام‌آور است.</p>";
  const gA = await ensureGuestSigner(wsA, { name: "مریم کیفی", mobile: MOBILE });
  const gB = await ensureGuestSigner(wsB, { name: "مریم کیفی", mobile: MOBILE });
  ids.a = await issueContract({ workspaceId: wsA, title: "قرارداد الف", bodyHtml: body, customerId: gA.userId, createdBy: ownerA.id });
  ids.b = await issueContract({ workspaceId: wsB, title: "قرارداد ب", bodyHtml: body, customerId: gB.userId, createdBy: ownerB.id });
  ids.pending = await issueContract({ workspaceId: wsB, title: "قرارداد منتظر", bodyHtml: body, customerId: gB.userId, createdBy: ownerB.id });
});
beforeEach(async () => {
  await db.delete(mobileVerifications); // فاصله‌ی ۶۰ثانیه‌ای ارسال مجدد کد، آزمون‌ها را به هم گره نزند
  freshBrowser();
  setIp("10.9.0.1");
  resetRateLimit("vaultcode:ip:10.9.0.1");
});

describe("کیف اسناد امضاکننده", () => {
  it("اسناد چند فضای کاری با یک موبایل یک‌جا جمع می‌شوند و غریبه هیچ‌چیز نمی‌بیند", async () => {
    tokenA = await sign(ids.a);
    await sign(ids.b);
    const docs = await listVaultDocs(MOBILE);
    expect(docs.map((d) => d.id).sort()).toEqual([ids.a, ids.b, ids.pending].sort());
    expect(docs.find((d) => d.id === ids.a)?.bucket).toBe("done");
    expect(docs.find((d) => d.id === ids.pending)?.bucket).toBe("action");
    expect(docs.find((d) => d.id === ids.a)?.sender).toBe("کسب‌وکار الف");
    const st = vaultStats(docs);
    expect(st).toMatchObject({ total: 3, signed: 2, action: 1, senders: 2 });
    expect(await listVaultDocs(STRANGER)).toEqual([]);
    expect(await getVaultAccess(STRANGER, ids.a)).toBeNull();
  });

  it("ورود با OTP: برای شماره‌ی بدون سند پیامکی نمی‌رود، برای صاحب سند می‌رود، کد غلط رد می‌شود", async () => {
    const ghost = await vaultSendCodeAction(STRANGER);
    expect(ghost.ok).toBe(true);
    expect(ghost.devCode).toBeUndefined();
    expect((await vaultVerifyCodeAction(STRANGER, "12345")).ok).toBe(false);
    expect(await readVaultSession()).toBeNull();

    const sent = await vaultSendCodeAction(MOBILE);
    expect(sent.ok).toBe(true);
    expect(sent.devCode).toMatch(/^\d{5}$/);
    expect((await vaultVerifyCodeAction(MOBILE, "00000")).ok).toBe(false);
    expect((await vaultVerifyCodeAction(MOBILE, sent.devCode!)).ok).toBe(true);
    expect(await readVaultSession()).toBe(MOBILE);
    const [p] = await db.select().from(vaultProfiles).where(eq(vaultProfiles.mobile, MOBILE));
    expect(p.source).toBe("direct");
    await run(() => vaultLogoutAction());
    expect(await readVaultSession()).toBeNull();
  });

  it("ورود یک‌لمسی از صفحه‌ی بعد از امضا (نشست OTP امضا) و رد آن در مرورگر تازه", async () => {
    expect((await vaultEnterFromTokenAction(tokenA)).ok).toBe(false); // مرورگر تازه: بدون نشست OTP
    // دوباره OTP امضا برای گرفتن نشست مهمان روی همین مرورگر
    const [s] = await getSigners(ids.a);
    const { otpCodes } = await import("@/db/schema");
    await db.delete(otpCodes).where(eq(otpCodes.signerId, s.id));
    const { guestSendReceiptOtpAction, guestVerifyReceiptOtpAction } = await import("@/modules/signing/guest-actions");
    const sent = await guestSendReceiptOtpAction(tokenA);
    expect((await guestVerifyReceiptOtpAction(tokenA, sent.devCode!)).ok).toBe(true);
    expect((await vaultEnterFromTokenAction(tokenA)).ok).toBe(true);
    expect(await readVaultSession()).toBe(MOBILE);
  });

  it("مدیریت: سنجاق/بایگانی/یادداشت فقط روی اسناد خودی و با نشست معتبر", async () => {
    expect((await vaultPrefAction(ids.a, { pinned: true })).ok).toBe(false); // بدون نشست
    const sent = await vaultSendCodeAction(MOBILE);
    await vaultVerifyCodeAction(MOBILE, sent.devCode!);
    expect((await vaultPrefAction(ids.a, { pinned: true, note: "  یادآوری تمدید  " })).ok).toBe(true);
    expect((await vaultPrefAction(ids.b, { archived: true })).ok).toBe(true);
    const docs = await listVaultDocs(MOBILE);
    expect(docs.map((d) => d.id).slice(0, 2)).toEqual([ids.a, ids.pending]); // سنجاق‌شده اول، بعد «منتظر امضا»
    const a = docs.find((d) => d.id === ids.a)!;
    expect(a.pinned).toBe(true);
    expect(a.note).toBe("یادآوری تمدید");
    expect(docs.find((d) => d.id === ids.b)!.archived).toBe(true);
    expect((await vaultPrefAction(999999, { pinned: true })).ok).toBe(false);
  });

  it("PDF/ZIP/ادامه‌ی امضا: بدون نشست ۴۰۱، با نشست درست، و موبایل دیگر ۴۰۴", async () => {
    const call = (id: number) => vaultPdfRoute(new Request(`http://localhost/api/vault/contracts/${id}/pdf`), { params: Promise.resolve({ id: String(id) }) });
    expect((await call(ids.a)).status).toBe(401);
    expect((await vaultExportRoute(new Request("http://localhost/api/vault/export"))).status).toBe(401);

    const sent = await vaultSendCodeAction(MOBILE);
    await vaultVerifyCodeAction(MOBILE, sent.devCode!);
    const ok = await call(ids.a);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    expect((await call(ids.pending)).status).toBe(404); // هنوز نهایی نشده

    const zip = await vaultExportRoute(new Request("http://localhost/api/vault/export"));
    expect(zip.status).toBe(200);
    expect(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");

    const go = await vaultSignRoute(new Request("http://localhost/api/vault/contracts/x/sign"), { params: Promise.resolve({ id: String(ids.pending) }) });
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toMatch(/\/sign\/[A-Za-z0-9_-]{43}$/);
    const done = await vaultSignRoute(new Request("http://localhost/api/vault/contracts/x/sign"), { params: Promise.resolve({ id: String(ids.a) }) });
    expect(done.headers.get("location")).toContain("/vault?e=nodoc");

    // نشست یک شماره‌ی دیگر به سند این شماره دسترسی ندارد
    freshBrowser();
    const { startVaultSession } = await import("@/modules/vault/session");
    await startVaultSession(STRANGER);
    expect((await call(ids.a)).status).toBe(404);
  });

  it("رشد: انتساب اولین‌لمس، ارتقای مهمان به حساب واقعی با دعوت‌کننده‌ی فرستنده، و عدم ارتقای دوباره", async () => {
    const touch = await firstTouchSender(MOBILE);
    expect(touch?.referrerUserId).toBe(ownerA.id); // قدیمی‌ترین امضا = فرستنده‌ی الف
    const before = await getGrowthOffer(MOBILE);
    expect(before.state).toBe("can_upgrade");
    expect(before.senderName).toBe("کسب‌وکار الف");
    expect(before.rewardsOn).toBe(true);

    // بدون نشست کیف: رد می‌شود
    resetRateLimit("vaultup:ip:10.9.0.1");
    const anon = await run(() => vaultUpgradeAction({}, form({ email: `${uniq("n")}@example.com`, password: "Strong123x" })));
    expect(anon.result?.error).toBeTruthy();

    const sent = await vaultSendCodeAction(MOBILE);
    await vaultVerifyCodeAction(MOBILE, sent.devCode!);
    const bad = await run(() => vaultUpgradeAction({}, form({ email: "not-an-email", password: "Strong123x" })));
    expect(bad.result?.error).toBeTruthy();

    const email = `${uniq("up")}@example.com`;
    const r = await run(() => vaultUpgradeAction({}, form({ email, password: "Strong123x", name: "مریم کیفی", workspaceName: "استودیو مریم" })));
    expect(r.redirect).toContain("/verify-email"); // مثل ثبت‌نام عادی: ابتدا تأیید ایمیل

    const [u] = await db.select().from(users).where(eq(users.email, email));
    expect(u.isGuest).toBe(false);
    expect(u.mobile).toBe(MOBILE);
    const [ref] = await db.select().from(referrals).where(eq(referrals.referredUserId, u.id));
    expect(ref.referrerUserId).toBe(ownerA.id);
    expect(ref.status).toBe("pending"); // پس از ایمیل تأییدشده و اولین قرارداد پاداش فعال می‌شود
    const [p] = await db.select().from(vaultProfiles).where(eq(vaultProfiles.mobile, MOBILE));
    expect(p.upgradedUserId).toBe(u.id);
    expect(p.referrerUserId).toBe(ownerA.id);

    // تاریخچه‌ی امضاها بی‌مهاجرت در کیف می‌ماند
    expect((await listVaultDocs(MOBILE)).length).toBe(3);
    expect((await getGrowthOffer(MOBILE)).state).toBe("upgraded");

    const again = await run(() => vaultUpgradeAction({}, form({ email: `${uniq("up2")}@example.com`, password: "Strong123x" })));
    expect(again.result?.error).toBeTruthy();

    const f = await vaultFunnel();
    expect(f.signers).toBeGreaterThanOrEqual(1);
    expect(f.upgraded).toBeGreaterThanOrEqual(1);
  });
});
