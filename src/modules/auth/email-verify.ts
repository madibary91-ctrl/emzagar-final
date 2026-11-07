import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailVerifications, users } from "@/db/schema";
import { sha256 } from "@/lib/password";
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

export const showDevSecrets = () => process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_OTP === "1";

const codeHash = (userId: number, code: string) => sha256(`${getSecret()}:emailverify:${userId}:${code}`);

export async function secondsUntilVerifyResend(userId: number): Promise<number> {
  const [last] = await db.select({ at: emailVerifications.createdAt }).from(emailVerifications).where(eq(emailVerifications.userId, userId)).orderBy(desc(emailVerifications.createdAt)).limit(1);
  if (!last) return 0;
  return Math.max(0, Math.ceil(VERIFY_RESEND_SECONDS - (Date.now() - last.at.getTime()) / 1000));
}

/** صدور کد جدید؛ کدهای قبلیِ مصرف‌نشده باطل می‌شوند */
export async function createEmailVerification(userId: number, email: string): Promise<{ code: string; token: string }> {
  const code = String(crypto.randomInt(100000, 1000000));
  const token = crypto.randomBytes(32).toString("hex");
  await db.update(emailVerifications).set({ usedAt: new Date() }).where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)));
  await db.insert(emailVerifications).values({
    userId,
    email,
    codeHash: codeHash(userId, code),
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
  });
  // پاک‌سازی رکوردهای قدیمی (بیش از ۷ روز)
  await db.delete(emailVerifications).where(lt(emailVerifications.createdAt, new Date(Date.now() - 7 * 86400_000)));
  return { code, token };
}

export type SendVerifyResult = { ok: boolean; error?: string; seconds?: number; devCode?: string; devLink?: string };

/** ساخت و ارسال کد/لینک تأیید. محدودیت ارسال مجدد: هر ۶۰ ثانیه */
export async function sendVerificationEmail(user: { id: number; name: string; email: string }, origin: string): Promise<SendVerifyResult> {
  // بسته شکست خوردن (SEC-01): لینک توکن‌دار فقط به آدرس مورد اعتماد ساخته می‌شود
  if (!/^https?:\/\/[^\s/]+$/.test(origin)) {
    console.error("[security] ارسال تأیید ایمیل انجام نشد: APP_URL (یا TRUSTED_HOSTS) تنظیم نشده است.");
    return { ok: false, error: "آدرس سایت روی سرور تنظیم نشده است؛ با مدیر سامانه تماس بگیرید." };
  }
  const wait = await secondsUntilVerifyResend(user.id);
  if (wait > 0) return { ok: false, error: `برای ارسال مجدد ${wait} ثانیه صبر کنید`, seconds: wait };
  const { code, token } = await createEmailVerification(user.id, user.email);
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

async function markVerified(userId: number, email: string): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(and(eq(users.id, userId), eq(users.email, email)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/** تأیید با کد ۶ رقمی. شمارنده‌ی تلاش «اتمیک» است (حداکثر ۵ تلاش برای هر کد) */
export async function verifyEmailCode(userId: number, code: string): Promise<{ ok: boolean; error?: string }> {
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
  if (!(await markVerified(userId, row.email))) return { ok: false, error: "ایمیل حساب تغییر کرده است؛ کد جدید دریافت کنید" };
  return { ok: true };
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

/** تأیید با لینک؛ شناسه‌ی کاربر را برمی‌گرداند */
export async function consumeVerifyToken(token: string): Promise<number | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const used = await db
    .update(emailVerifications)
    .set({ usedAt: new Date() })
    .where(and(eq(emailVerifications.tokenHash, sha256(token)), isNull(emailVerifications.usedAt), gt(emailVerifications.expiresAt, new Date())))
    .returning({ userId: emailVerifications.userId, email: emailVerifications.email });
  if (used.length === 0) return null;
  return (await markVerified(used[0].userId, used[0].email)) ? used[0].userId : null;
}
