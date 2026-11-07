"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { attachReferral } from "@/modules/referral/service";
import { escapeHtml } from "@/lib/html";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { users } from "@/db/schema";
import { hashPasswordAsync, verifyPasswordAsync } from "@/lib/password";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { getOrigin, getRequestInfo } from "@/lib/request";
import { clearPending2fa, clearPendingVerify, createPending2fa, createPendingVerify, createSession, destroySession, readPending2fa, readPendingVerify } from "./session";
import { consumeVerifyToken, emailVerificationRequired, sendVerificationEmail, showDevSecrets, verifyEmailCode, type SendVerifyResult } from "./email-verify";
import { emailRejection } from "@/lib/email-check";
import { MOBILE_RE, passwordProblem, safeNext } from "./validation";
import { isTotpEnabled, verifyLoginCode } from "./twofactor";
import { consumeResetToken, createResetToken } from "./tokens";
import { logAudit } from "@/modules/audit/service";
import { sendMail } from "@/modules/mail";
import { homeFor, getMemberships, setActiveWorkspaceCookie } from "@/modules/tenancy/context";
import { createWorkspace, EMAIL_RE } from "@/modules/tenancy/service";
import { acceptInvite, findInvite } from "@/modules/tenancy/invites";
import { isTeamRole } from "@/modules/tenancy/roles";

export type LoginState = { error?: string; /** پس از رمز درست، اگر ورود دومرحله‌ای فعال باشد */ step?: "totp"; expired?: boolean };
export type FormState = { error?: string; ok?: boolean; message?: string; devLink?: string; seconds?: number; devCode?: string };

/** سیگنال داخلی برای برگرداندن تراکنش پذیرش دعوت */
class InviteNotAccepted extends Error {}

// هش ساختگی برای هم‌زمان‌سازی زمان پاسخ ایمیل ناشناس؛ تنبل و ناهمگام (PERF-01: بدون قفل کردن حلقه‌ی رویداد هنگام import)
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPasswordAsync("emz-dummy-password-for-timing"));
const showDevLinks = () => process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_OTP === "1";

/** هدایت به صفحه‌ی تأیید ایمیل (در حالت آزمایشی، کد ارسال‌نشده برای نمایش در URL گذاشته می‌شود) */
function verifyRedirect(r: SendVerifyResult): never {
  const q = new URLSearchParams();
  if (r.devCode && showDevSecrets()) q.set("dev", r.devCode);
  if (!r.ok && !r.seconds) q.set("err", "1");
  redirect(`/verify-email${q.size ? `?${q}` : ""}`);
}

/** پایان ورود: ساخت نشست، تعیین فضای کاری فعال و هدایت به مقصد */
async function finishLogin(user: typeof users.$inferSelect, next: unknown): Promise<never> {
  await createSession(user.id, user.passwordHash);
  const ms = await getMemberships(user.id);
  const firstTeam = ms.find((m) => isTeamRole(m.role));
  if (firstTeam) await setActiveWorkspaceCookie(firstTeam.workspaceId);
  await logAudit({ action: "auth.login", userId: user.id, workspaceId: firstTeam?.workspaceId ?? 0 });
  redirect(safeNext(next) ?? (await homeFor(user.id)));
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");
  if (!email || !password) return { error: "ایمیل و رمز عبور را وارد کنید" };

  // محدودیت تلاش: هم به‌ازای IP و هم به‌ازای ایمیل (مقابله با حدس رمز)
  const { ip } = await getRequestInfo();
  const byIp = rateLimit(`login:ip:${ip}`, 30, 15 * 60_000);
  const byEmail = rateLimit(`login:email:${email}`, 8, 15 * 60_000);
  if (!byIp.ok || !byEmail.ok) return { error: "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید." };

  const [user] = await db.select().from(users).where(eq(users.email, email));
  // برای ایمیل ناشناس هم یک هش کامل محاسبه می‌شود تا از تفاوت زمان پاسخ، وجود حساب لو نرود
  const passwordOk = await verifyPasswordAsync(password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !passwordOk) {
    await logAudit({ action: "auth.failed", detail: email });
    return { error: "ایمیل یا رمز عبور اشتباه است" };
  }
  resetRateLimit(`login:email:${email}`);

  // ایمیل تأییدنشده: نشست ساخته نمی‌شود؛ کد تازه فرستاده و کاربر به صفحه‌ی تأیید هدایت می‌شود
  if (emailVerificationRequired() && !user.emailVerifiedAt) {
    await createPendingVerify(user.id, user.passwordHash);
    return verifyRedirect(await sendVerificationEmail(user, await getOrigin()));
  }

  // ورود دومرحله‌ای: رمز درست است ولی هنوز نشست ساخته نمی‌شود
  if (await isTotpEnabled(user.id)) {
    await createPending2fa(user.id, user.passwordHash);
    return { step: "totp" };
  }
  return finishLogin(user, formData.get("next"));
}

