import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, emailVerifications, users, wpConnections } from "@/db/schema";
import { confirmEmailLinkAction, loginAction, registerAction, resendVerificationAction, verifyEmailCodeAction } from "@/modules/auth/actions";
import { createResetToken, consumeResetToken } from "@/modules/auth/tokens";
import { getCurrentUser } from "@/modules/auth/session";
import { completeHandshake, startHandshake } from "@/modules/connect/service";
import crypto from "node:crypto";
import { env, form, freshBrowser, lastMail, run, uniq } from "../helpers";

/**
 * H-03 — پیش‌ربایی حساب (Last-Writer-Wins): رمز ثبت‌نام‌کننده‌ی «آخر» هرگز مستقیم روی حساب نمی‌نشیند و فقط وقتی
 * اعمال می‌شود که کد/لینک ایمیل در «همان مرورگری» تأیید شود که ثبت‌نام کرده است.
 */
const VICTIM = "VictimPass1x";
const ATTACKER = "AttackerPass1x";
const reg = (email: string, password: string, extra: Record<string, string> = {}) =>
  run(() => registerAction({}, form({ name: "کاربر آزمون", email, mobile: "09123456789", password, workspaceName: "کسب‌وکار آزمون", ...extra })));
const login = (email: string, password: string) => run(() => loginAction({}, form({ email, password })));
const codeOf = async (email: string) => /dir="ltr">(\d{6})</.exec((await lastMail(email)).body)![1];
const tokenOf = async (email: string) => /verify-email\/([a-f0-9]{64})/.exec((await lastMail(email)).body)![1];
const getUser = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0];
const snapshot = () => new Map(env.cookies);
const restore = (m: Map<string, string>) => {
  env.cookies.clear();
  for (const [k, v] of m) env.cookies.set(k, v);
};

describe("H-03 — مهاجمِ «دوم» حساب را نمی‌رباید", () => {
  beforeEach(() => freshBrowser());

  it("قربانی ثبت‌نام می‌کند؛ مهاجم فوراً با همان ایمیل و رمز خودش ثبت‌نام می‌کند ⇒ رمز مهاجم هرگز اعمال نمی‌شود", async () => {
    const email = `${uniq("h3a")}@example.com`;
    await reg(email, VICTIM);
    const victimBrowser = snapshot();
    freshBrowser(); // مرورگر مهاجم
    const atk = await reg(email, ATTACKER);
    expect(atk.redirect).toMatch(/^\/verify-email/);
    const attackerBrowser = snapshot();

    // رمز مهاجم روی حساب «ننشسته» و رمز قربانی هم دیگر معتبر نیست (حساب قفل تا تأیید مالک صندوق)
    const row = await getUser(email);
    expect(row.emailVerifiedAt).toBeNull();

    // قربانی کد/لینک ایمیلش را (که آخرین ایمیل است) در مرورگر خودش باز می‌کند
    restore(victimBrowser);
    const victimCode = await codeOf(email);
    const stale = await run(() => verifyEmailCodeAction({}, form({ code: victimCode })));
    expect(stale.result?.error).toMatch(/مهلت/); // کوکی قدیمی قربانی با تغییر رمز باطل شده
    const link = await run(() => confirmEmailLinkAction(form({ token: "" })));
    expect(link.redirect).toMatch(/failed=1/);

    // لینک ایمیل: صاحب صندوق ایمیل را تأیید می‌کند (مرورگر او کوکی معتبر ندارد)
    const t = await tokenOf(email);
    const okLink = await run(() => confirmEmailLinkAction(form({ token: t })));
    expect(okLink.redirect).toBe("/login?verified=1");
    expect(env.cookies.has("amz_session")).toBe(false);
    expect((await getUser(email)).emailVerifiedAt).not.toBeNull();

    // مهاجم با رمز خودش وارد نمی‌شود (حتی بعد از تأیید ایمیل توسط قربانی)
    restore(attackerBrowser);
    const tryAtk = await login(email, ATTACKER);
    expect(tryAtk.result?.error).toMatch(/اشتباه/);
    expect(env.cookies.has("amz_session")).toBe(false);
    // رمز غیرمفید قربانی (اعمال‌نشده) هم کار نمی‌کند؛ مسیر درست «فراموشی رمز» است
    freshBrowser();
    expect((await login(email, VICTIM)).result?.error).toMatch(/اشتباه/);
    expect(await getCurrentUser()).toBeNull();
  });

  it("حتی اگر مهاجم کد را در مرورگر «خودش» وارد کند (مثلاً کد لو رفته)، فقط رمز خودِ همان ثبت‌نام اعمال می‌شود و قربانی بی‌اطلاع تأیید نمی‌شود", async () => {
    const email = `${uniq("h3b")}@example.com`;
    await reg(email, VICTIM);
    const code = await codeOf(email);
    freshBrowser();
    await reg(email, ATTACKER);
    // مرورگر قربانی (کوکی‌اش باطل شده) نمی‌تواند با کد قربانی چیزی را تأیید کند
    freshBrowser();
    const noCookie = await run(() => verifyEmailCodeAction({}, form({ code })));
    expect(noCookie.result?.error).toMatch(/مهلت/);
    expect((await getUser(email)).emailVerifiedAt).toBeNull();
  });
});

