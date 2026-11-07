import crypto from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, withTransaction } from "@/db";
import { passwordResets, users } from "@/db/schema";
import { hashPasswordAsync, sha256 } from "@/lib/password";

/** توکن یک‌بارمصرف تعیین/بازیابی رمز؛ فقط هش آن در دیتابیس می‌ماند */
export async function createResetToken(userId: number, ttlHours = 72): Promise<string> {
  const plain = crypto.randomBytes(32).toString("hex");
  await db.insert(passwordResets).values({ userId, tokenHash: sha256(plain), expiresAt: new Date(Date.now() + ttlHours * 3600_000) });
  return plain;
}

export async function findResetToken(plain: string) {
  if (!/^[a-f0-9]{64}$/.test(plain)) return null;
  const [row] = await db
    .select({ id: passwordResets.id, userId: passwordResets.userId, name: users.name, email: users.email })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, sha256(plain)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())));
  return row ?? null;
}

/**
 * تعیین رمز جدید؛ همه‌ی نشست‌های قبلی (به‌دلیل تغییر hash) باطل می‌شوند.
 * اتمی: «مصرف توکن» و «تغییر رمز» یک واحدند؛ اگر رمز ذخیره نشود، توکن سوخته نمی‌شود و کاربر می‌تواند دوباره تلاش کند.
 */
export async function consumeResetToken(plain: string, newPassword: string): Promise<number | null> {
  const row = await findResetToken(plain);
  if (!row) return null;
  const newHash = await hashPasswordAsync(newPassword);
  return withTransaction(async () => {
    const used = await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt)))
      .returning({ id: passwordResets.id });
    if (used.length === 0) return null;
    await db
      .update(users)
      // دریافت لینک در صندوق ایمیل، خودش مالکیت ایمیل را ثابت می‌کند
      .set({ passwordHash: newHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, row.userId));
    return row.userId;
  });
}