/** مرحله‌ی دوم ورود: کد ۶ رقمی اپ احراز هویت یا یکی از کدهای بازیابی */
export async function loginTotpAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const user = await readPending2fa();
  if (!user) return { expired: true, error: "مهلت تأیید به پایان رسید؛ دوباره با ایمیل و رمز وارد شوید." };

  const { ip } = await getRequestInfo();
  if (!rateLimit(`login2fa:user:${user.id}`, 8, 15 * 60_000).ok || !rateLimit(`login2fa:ip:${ip}`, 40, 15 * 60_000).ok) {
    return { step: "totp", error: "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید." };
  }
  const result = await verifyLoginCode(user.id, String(formData.get("code") || ""));
  if (!result) {
    await logAudit({ action: "auth.2fa_failed", userId: user.id, detail: user.email });
    return { step: "totp", error: "کد واردشده نادرست یا منقضی است" };
  }
  resetRateLimit(`login2fa:user:${user.id}`);
  await clearPending2fa();
  if (result === "recovery") await logAudit({ action: "auth.2fa_recovery_used", userId: user.id, detail: "ورود با کد بازیابی" });
  return finishLogin(user, formData.get("next"));
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

/** ثبت‌نام فروشنده‌ی جدید: حساب کاربری + فضای کاری اختصاصی (کاملاً ایزوله) */
export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const name = String(formData.get("name") || "").trim().slice(0, 100);
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const mobile = String(formData.get("mobile") || "").trim();
  const password = String(formData.get("password") || "");
  const workspaceName = String(formData.get("workspaceName") || "").trim().slice(0, 60);

  const { ip } = await getRequestInfo();
  if (!rateLimit(`register:${ip}`, 6, 60 * 60_000).ok) return { error: "تعداد ثبت‌نام از این شبکه زیاد بود؛ بعداً تلاش کنید." };
  if (!name) return { error: "نام خود را وارد کنید" };
  if (!EMAIL_RE.test(email)) return { error: "ایمیل معتبر نیست" };
  if (!MOBILE_RE.test(mobile)) return { error: "موبایل باید به‌صورت 09xxxxxxxxx باشد (برای کد تایید پیامکی)" };
  if (!workspaceName) return { error: "نام کسب‌وکار / فروشگاه را وارد کنید" };
  const bad = passwordProblem(password);
  if (bad) return { error: bad };
  const rejected = await emailRejection(email);
  if (rejected) return { error: rejected };

  const [exists] = await db.select().from(users).where(eq(users.email, email));
  if (exists) {
    // ثبت‌نام نیمه‌کاره (ایمیل هنوز تأیید نشده): فقط کد تازه می‌فرستیم. رمز/نام حساب موجود هرگز بازنویسی نمی‌شود؛
    // اگر کسی ایمیل دیگری را «اشغال» کرده باشد، صاحب واقعی با «فراموشی رمز» حساب را تصاحب و تأیید می‌کند.
    if (emailVerificationRequired() && !exists.emailVerifiedAt) {
      // پیش‌ربایی حساب (Pre-Account Takeover): مهاجم می‌تواند ایمیل قربانی را با رمز خودش ثبت‌نام کند و منتظر بماند
      // تا قربانی ایمیل را تأیید کند. پس رمز حساب تأییدنشده با رمز آخرین ثبت‌نام‌کننده جایگزین می‌شود (فقط رمز؛
      // نام و موبایل دست‌نخورده می‌ماند چون حساب ممکن است مشتریِ ساخته‌شده توسط یک فضای کاری باشد) و کدهای قبلی باطل می‌شوند.
      const newHash = await hashPasswordAsync(password);
      const owned = await withTransaction(async () => {
        const [row] = await db.update(users).set({ passwordHash: newHash }).where(and(eq(users.id, exists.id), isNull(users.emailVerifiedAt))).returning();
        if (row) await logAudit({ action: "auth.pending_reregistered", userId: exists.id, detail: email });
        return row;
      });
      if (!owned) return { error: "با این ایمیل قبلاً ثبت‌نام شده است. وارد شوید یا رمز را بازیابی کنید." };
      await createPendingVerify(owned.id, owned.passwordHash);
      return verifyRedirect(await sendVerificationEmail(owned, await getOrigin()));
    }
    return { error: "با این ایمیل قبلاً ثبت‌نام شده است. وارد شوید یا رمز را بازیابی کنید." };
  }

  // اولین کاربر ثبت‌نام‌شده روی دیتابیس خالی، «مدیر کل پلتفرم» (پاسخ‌گوی تیکت‌ها) می‌شود
  // مدیر کل: اولین ثبت‌نام «واقعی» وقتی هنوز هیچ مدیری نیست (حساب‌های ساخته‌شده توسط اتصال خودکار وردپرس مدیر نمی‌شوند)
  // اتمی: حساب کاربری + فضای کاری (عضویت مالک، تنظیمات، قالب‌های نمونه) + لاگ‌ها یک واحدند؛
  // اگر ساخت فضای کاری شکست بخورد، حساب هم ساخته نمی‌شود و کاربر «بدون فضای کاری» نمی‌ماند.
  // هش رمز (CPU-سنگین) بیرون از تراکنش و بدون مسدود کردن حلقه‌ی رویداد محاسبه می‌شود تا اتصال دیتابیس معطل نماند
  const passwordHash = await hashPasswordAsync(password);
  const { user, wsId } = await withTransaction(async () => {
    const [{ n: userCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.role, "admin"));
    const [created] = await db.insert(users).values({ name, email, mobile, passwordHash, role: userCount === 0 ? "admin" : "user", emailVerifiedAt: emailVerificationRequired() ? null : new Date() }).returning();
    const id = await createWorkspace(created.id, workspaceName);
    await logAudit({ action: "auth.registered", userId: created.id, workspaceId: id, detail: email });
    await logAudit({ action: "workspace.created", userId: created.id, workspaceId: id, detail: workspaceName });
    return { user: created, wsId: id };
  });
  // دعوت از دوستان: کد از فرم یا کوکی لینک دعوت (/r/CODE) خوانده می‌شود؛ خطا هرگز ثبت‌نام را مختل نمی‌کند
  const jar = await cookies();
  const refCode = String(formData.get("ref") || "").trim() || jar.get("amz_ref")?.value || "";
  if (refCode) {
    await attachReferral({ code: refCode, referred: { id: user.id, mobile }, workspaceId: wsId, ip });
    jar.delete("amz_ref");
  }
  if (emailVerificationRequired()) {
    // تا تأیید مالکیت ایمیل هیچ نشستی ساخته نمی‌شود
    await createPendingVerify(user.id, user.passwordHash);
    return verifyRedirect(await sendVerificationEmail(user, await getOrigin()));
  }
  await createSession(user.id, user.passwordHash);
  await setActiveWorkspaceCookie(wsId);
  redirect("/admin");
}

