import { cache } from "react";
import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser, type SessionUser } from "@/modules/auth/session";

/**
 * «مدیر کل پلتفرم» (Super Admin) با «مدیر فضای کاری» فرق دارد:
 *  - users.role = "admin"  ← مدیر کل (اولین کاربر ثبت‌نام‌شده روی دیتابیس خالی به‌طور خودکار مدیر کل می‌شود)
 *  - یا ایمیل‌های فهرست‌شده در متغیر محیطی PLATFORM_ADMIN_EMAILS (جداشده با ویرگول)
 * مدیر کل به تیکت‌های همه‌ی کاربران و آمار کل پلتفرم دسترسی دارد.
 */
const envAdmins = () =>
  (process.env.PLATFORM_ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isPlatformAdmin(user: Pick<SessionUser, "role" | "email"> | null | undefined): boolean {
  if (!user) return false;
  return user.role === "admin" || envAdmins().includes(user.email.toLowerCase());
}

const current = cache(getCurrentUser);

/** ورودی همه‌ی صفحه‌ها و اکشن‌های بخش مدیر کل؛ غیرمدیر به صفحه‌ی خودش برمی‌گردد */
export async function requirePlatformAdmin(): Promise<SessionUser> {
  const user = await current();
  if (!user) redirect("/login");
  if (!isPlatformAdmin(user)) redirect("/dashboard");
  return user;
}

export async function getPlatformAdminForApi(): Promise<SessionUser | null> {
  const user = await current();
  return isPlatformAdmin(user) ? user : null;
}

/** ایمیل مدیران کل (برای اعلان تیکت جدید) */
export async function platformAdminEmails(): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(users).where(eq(users.role, "admin"));
  return [...new Set([...rows.map((r) => r.email), ...envAdmins()])];
}

export async function countOtherAdmins(exceptId: number): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), ne(users.id, exceptId)));
  return rows.length;
}
