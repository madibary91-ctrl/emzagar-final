import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { revokeOwnedConnections } from "@/modules/connect/service/connections";
import { emailVerifications, users } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { devSecretsVisible } from "@/lib/dev-flags";
import { getSecret } from "@/lib/secret";
import { escapeHtml } from "@/lib/html";
import { sendMail } from "@/modules/mail";

export const VERIFY_TTL_MS = 30 * 60_000;
export const VERIFY_RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

/** در نصب‌های شخصی بدون SMTP می‌توان با REQUIRE_EMAIL_VERIFICATION=0 این الزام را برداشت (پیش‌فرض: الزامی) */
export function emailVerificationRequired(): boolean {
  return process.env.REQUIRE_EMAIL_VERIFICATION !== "0";
}

export const showDevSecrets = () => devSecretsVisible();

const codeHash = (userId: number, code: string) => sha256(`${getSecret()}:emailverify:${userId}:${code}`);

export async function secondsUntilVerifyResend(userId: number): Promise<number> {
  const [last] = await db.select({ at: emailVerifications.createdAt }).from(emailVerifications).where(eq(emailVerifications.userId, userId)).orderBy(desc(emailVerifications.createdAt)).limit(1);
  if (!last) return 0;
  return Math.max(0, Math.ceil(VERIFY_RESEND_SECONDS - (Date.now() - last.at.getTime()) / 1000));
}

/**
 * H-03: «ثبت‌نام در انتظار» — رمز انتخابی ثبت‌نام‌کننده‌ی مجدد + رازِ گره‌خورده به مرورگر او.
 * bindingHash = sha256(binding)؛ خود binding فقط داخل کوکی امضاشده‌ی همان مرورگر است.
 */
export type PendingRegistration = { passwordHash: string; bindingHash: string };

export const newBinding = () => crypto.randomBytes(16).toString("hex");
export const bindingHashOf = (binding: string) => sha256(`${getSecret()}:evbind:${binding}`);

function bindingMatches(row: { bindingHash: string | null }, binding: string | undefined): boolean {
  if (!row.bindingHash || !binding) return false;
  const a = Buffer.from(row.bindingHash);
  const b = Buffer.from(bindingHashOf(binding));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * صدور کد جدید؛ کدهای قبلیِ مصرف‌نشده باطل می‌شوند.
 * pending === undefined ⇒ ثبت‌نام در انتظار ردیف قبلی (در صورت وجود) به کد تازه منتقل می‌شود (ارسال مجدد کد)،
 * تا ارسال دوباره‌ی کد هیچ‌وقت رمز در انتظار صاحبش را گم نکند و آن را به مرورگر دیگری ندهد.
 */
export async function createEmailVerification(userId: number, email: string, pending?: PendingRegistration | null): Promise<{ code: string; token: string }> {
  const code = String(crypto.randomInt(100000, 1000000));
  const token = crypto.randomBytes(32).toString("hex");
  let carry: PendingRegistration | null = pending ?? null;
  if (pending === undefined) {
    const [last] = await db.select({ p: emailVerifications.pendingPasswordHash, b: emailVerifications.bindingHash }).from(emailVerifications).where(eq(emailVerifications.userId, userId)).orderBy(desc(emailVerifications.createdAt), desc(emailVerifications.id)).limit(1);
    if (last?.p && last.b) carry = { passwordHash: last.p, bindingHash: last.b };
  }
  await db.update(emailVerifications).set({ usedAt: new Date() }).where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)));
  await db.insert(emailVerifications).values({
    userId,
    email,
    codeHash: codeHash(userId, code),
    tokenHash: sha256(token),
    pendingPasswordHash: carry?.passwordHash ?? null,
    bindingHash: carry?.bindingHash ?? null,
    expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
  });
  // پاک‌سازی رکوردهای قدیمی (بیش از ۷ روز)
  await db.delete(emailVerifications).where(lt(emailVerifications.createdAt, new Date(Date.now() - 7 * 86400_000)));
  return { code, token };
}

/**
 * ثبت‌نام مجدد هنگام «محدودیت ارسال» (کد تازه‌ای ساخته نمی‌شود): ثبت‌نام در انتظار به کد/لینکِ در جریان گره می‌خورد
 * (جانشین هر ثبت‌نام در انتظار قبلی می‌شود؛ آخرین ثبت‌نام‌کننده فقط «ادعای» اعمال رمز را دارد، نه خود رمز را).
 */