/** تأیید ایمیل با کد ۶ رقمی (کاربر با کوکی میانی به این مرحله رسیده است) */
export async function verifyEmailCodeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await readPendingVerify();
  if (!user) return { error: "مهلت این مرحله تمام شده؛ دوباره وارد شوید یا ثبت‌نام کنید." };
  const { ip } = await getRequestInfo();
  if (!rateLimit(`verify:user:${user.id}`, 12, 15 * 60_000).ok || !rateLimit(`verify:ip:${ip}`, 40, 15 * 60_000).ok) {
    return { error: "تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید." };
  }
  if (!user.emailVerifiedAt) {
    const r = await verifyEmailCode(user.id, String(formData.get("code") || ""));
    if (!r.ok) {
      await logAudit({ action: "auth.email_verify_failed", userId: user.id, detail: user.email });
      return { error: r.error };
    }
    await logAudit({ action: "auth.email_verified", userId: user.id, detail: user.email });
  }
  await clearPendingVerify();
  return finishLogin(user, null);
}

/** ارسال مجدد کد تأیید ایمیل */
export async function resendVerificationAction(): Promise<FormState> {
  const user = await readPendingVerify();
  if (!user) return { error: "مهلت این مرحله تمام شده؛ دوباره وارد شوید." };
  if (user.emailVerifiedAt) return { ok: true, message: "ایمیل شما قبلاً تأیید شده است." };
  const { ip } = await getRequestInfo();
  if (!rateLimit(`verify-resend:user:${user.id}`, 5, 60 * 60_000).ok || !rateLimit(`verify-resend:ip:${ip}`, 15, 60 * 60_000).ok) {
    return { error: "درخواست‌های ارسال زیاد بود؛ کمی بعد دوباره تلاش کنید." };
  }
  const r = await sendVerificationEmail(user, await getOrigin());
  if (!r.ok) return { error: r.error, seconds: r.seconds };
  return { ok: true, message: "کد تازه به ایمیل شما ارسال شد.", seconds: r.seconds, devCode: showDevSecrets() ? r.devCode : undefined };
}

