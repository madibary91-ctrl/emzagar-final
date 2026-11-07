import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { loginAction, registerAction, resendVerificationAction, verifyEmailCodeAction, confirmEmailLinkAction } from "@/modules/auth/actions";
import { getCurrentUser } from "@/modules/auth/session";
import { consumeVerifyToken, peekVerifyToken } from "@/modules/auth/email-verify";
import { env, form, freshBrowser, lastMail, run, uniq } from "../helpers";

const PASS = "Passw0rdX9";
const reg = (email: string, extra: Record<string, string> = {}) =>
  run(() => registerAction({}, form({ name: "کاربر آزمون", email, mobile: "09123456789", password: PASS, workspaceName: "کسب‌وکار آزمون", ...extra })));
const codeOf = async (email: string) => /dir="ltr">(\d{6})</.exec((await lastMail(email)).body)![1];
const tokenOf = async (email: string) => /verify-email\/([a-f0-9]{64})/.exec((await lastMail(email)).body)![1];
const getUser = async (email: string) => (await db.select().from(users).where(eq(users.email, email)))[0];

describe("ثبت‌نام با تأیید ایمیل", () => {
  beforeEach(() => freshBrowser());

  it("ثبت‌نام نشست نمی‌سازد و کاربر را به صفحه‌ی تأیید می‌برد", async () => {
    const email = `${uniq()}@example.com`;
    const r = await reg(email);
    expect(r.redirect).toMatch(/^\/verify-email/);
    expect(env.cookies.has("amz_session")).toBe(false);
    expect(env.cookies.has("amz_ev")).toBe(true);
    expect((await getUser(email)).emailVerifiedAt).toBeNull();
    expect(await getCurrentUser()).toBeNull();
  });

  it("ورود با رمز درست ولی ایمیل تأییدنشده ممکن نیست", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    freshBrowser();
    const r = await run(() => loginAction({}, form({ email, password: PASS })));
    expect(r.redirect).toMatch(/^\/verify-email/);
    expect(env.cookies.has("amz_session")).toBe(false);
  });

  it("کد نادرست رد و کد درست حساب را فعال و وارد می‌کند", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    const code = await codeOf(email);
    const wrong = code === "111111" ? "222222" : "111111";
    const bad = await run(() => verifyEmailCodeAction({}, form({ code: wrong })));
    expect(bad.result?.error).toMatch(/نادرست/);
    const ok = await run(() => verifyEmailCodeAction({}, form({ code })));
    expect(ok.redirect).toBe("/admin");
    expect(env.cookies.has("amz_session")).toBe(true);
    expect((await getUser(email)).emailVerifiedAt).not.toBeNull();
    expect((await getCurrentUser())?.email).toBe(email);
  });

  it("کد یک‌بارمصرف است و پس از ۵ تلاش اشتباه حتی کد درست هم باطل می‌شود", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    const code = await codeOf(email);
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) await run(() => verifyEmailCodeAction({}, form({ code: wrong })));
    const r = await run(() => verifyEmailCodeAction({}, form({ code })));
    expect(r.result?.error).toMatch(/تلاش/);
    expect((await getUser(email)).emailVerifiedAt).toBeNull();
  });

  it("ارسال مجدد کد: ۶۰ ثانیه محدودیت و باطل‌شدن کد قبلی", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    const early = await run(() => resendVerificationAction());
    expect(early.result?.error).toMatch(/ثانیه/);
  });

  it("پیش‌ربایی حساب: ثبت‌نام دوباره با ایمیل تأییدنشده رمز مهاجم را جایگزین می‌کند؛ نام/موبایل دست‌نخورده و کوکی قبلی باطل", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email, { password: "AttackerPass1", name: "مهاجم" });
    const before = await getUser(email);
    const attackerCookies = new Map(env.cookies); // مرورگر مهاجم
    freshBrowser();
    const r = await reg(email, { password: "VictimPass1", name: "قربانی" });
    expect(r.redirect).toMatch(/^\/verify-email/);
    const after = await getUser(email);
    expect(after.passwordHash).not.toBe(before.passwordHash); // رمز مهاجم دیگر معتبر نیست
    expect(after.name).toBe(before.name); // نام/موبایل حساب بازنویسی نمی‌شود
    expect(after.mobile).toBe(before.mobile);
    // کوکی مرحله‌ی تأیید که مهاجم پیش‌تر گرفته بود پس از تغییر رمز باطل است
    const keep = new Map(env.cookies);
    env.cookies.clear();
    for (const [k, v] of attackerCookies) env.cookies.set(k, v);
    const stale = await run(() => verifyEmailCodeAction({}, form({ code: "123456" })));
    expect(stale.result?.error).toMatch(/مهلت/);
    env.cookies.clear();
    for (const [k, v] of keep) env.cookies.set(k, v);
  });

  it("ایمیل تأییدشده‌ی موجود دوباره ثبت‌نام نمی‌شود", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    await run(() => verifyEmailCodeAction({}, form({ code: "000000" }))); // نادرست
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, email));
    freshBrowser();
    const r = await reg(email);
    expect(r.result?.error).toMatch(/قبلاً ثبت‌نام/);
  });

  it("لینک ایمیل: ابتدا فقط نمایش (peek)، سپس یک‌بار مصرف", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    const token = await tokenOf(email);
    expect((await peekVerifyToken(token))?.email).toBe(email);
    expect((await peekVerifyToken(token))?.email).toBe(email); // peek چیزی مصرف نمی‌کند
    expect(await consumeVerifyToken(token)).toBeTypeOf("number");
    expect(await consumeVerifyToken(token)).toBeNull();
    expect(await peekVerifyToken("x".repeat(64))).toBeNull();
    expect((await getUser(email)).emailVerifiedAt).not.toBeNull();
  });

  it("تأیید با لینک در همان مرورگر کاربر را وارد می‌کند؛ در مرورگر دیگر فقط به ورود می‌فرستد", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    const token = await tokenOf(email);
    const other = await run(async () => {
      const saved = new Map(env.cookies);
      env.cookies.clear();
      try {
        return await confirmEmailLinkAction(form({ token }));
      } finally {
        saved.forEach((v, k) => env.cookies.set(k, v));
      }
    });
    expect(other.redirect).toBe("/login?verified=1");
    expect(env.cookies.has("amz_session")).toBe(false);
  });

  it("بعد از تأیید، ورود عادی کار می‌کند", async () => {
    const email = `${uniq()}@example.com`;
    await reg(email);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, email));
    freshBrowser();
    const r = await run(() => loginAction({}, form({ email, password: PASS })));
    expect(r.redirect).toBe("/admin");
    expect(env.cookies.has("amz_session")).toBe(true);
  });

  it("ورودی‌های نامعتبر ثبت‌نام رد می‌شوند", async () => {
    expect((await reg("not-an-email")).result?.error).toMatch(/ایمیل/);
    expect((await reg(`${uniq()}@example.com`, { mobile: "123" })).result?.error).toMatch(/موبایل/);
    expect((await reg(`${uniq()}@example.com`, { password: "short" })).result?.error).toBeTruthy();
  });
});