export async function attachPendingToActive(userId: number, pending: PendingRegistration): Promise<void> {
  await db
    .update(emailVerifications)
    .set({ pendingPasswordHash: pending.passwordHash, bindingHash: pending.bindingHash })
    .where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)));
}

export type SendVerifyResult = { ok: boolean; error?: string; seconds?: number; devCode?: string; devLink?: string };

/** ساخت و ارسال کد/لینک تأیید. محدودیت ارسال مجدد: هر ۶۰ ثانیه */
export async function sendVerificationEmail(user: { id: number; name: string; email: string }, origin: string, pending?: PendingRegistration | null): Promise<SendVerifyResult> {
  // بسته شکست خوردن (SEC-01): لینک توکن‌دار فقط به آدرس مورد اعتماد ساخته می‌شود
  if (!/^https?:\/\/[^\s/]+$/.test(origin)) {
    console.error("[security] ارسال تأیید ایمیل انجام نشد: APP_URL (یا TRUSTED_HOSTS) تنظیم نشده است.");
    return { ok: false, error: "آدرس سایت روی سرور تنظیم نشده است؛ با مدیر سامانه تماس بگیرید." };
  }
  const wait = await secondsUntilVerifyResend(user.id);
  if (wait > 0) return { ok: false, error: `برای ارسال مجدد ${wait} ثانیه صبر کنید`, seconds: wait };
  const { code, token } = await createEmailVerification(user.id, user.email, pending);
  const link = `${origin}/verify-email/${token}`;
  const mail = await sendMail({
    to: user.email,
    subject: `کد تأیید ایمیل: ${code}`,
    html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(user.name)} عزیز، برای تکمیل ثبت‌نام، کد زیر را در صفحه‌ی تأیید ایمیل وارد کنید:</p><p style="font-size:30px;font-weight:bold;letter-spacing:8px" dir="ltr">${code}</p><p>یا روی لینک زیر بزنید (۳۰ دقیقه معتبر است):</p><p><a href="${link}">${link}</a></p><p style="color:#666;font-size:12px">اگر شما ثبت‌نام نکرده‌اید، این ایمیل را نادیده بگیرید؛ هیچ اقدامی لازم نیست.</p></div>`,
    workspaceId: 0,
  });
  const delivered = mail.status === "sent";
  if (!delivered && !showDevSecrets()) {
    return { ok: false, error: mail.status === "failed" ? "ارسال ایمیل ناموفق بود؛ چند دقیقه بعد دوباره تلاش کنید." : "ارسال ایمیل در این سامانه پیکربندی نشده است. با مدیر سامانه تماس بگیرید." };
  }
  return { ok: true, seconds: VERIFY_RESEND_SECONDS, ...(delivered ? {} : { devCode: code, devLink: link }) };
}

/**
 * مالکیت صندوق ایمیل برای اولین‌بار ثابت شد (تأیید ایمیل یا بازیابی رمز): هر اتصال/کلید API که پیش از این
 * «به نام» این ایمیل‌ِ تأییدنشده ساخته شده باشد باطل می‌شود (H-02: فضای کاری از پیش‌آلوده به مالک واقعی نرسد).
 */
export async function onEmailOwnershipProven(userId: number): Promise<void> {
  await revokeOwnedConnections(userId).catch((e) => console.error("[security] revokeOwnedConnections", e));
}

/**
 * ایمیل را تأیید می‌کند و (فقط اگر `applyPasswordHash` داده شود و حساب هنوز تأییدنشده باشد) رمز در انتظار را اتمیک
 * می‌نشاند. شرط «هنوز تأییدنشده» جلوی بازنویسی رمزی را می‌گیرد که صاحب حساب بعداً با «فراموشی رمز» گذاشته است.
 */
async function markVerified(userId: number, email: string, applyPasswordHash?: string): Promise<boolean> {
  const [before] = await db.select({ at: users.emailVerifiedAt }).from(users).where(and(eq(users.id, userId), eq(users.email, email)));
  if (!before) return false;
  const rows = await db
    .update(users)
    .set({
      emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
      ...(applyPasswordHash ? { passwordHash: sql`case when ${users.emailVerifiedAt} is null then ${applyPasswordHash} else ${users.passwordHash} end` } : {}),
    })
    .where(and(eq(users.id, userId), eq(users.email, email)))
    .returning({ id: users.id });
  if (rows.length > 0 && !before.at) await onEmailOwnershipProven(userId);
  return rows.length > 0;
}

export type VerifyOutcome = { ok: boolean; error?: string; /** آیا اجازه‌ی ساخت نشست برای همین مرورگر هست؟ */ sessionAllowed?: boolean };

/**
 * تأیید با کد ۶ رقمی. شمارنده‌ی تلاش «اتمیک» است (حداکثر ۵ تلاش برای هر کد).
 * `binding`: رازِ کوکی مرورگر فعلی. اگر ردیف «رمز در انتظار» داشته باشد، فقط با binding درست رمز اعمال و نشست مجاز می‌شود؛
 * در غیر این صورت ایمیل تأیید می‌شود (صاحب صندوق ثابت شد) اما رمز حساب «غیرقابل‌استفاده» می‌ماند و نشستی ساخته نمی‌شود.
 */
export async function verifyEmailCode(userId: number, code: string, binding?: string): Promise<VerifyOutcome> {
  const clean = code.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, "");
  const [row] = await db
    .select()
    .from(emailVerifications)
    .where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)))
    .orderBy(desc(emailVerifications.createdAt))
    .limit(1);
  if (!row) return { ok: false, error: "کدی برای شما صادر نشده یا قبلاً استفاده شده است؛ کد جدید دریافت کنید" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "کد منقضی شده است؛ کد جدید دریافت کنید" };
  const claimed = await db
    .update(emailVerifications)
    .set({ attempts: sql`${emailVerifications.attempts} + 1` })
    .where(and(eq(emailVerifications.id, row.id), isNull(emailVerifications.usedAt), lt(emailVerifications.attempts, MAX_ATTEMPTS)))
    .returning({ id: emailVerifications.id });
  if (claimed.length === 0) return { ok: false, error: "تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید دریافت کنید" };
  const a = Buffer.from(row.codeHash);
  const b = Buffer.from(codeHash(userId, clean));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "کد واردشده نادرست است" };
  const used = await db.update(emailVerifications).set({ usedAt: new Date() }).where(and(eq(emailVerifications.id, row.id), isNull(emailVerifications.usedAt))).returning({ id: emailVerifications.id });
  if (used.length === 0) return { ok: false, error: "این کد قبلاً استفاده شده است" };
  const sessionAllowed = !row.pendingPasswordHash || bindingMatches(row, binding);
  if (!(await markVerified(userId, row.email, row.pendingPasswordHash && sessionAllowed ? row.pendingPasswordHash : undefined))) return { ok: false, error: "ایمیل حساب تغییر کرده است؛ کد جدید دریافت کنید" };
  return { ok: true, sessionAllowed };
}

/** نمایش اطلاعات لینک بدون مصرف آن (صفحه‌ی تأیید با دکمه؛ ربات‌های اسکن ایمیل لینک را مصرف نکنند) */
export async function peekVerifyToken(token: string): Promise<{ email: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const [row] = await db
    .select({ email: emailVerifications.email })
    .from(emailVerifications)
    .where(and(eq(emailVerifications.tokenHash, sha256(token)), isNull(emailVerifications.usedAt), gt(emailVerifications.expiresAt, new Date())));
  return row ?? null;
}

/** تأیید با لینک؛ شناسه‌ی کاربر و اجازه‌ی ساخت نشست (گره به مرورگر) را برمی‌گرداند */
export async function consumeVerifyTokenDetailed(token: string, binding?: string): Promise<{ userId: number; sessionAllowed: boolean } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const used = await db
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerifications.tokenHash, sha256(token)), isNull(emailVerifications.usedAt), gt(emailVerifications.expiresAt, new Date())))
    .returning({ userId: emailVerifications.userId, email: emailVerifications.email, pending: emailVerifications.pendingPasswordHash, bindingHash: emailVerifications.bindingHash });
  if (used.length === 0) return null;
  const row = used[0];
  const sessionAllowed = !row.pending || bindingMatches(row, binding);
  const ok = await markVerified(row.userId, row.email, row.pending && sessionAllowed ? row.pending : undefined);
  return ok ? { userId: row.userId, sessionAllowed } : null;
}

/** تأیید با لینک؛ شناسه‌ی کاربر را برمی‌گرداند */
export async function consumeVerifyToken(token: string, binding?: string): Promise<number | null> {
  return (await consumeVerifyTokenDetailed(token, binding))?.userId ?? null;
}