/** تأیید با لینک ایمیل (فقط با کلیک روی دکمه‌ی صفحه؛ باز شدن لینک توسط ربات‌ها چیزی را مصرف نمی‌کند) */
export async function confirmEmailLinkAction(formData: FormData) {
  const token = String(formData.get("token") || "");
  const { ip } = await getRequestInfo();
  if (!rateLimit(`verify-link:${ip}`, 30, 15 * 60_000).ok) redirect(`/verify-email/${encodeURIComponent(token.slice(0, 64))}?failed=1`);
  const userId = await consumeVerifyToken(token);
  if (!userId) redirect(`/verify-email/${encodeURIComponent(token.slice(0, 64))}?failed=1`);
  await logAudit({ action: "auth.email_verified", userId, detail: "با لینک ایمیل" });
  const pending = await readPendingVerify();
  if (pending && pending.id === userId) {
    await clearPendingVerify();
    return finishLogin(pending, null);
  }
  redirect("/login?verified=1");
}

/** درخواست بازیابی رمز: پاسخ همیشه یکسان است تا وجود/عدم وجود ایمیل فاش نشود */
export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const { ip } = await getRequestInfo();
  if (!rateLimit(`forgot:${ip}`, 8, 60 * 60_000).ok || !rateLimit(`forgot:${email}`, 3, 60 * 60_000).ok) {
    return { error: "درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید." };
  }
  if (!EMAIL_RE.test(email)) return { error: "ایمیل معتبر نیست" };
  const generic: FormState = { ok: true, message: "اگر این ایمیل در سامانه ثبت شده باشد، لینک تعیین رمز جدید برای آن ارسال می‌شود." };

  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return generic;
  // بسته شکست خوردن (SEC-01): بدون آدرس مورد اعتماد (APP_URL / TRUSTED_HOSTS) هرگز توکن واقعی صادر یا لینک ساخته نمی‌شود
  const origin = await getOrigin();
  if (!origin) {
    console.error("[security] بازیابی رمز انجام نشد: APP_URL (یا TRUSTED_HOSTS) تنظیم نشده است؛ لینک از هدر Host ساخته نمی‌شود.");
    return generic;
  }
  const ms = await getMemberships(user.id);
  // ساخت توکن + لاگ ممیزی اتمی‌اند؛ ایمیل (کار شبکه‌ای) پس از commit ارسال می‌شود
  const token = await withTransaction(async () => {
    const t = await createResetToken(user.id, 2);
    await logAudit({ action: "auth.password_reset", userId: user.id, workspaceId: ms[0]?.workspaceId ?? 0, detail: "درخواست بازیابی" });
    return t;
  });
  const link = `${origin}/reset/${token}`;
  await sendMail({
    to: user.email,
    subject: "بازیابی رمز عبور",
    html: `<div dir="rtl"><p>${escapeHtml(user.name)} عزیز، برای تعیین رمز عبور جدید روی لینک زیر بزنید (تا ۲ ساعت معتبر است):</p><p><a href="${link}">${link}</a></p><p>اگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید.</p></div>`,
    workspaceId: ms[0]?.workspaceId ?? 0,
  });
  return showDevLinks() ? { ...generic, devLink: link } : generic;
}

