import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { userPrefs } from "@/db/schema";

/** ترجیحات کوچک هر کاربر (کلید/مقدار). خطای دیتابیس هرگز صفحه را نمی‌شکند. */
export async function getPref(userId: number, key: string): Promise<string | null> {
  try {
    const [row] = await db.select().from(userPrefs).where(and(eq(userPrefs.userId, userId), eq(userPrefs.key, key)));
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setPref(userId: number, key: string, value: string): Promise<void> {
  await db
    .insert(userPrefs)
    .values({ userId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [userPrefs.userId, userPrefs.key], set: { value, updatedAt: new Date() } });
}

export async function deletePref(userId: number, key: string): Promise<void> {
  await db.delete(userPrefs).where(and(eq(userPrefs.userId, userId), eq(userPrefs.key, key)));
}