describe("H-03 — ثبت‌نام‌کننده‌ی «آخرِ» درست (مهاجم اول، قربانی دوم)", () => {
  beforeEach(() => freshBrowser());

  it("قربانی با کد ایمیل در همان مرورگر: رمز قربانی اعمال و نشست ساخته می‌شود؛ رمز مهاجمِ اول بی‌اثر است", async () => {
    const email = `${uniq("h3c")}@example.com`;
    await reg(email, ATTACKER, { name: "مهاجم" });
    freshBrowser(); // مرورگر قربانی
    const r = await reg(email, VICTIM);
    expect(r.redirect).toMatch(/^\/verify-email/);
    const before = await getUser(email);
    expect(before.name).toBe("مهاجم"); // نام/موبایل دست‌نخورده
    const code = await codeOf(email);
    const ok = await run(() => verifyEmailCodeAction({}, form({ code })));
    expect(ok.redirect).toBe("/admin");
    expect(env.cookies.has("amz_session")).toBe(true);
    expect((await getCurrentUser())?.email).toBe(email);
    expect((await getUser(email)).emailVerifiedAt).not.toBeNull();

    freshBrowser();
    expect((await login(email, VICTIM)).redirect).toBe("/admin");
    freshBrowser();
    expect((await login(email, ATTACKER)).result?.error).toMatch(/اشتباه/);
  });

  it("ارسال مجدد کد، رمز در انتظار و گره‌ی مرورگر را حفظ می‌کند", async () => {
    const email = `${uniq("h3d")}@example.com`;
    await reg(email, ATTACKER);
    freshBrowser();
    await reg(email, VICTIM);
    const u = await getUser(email);
    // عبور از محدودیت ۶۰ ثانیه‌ی ارسال مجدد
    await db.update(emailVerifications).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(emailVerifications.userId, u.id));
    const resend = await run(() => resendVerificationAction());
    expect(resend.result?.ok).toBe(true);
    const [row] = await db.select().from(emailVerifications).where(eq(emailVerifications.userId, u.id));
    expect(row).toBeDefined();
    const code = await codeOf(email);
    const ok = await run(() => verifyEmailCodeAction({}, form({ code })));
    expect(ok.redirect).toBe("/admin");
    freshBrowser();
    expect((await login(email, VICTIM)).redirect).toBe("/admin");
  });

  it("لینک ایمیل در «مرورگر دیگر»: ایمیل تأیید می‌شود ولی رمز در انتظار اعمال و نشست ساخته نمی‌شود (گره‌خوردگی به مرورگر)", async () => {
    const email = `${uniq("h3e")}@example.com`;
    await reg(email, ATTACKER);
    freshBrowser();
    await reg(email, VICTIM);
    const token = await tokenOf(email);
    env.cookies.clear(); // مرورگر دیگر
    const other = await run(() => confirmEmailLinkAction(form({ token })));
    expect(other.redirect).toBe("/login?verified=1");
    expect(env.cookies.has("amz_session")).toBe(false);
    expect((await getUser(email)).emailVerifiedAt).not.toBeNull();
    expect((await login(email, VICTIM)).result?.error).toMatch(/اشتباه/);
  });

  it("لینک ایمیل در همان مرورگر ثبت‌نام‌کننده: وارد می‌شود", async () => {
    const email = `${uniq("h3f")}@example.com`;
    await reg(email, ATTACKER);
    freshBrowser();
    await reg(email, VICTIM);
    const token = await tokenOf(email);
    const same = await run(() => confirmEmailLinkAction(form({ token })));
    expect(same.redirect).toBe("/admin");
    expect(env.cookies.has("amz_session")).toBe(true);
  });
});