/** تعیین رمز با توکن (بازیابی رمز یا فعال‌سازی حساب مشتری) */
export async function resetPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const token = String(formData.get("token") || "");
  const password = String(formData.get("password") || "");
  if (password !== String(formData.get("confirm") || "")) return { error: "تکرار رمز عبور یکسان نیست" };
  const bad = passwordProblem(password);
  if (bad) return { error: bad };
  // مصرف توکن + تغییر رمز + لاگ ممیزی یک واحد اتمی‌اند
  const userId = await withTransaction(async () => {
    const id = await consumeResetToken(token, password);
    if (id) await logAudit({ action: "auth.password_reset", userId: id, detail: "رمز جدید تعیین شد" });
    return id;
  });
  if (!userId) return { error: "این لینک نامعتبر است یا مهلت آن تمام شده. دوباره درخواست دهید." };
  redirect("/login?reset=1");
}

/** پذیرش دعوت‌نامه‌ی تیم: کاربر واردشده (با همان ایمیل) یا ساخت حساب جدید با ایمیل دعوت‌شده */
export async function acceptInviteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const token = String(formData.get("token") || "");
  const inv = await findInvite(token);
  if (!inv) return { error: "دعوت‌نامه نامعتبر است یا مهلت آن تمام شده" };

  const [existingUser] = await db.select().from(users).where(eq(users.email, inv.email));
  let newAccount: { name: string; mobile: string; password: string } | null = null;
  if (!existingUser) {
    const name = String(formData.get("name") || "").trim().slice(0, 100);
    const mobile = String(formData.get("mobile") || "").trim();
    const password = String(formData.get("password") || "");
    if (!name) return { error: "نام خود را وارد کنید" };
    if (!MOBILE_RE.test(mobile)) return { error: "موبایل باید به‌صورت 09xxxxxxxxx باشد" };
    const bad = passwordProblem(password);
    if (bad) return { error: bad };
    newAccount = { name, mobile, password };
  } else {
    // حساب موجود: باید همان کاربر لاگین باشد (جلوگیری از پذیرش دعوت با لینک لورفته)
    const { getCurrentUser } = await import("./session");
    const cur = await getCurrentUser();
    if (!cur || cur.id !== existingUser.id) return { error: "برای پذیرش دعوت ابتدا با همین ایمیل وارد شوید." };
  }

  // اتمی: ساخت حساب (در صورت نیاز) + مصرف دعوت‌نامه + عضویت + لاگ؛ اگر پذیرش دعوت ممکن نشود حساب هم ساخته نمی‌شود
  const newAccountHash = newAccount ? await hashPasswordAsync(newAccount.password) : null;
  let joined: { user: typeof users.$inferSelect; workspaceId: number } | null;
  try {
    joined = await withTransaction(async () => {
      let user = existingUser;
      if (newAccount && newAccountHash) {
        [user] = await db.insert(users).values({ name: newAccount.name, email: inv.email, mobile: newAccount.mobile, passwordHash: newAccountHash, role: "user", emailVerifiedAt: new Date() }).returning();
      }
      const res = await acceptInvite(token, user.id);
      if (!res) throw new InviteNotAccepted();
      await logAudit({ action: "member.joined", userId: user.id, workspaceId: res.workspaceId, detail: user.email });
      return { user, workspaceId: res.workspaceId };
    });
  } catch (e) {
    if (e instanceof InviteNotAccepted) return { error: "پذیرش دعوت ممکن نشد" };
    throw e;
  }
  await createSession(joined.user.id, joined.user.passwordHash);
  await setActiveWorkspaceCookie(joined.workspaceId);
  redirect("/admin");
}
