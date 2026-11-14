import crypto from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { otpCodes } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { getSecret } from "@/lib/secret";
import { randomOtp } from "@/lib/otp-digits";

export const OTP_RESEND_SECONDS = 117;
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** سقف حدس‌های نادرست/مصرف‌شده‌ی هر امضاکننده در ۲۴ ساعت (همه‌ی کدها) */
const MAX_ATTEMPTS_PER_DAY = 20;
/** M-09: سقف «کل عمر» (همه‌ی کدهای این امضاکننده): حدس‌زدن آهسته در طول ۶۰ روز عمر لینک هم بی‌اثر می‌شود */
const MAX_ATTEMPTS_LIFETIME = 60;
/** فضای نام قفل مشورتی PostgreSQL برای شمارش اتمیک OTP هر امضاکننده */
const OTP_LOCK_NS = 0x4f545001;

/** سقف «ارسال» کد در هر ساعت برای هر امضاکننده — پایدار در دیتابیس (با ری‌استارت/چندنمونه‌ای ریست نمی‌شود)؛ جلوگیری از پیامک‌بمبارانی و هزینه‌ی پیامک */
export const OTP_MAX_SENDS_PER_HOUR = 6;

const hashCode = (code: string, signerId: number) => sha256(`${getSecret()}:${signerId}:${code}`);

export async function secondsUntilResend(signerId: number): Promise<number> {
  const [last] = await db
    .select()
    .from(otpCodes)
    .where(eq(otpCodes.signerId, signerId))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!last) return 0;
  const elapsed = (Date.now() - last.createdAt.getTime()) / 1000;
  return Math.max(0, Math.ceil(OTP_RESEND_SECONDS - elapsed));
}

export async function otpSendsInLastHour(signerId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(otpCodes)
    .where(and(eq(otpCodes.signerId, signerId), gt(otpCodes.createdAt, new Date(Date.now() - 3600_000))));
  return row?.n ?? 0;
}

export async function createOtp(params: { contractId: number; signerId: number; userId: number }): Promise<string> {
  const code = randomOtp(crypto.randomInt); // M-09: ۶ رقم
  await db.insert(otpCodes).values({
    ...params,
    codeHash: hashCode(code, params.signerId),
    expiresAt: new Date(Date.now() + OTP_TTL_MS),
  });
  return code;
}

/**
 * M-09: «چک سقف» و «ثبت تلاش» اکنون یک واحد اتمی‌اند. پیش‌تر سقف ۲۴ ساعته با SELECT جدا از UPDATE شمارش می‌شد و درخواست‌های موازی
 * چند حدس اضافه می‌زدند. اکنون همه‌ی بررسی‌ها زیر یک قفل مشورتی «به‌ازای هر امضاکننده» داخل یک تراکنش اجرا می‌شوند
 * (در استقرار چندنمونه‌ای هم کار می‌کند چون قفل در PostgreSQL است). تلاش‌های ناموفق commit می‌شوند (خطا throw نمی‌شود).
 */
export async function verifyOtp(signerId: number, code: string): Promise<{ ok: boolean; error?: string }> {
  return withTransaction(async () => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(${OTP_LOCK_NS}, ${signerId})`);
    return verifyOtpLocked(signerId, code);
  });
}

async function verifyOtpLocked(signerId: number, code: string): Promise<{ ok: boolean; error?: string }> {
  const [row] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.signerId, signerId), isNull(otpCodes.usedAt)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!row) return { ok: false, error: "ابتدا کد تایید را دریافت کنید" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "کد منقضی شده است؛ کد جدید دریافت کنید" };
  const dayAgo = new Date(Date.now() - 24 * 3600_000);
  const [spent] = await db
    .select({
      day: sql<number>`coalesce(sum(${otpCodes.attempts}) filter (where ${otpCodes.createdAt} > ${dayAgo}), 0)::int`,
      all: sql<number>`coalesce(sum(${otpCodes.attempts}), 0)::int`,
    })
    .from(otpCodes)
    .where(eq(otpCodes.signerId, signerId));
  if ((spent?.day ?? 0) >= MAX_ATTEMPTS_PER_DAY) return { ok: false, error: "به‌دلیل تلاش‌های ناموفق زیاد، تأیید کد تا ۲۴ ساعت متوقف شد. با فرستنده‌ی قرارداد تماس بگیرید" };
  if ((spent?.all ?? 0) >= MAX_ATTEMPTS_LIFETIME) return { ok: false, error: "تعداد کل تلاش‌های ناموفق این امضاکننده از حد مجاز گذشته است. با فرستنده‌ی قرارداد تماس بگیرید" };
  // شمارنده‌ی تلاش «اتمیک» است: درخواست‌های موازی نمی‌توانند از سقف ۵ تلاش عبور کنند
  const claimed = await db
    .update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(and(eq(otpCodes.id, row.id), isNull(otpCodes.usedAt), lt(otpCodes.attempts, MAX_ATTEMPTS)))
    .returning({ id: otpCodes.id });
  if (claimed.length === 0) return { ok: false, error: "تعداد تلاش‌ها بیش از حد مجاز است؛ کد جدید دریافت کنید" };
  const a = Buffer.from(row.codeHash);
  const b = Buffer.from(hashCode(code.trim(), signerId));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "کد تایید نادرست است" };
  const used = await db.update(otpCodes).set({ usedAt: new Date() }).where(and(eq(otpCodes.id, row.id), isNull(otpCodes.usedAt))).returning({ id: otpCodes.id });
  return used.length ? { ok: true } : { ok: false, error: "این کد قبلاً استفاده شده است" };
}
