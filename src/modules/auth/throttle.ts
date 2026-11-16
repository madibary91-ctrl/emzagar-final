import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { userSessions, users } from "@/db/schema";
import { rateLimitDb, resetRateLimitDb } from "@/lib/rate-limit-db";

/**
 * M-03 — محدودیت ورود «بدون قفل‌کردن حساب دیگران».
 *
 * مشکل: کلید `login:email:<email>` با ۸ تلاش، حساب قربانی را برای هر کسی (حتی غریبه) ۱۵ دقیقه می‌بست و مهاجم می‌توانست
 * تا ابد تکرار کند. اکنون قفل «به منبع تلاش» گره خورده است نه فقط به حساب:
 *
 *  ۱) `login:ip`   — سقف هر IP (۳۰ در ۱۵ دقیقه)؛
 *  ۲) `login:pair` — سقف «ایمیل + IP» (۸ در ۱۵ دقیقه): مهاجم فقط خودش را قفل می‌کند، نه صاحب حساب را؛
 *  ۳) `login:acct` — سقف تجمعیِ حساب برای «منبع‌های ناآشنا» (۱۵ در ۱۵ دقیقه) برای حدس توزیع‌شده:
 *       وقتی پر شد فقط IPهایی مسدود می‌شوند که طی ۹۰ روز اخیر ورود موفق به همین حساب نداشته‌اند.
 *       صاحب حساب از IPهای آشنای خودش همیشه می‌تواند وارد شود (مهاجم نمی‌تواند او را بیرون کند)،
 *       و از مکان جدید هم «فراموشی رمز» در دسترس است.
 *
 * کلید ایمیل همیشه نرمال‌سازی (NFKC، کوچک، حداکثر ۲۵۴) و در لایه‌ی دیتابیس «کامل» هش می‌شود (بدون برخورد پیشوند).
 */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_IP_LIMIT = 30;
export const LOGIN_PAIR_LIMIT = 8;
export const LOGIN_ACCT_UNFAMILIAR_LIMIT = 15;
const KNOWN_IP_DAYS = 90;

export const normalizeEmailKey = (email: string): string => email.normalize("NFKC").trim().toLowerCase().slice(0, 254);

const keys = (email: string, ip: string) => ({
  ip: `login:ip:${ip}`,
  pair: `login:pair:${normalizeEmailKey(email)}|${ip}`,
  acct: `login:acct:${normalizeEmailKey(email)}`,
});

/** آیا این IP در ۹۰ روز اخیر نشست موفق برای این ایمیل داشته است؟ (فقط برای IP معتبر؛ «unknown» هرگز آشنا نیست) */
export async function isFamiliarLoginIp(email: string, ip: string): Promise<boolean> {
  if (!ip || ip === "unknown") return false;
  const [row] = await db
    .select({ id: userSessions.id })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(users.email, normalizeEmailKey(email)), eq(userSessions.ip, ip), gt(userSessions.createdAt, new Date(Date.now() - KNOWN_IP_DAYS * 86400_000))))
    .limit(1);
  return !!row;
}

/** هر تلاش ورود را می‌شمارد و می‌گوید اجازه‌ی ادامه دارد یا نه. هر سه شمارنده همیشه (یکسان برای ایمیل موجود/ناموجود) افزایش می‌یابد. */
export async function checkLoginThrottle(email: string, ip: string): Promise<{ ok: boolean; retryAfter: number }> {
  const k = keys(email, ip);
  const [byIp, byPair, byAcct] = await Promise.all([
    rateLimitDb(k.ip, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS),
    rateLimitDb(k.pair, LOGIN_PAIR_LIMIT, LOGIN_WINDOW_MS),
    rateLimitDb(k.acct, LOGIN_ACCT_UNFAMILIAR_LIMIT, LOGIN_WINDOW_MS),
  ]);
  if (!byIp.ok) return byIp;
  if (!byPair.ok) return byPair;
  if (!byAcct.ok && !(await isFamiliarLoginIp(email, ip))) return byAcct;
  return { ok: true, retryAfter: 0 };
}

/** پس از ورود موفق: شمارنده‌ی «ایمیل + IP» همین کاربر پاک می‌شود (شمارنده‌ی تجمعی حساب عمداً دست‌نخورده می‌ماند) */
export async function clearLoginThrottle(email: string, ip: string): Promise<void> {
  await resetRateLimitDb(keys(email, ip).pair);
}

/* ───── مرحله‌ی دوم ورود (TOTP): همان منطق، با کلید کاربر ───── */
export const TOTP_PAIR_LIMIT = 6;
export const TOTP_USER_LIMIT = 12;

export async function checkTotpThrottle(userId: number, ip: string): Promise<boolean> {
  const [pair, user, byIp] = await Promise.all([
    rateLimitDb(`login2fa:pair:${userId}|${ip}`, TOTP_PAIR_LIMIT, LOGIN_WINDOW_MS),
    rateLimitDb(`login2fa:user:${userId}`, TOTP_USER_LIMIT, LOGIN_WINDOW_MS),
    rateLimitDb(`login2fa:ip:${ip}`, 40, LOGIN_WINDOW_MS),
  ]);
  return pair.ok && user.ok && byIp.ok;
}

export async function clearTotpThrottle(userId: number, ip: string): Promise<void> {
  await Promise.all([resetRateLimitDb(`login2fa:pair:${userId}|${ip}`), resetRateLimitDb(`login2fa:user:${userId}`)]);
}