describe("H-03 — رمز در انتظار هرگز رمزِ تعیین‌شده‌ی صاحب حساب را بازنویسی نمی‌کند", () => {
  beforeEach(() => freshBrowser());

  it("پس از «فراموشی رمز» توسط صاحب صندوق، کد/لینک قبلی بی‌اثر است و رمز بازیابی می‌ماند", async () => {
    const email = `${uniq("h3g")}@example.com`;
    await reg(email, ATTACKER);
    freshBrowser();
    await reg(email, VICTIM);
    const code = await codeOf(email);
    const u = await getUser(email);
    const resetToken = await createResetToken(u.id, 1);
    expect(await consumeResetToken(resetToken, "ResetPass1x")).toBe(u.id);
    // کد قبلی دیگر کاری نمی‌کند
    const old = await run(() => verifyEmailCodeAction({}, form({ code })));
    expect(old.result?.error).toBeTruthy();
    freshBrowser();
    expect((await login(email, "ResetPass1x")).redirect).toBe("/admin");
    freshBrowser();
    expect((await login(email, VICTIM)).result?.error).toMatch(/اشتباه/);
  });
});

describe("H-02/H-03 — تصاحب مالکیت ایمیل تأییدنشده، اتصال‌ها و کلیدهای قبلی را باطل می‌کند", () => {
  beforeEach(() => freshBrowser());

  it("حساب قدیمی ساخته‌شده توسط اتصال خودکار (ایمیل واقعیِ تأییدنشده) پس از تأیید مالک واقعی، کلید API مهاجم را از دست می‌دهد", async () => {
    // نسخه‌های قدیمی حساب مالک را با «ایمیل ادعاشده» می‌ساختند؛ آن وضعیت را بازسازی می‌کنیم
    const claimed = `${uniq("legacy")}@example.com`;
    const hs = await startHandshake({ installId: crypto.randomBytes(16).toString("hex"), siteUrl: `http://${uniq("wp")}.test`, siteName: "سایت مهاجم", adminEmail: claimed, adminName: "مهاجم", pluginVersion: "2.0.0", wpVersion: "6.7", wcActive: false, locale: "fa_IR" });
    const done = await completeHandshake(hs.handshakeId);
    const [conn] = await db.select().from(wpConnections).where(eq(wpConnections.workspaceId, done.workspaceId));
    await db.update(users).set({ email: claimed }).where(eq(users.id, conn.ownerUserId!));
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, conn.apiKeyId!));
    expect(key.active).toBe(true);

    // مالک واقعی ایمیل ثبت‌نام می‌کند و کدش را تأیید می‌کند
    await reg(claimed, VICTIM);
    const claimedCode = await codeOf(claimed);
    const ok = await run(() => verifyEmailCodeAction({}, form({ code: claimedCode })));
    expect(ok.redirect).toBe("/admin");

    const [key2] = await db.select().from(apiKeys).where(eq(apiKeys.id, conn.apiKeyId!));
    const [conn2] = await db.select().from(wpConnections).where(eq(wpConnections.id, conn.id));
    expect(key2.active).toBe(false);
    expect(conn2.status).toBe("disconnected");
  });
});
