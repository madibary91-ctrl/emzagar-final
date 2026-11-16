import crypto from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { userTotp } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { sha256 } from "@/lib/password";
import { generateTotpSecret, verifyTotp } from "@/lib/totp";

/** منطق ورود دومرحله‌ای (TOTP + کدهای بازیابی). فایل «use server» نیست؛ اکشن‌ها در modules/account هستند. */

const RECOVERY_COUNT = 8;
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // بدون نویسه‌های شبیه‌به‌هم (i, l, o, 0, 1)

const hashRecovery = (code: string) => sha256(`recovery:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);

function makeRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_COUNT }, () => {
    const bytes = crypto.randomBytes(10);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

function parseHashes(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function getTotpRow(userId: number) {
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  return row ?? null;
}

export async function isTotpEnabled(userId: number): Promise<boolean> {
  const row = await getTotpRow(userId);
  return !!row?.enabledAt;
}

/** وضعیت برای صفحه‌ی حساب: فعال / در حال راه‌اندازی / غیرفعال (راز هرگز به کلاینت نمی‌رود، مگر هنگام راه‌اندازی برای ساخت QR سمت سرور) */
export async function totpStatus(userId: number) {
  const row = await getTotpRow(userId);
  if (!row) return { state: "off" as const };
  if (row.enabledAt) return { state: "on" as const, enabledAt: row.enabledAt, recoveryLeft: parseHashes(row.recoveryHashes).length };
  return { state: "pending" as const, secret: decryptSecret(row.secret) };
}

/** شروع راه‌اندازی: راز تازه می‌سازد (راه‌اندازی نیمه‌کاره‌ی قبلی را جایگزین می‌کند). اگر فعال باشد null. */
export async function beginTotpSetup(userId: number): Promise<string | null> {
  const row = await getTotpRow(userId);
  if (row?.enabledAt) return null;
  const secret = generateTotpSecret();
  await db
    .insert(userTotp)
    .values({ userId, secret: encryptSecret(secret) })
    .onConflictDoUpdate({ target: userTotp.userId, set: { secret: encryptSecret(secret), lastStep: 0, recoveryHashes: "[]", createdAt: new Date() } });
  return secret;
}

/** تأیید کد اول و فعال‌سازی؛ کدهای بازیابی فقط همین یک بار به‌صورت متن ساده برمی‌گردند */
export async function confirmTotpSetup(userId: number, code: string): Promise<string[] | null> {
  const row = await getTotpRow(userId);
  if (!row || row.enabledAt) return null;
  const step = verifyTotp(decryptSecret(row.secret), code, 0);
  if (step === null) return null;
  const codes = makeRecoveryCodes();
  const updated = await db
    .update(userTotp)
    .set({ enabledAt: new Date(), lastStep: step, recoveryHashes: JSON.stringify(codes.map(hashRecovery)) })
    .where(and(eq(userTotp.userId, userId), sql`${userTotp.enabledAt} is null`))
    .returning({ userId: userTotp.userId });
  return updated.length ? codes : null;
}

/**
 * بررسی کد هنگام ورود/عملیات حساس. نتیجه: "totp" | "recovery" | null.
 * - TOTP: بازه‌ی کد به‌صورت اتمیک ثبت می‌شود (کد مصرف‌شده یا موازی دوباره پذیرفته نمی‌شود).
 * - کد بازیابی: یک‌بارمصرف است و هنگام استفاده از فهرست حذف می‌شود.
 */
export async function verifyLoginCode(userId: number, input: string): Promise<"totp" | "recovery" | null> {
  const row = await getTotpRow(userId);
  if (!row?.enabledAt) return null;
  const clean = input.trim();

  if (/^\d{3}\s?\d{3}$/.test(clean)) {
    const step = verifyTotp(decryptSecret(row.secret), clean, row.lastStep);
    if (step === null) return null;
    const claimed = await db
      .update(userTotp)
      .set({ lastStep: step })
      .where(and(eq(userTotp.userId, userId), lt(userTotp.lastStep, step)))
      .returning({ userId: userTotp.userId });
    return claimed.length ? "totp" : null;
  }

  const normalized = clean.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length !== 10) return null;
  const hash = hashRecovery(normalized);
  const hashes = parseHashes(row.recoveryHashes);
  const idx = hashes.findIndex((h) => h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
  if (idx === -1) return null;
  const rest = hashes.filter((_, i) => i !== idx);
  // شرط روی مقدار قبلی: دو درخواست هم‌زمان با یک کد بازیابی نمی‌توانند هر دو موفق شوند
  const claimed = await db
    .update(userTotp)
    .set({ recoveryHashes: JSON.stringify(rest) })
    .where(and(eq(userTotp.userId, userId), eq(userTotp.recoveryHashes, row.recoveryHashes)))
    .returning({ userId: userTotp.userId });
  return claimed.length ? "recovery" : null;
}

/** ساخت دوباره‌ی کدهای بازیابی (کدهای قبلی باطل می‌شوند) */
export async function regenerateRecoveryCodes(userId: number): Promise<string[] | null> {
  const row = await getTotpRow(userId);
  if (!row?.enabledAt) return null;
  const codes = makeRecoveryCodes();
  await db.update(userTotp).set({ recoveryHashes: JSON.stringify(codes.map(hashRecovery)) }).where(eq(userTotp.userId, userId));
  return codes;
}

export async function disableTotp(userId: number) {
  await db.delete(userTotp).where(eq(userTotp.userId, userId));
}
