import { parseIranMobile } from "@/lib/phone";
import { EMAIL_RE, createWorkspace } from "@/modules/tenancy/service";
import { db, getPool, withTransaction } from "@/db";
import { ensureLandingDefaults } from "@/modules/landing/service";
import { hashPasswordAsync } from "@/lib/password";
import { saveSettings } from "@/modules/settings/service";
import { sql } from "drizzle-orm";
import { users } from "@/db/schema";

/* ───────── حساب مدیر ───────── */
export type AccountInput = { siteName: string; name: string; email: string; mobile: string; password: string };
export function passwordProblem(p: string): string | null {
  if (p.length < 8) return "رمز عبور باید حداقل ۸ نویسه باشد.";
  if (!/[A-Za-z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) return "رمز عبور باید ترکیبی از حروف و عدد باشد.";
  return null;
}
/** حداکثر طول فیلدها: ورودی بی‌سقف (مثلاً رمز چند مگابایتی) هش‌کردن را به DoS تبدیل می‌کند و ستون‌ها را می‌شکند */
export const ACCOUNT_LIMITS = { siteName: 100, name: 100, email: 254, mobile: 40, password: 200 } as const;
export function validateAccount(a: AccountInput): string | null {
  // L8: ورودی Server Action ساخته‌ی کلاینت است؛ نوع نادرست باید پیام فارسی بدهد نه TypeError (۵۰۰)
  const x = a as unknown as Record<string, unknown> | null;
  if (!x || typeof x !== "object" || !(Object.keys(ACCOUNT_LIMITS) as (keyof AccountInput)[]).every((k) => typeof x[k] === "string")) return "اطلاعات حساب مدیر نامعتبر است.";
  if (!a.siteName.trim()) return "نام سایت یا کسب‌وکار را وارد کنید.";
  if (!a.name.trim()) return "نام و نام‌خانوادگی را وارد کنید.";
  for (const k of Object.keys(ACCOUNT_LIMITS) as (keyof typeof ACCOUNT_LIMITS)[]) if (a[k].length > ACCOUNT_LIMITS[k]) return "یکی از فیلدها بیش از حد بلند است.";
  if (!EMAIL_RE.test(a.email.trim())) return "ایمیل معتبر نیست.";
  if (!parseIranMobile(a.mobile)) return "موبایل باید مثل 09123456789 باشد (ارقام فارسی هم پذیرفته می‌شود).";
  return passwordProblem(a.password);
}
/**
 * ساخت مدیر کل + فضای کاری اصلی + تنظیمات و صفحه‌ی فرود پیش‌فرض؛ با قفل دیتابیس، فقط یک نصب هم‌زمان می‌تواند موفق شود.
 *
 * اتمی: همه‌ی مراحل در «یک» تراکنش‌اند. اگر هر مرحله (مثلاً ساخت فضای کاری) خطا بدهد، مدیر هم ساخته نمی‌شود؛
 * در نتیجه سامانه هرگز در حالت «مدیر بدون فضای کاری» که نصب را برای همیشه قفل می‌کند (چون کاربر وجود دارد) نمی‌ماند
 * و کاربر می‌تواند نصب را دوباره امتحان کند. قفل مشاوره‌ای تا بعد از commit نگه داشته می‌شود.
 */
export async function createFirstAdmin(a: AccountInput): Promise<{ userId: number; passwordHash: string; workspaceId: number } | null> {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(727002)");
    const passwordHash = await hashPasswordAsync(a.password);
    return await withTransaction(async () => {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
      if (n > 0) return null;
      const [user] = await db
        .insert(users)
        .values({ name: a.name.trim().slice(0, 100), email: a.email.trim().toLowerCase(), mobile: parseIranMobile(a.mobile) ?? a.mobile.trim(), passwordHash, role: "admin", emailVerifiedAt: new Date() })
        .returning();
      const workspaceId = await createWorkspace(user.id, a.siteName.trim());
      await saveSettings({ site_name: a.siteName.trim().slice(0, 40), admin_email: user.email }, workspaceId);
      await ensureLandingDefaults(a.siteName.trim());
      return { userId: user.id, passwordHash, workspaceId };
    });
  } finally {
    await client.query("select pg_advisory_unlock(727002)").catch(() => undefined);
    client.release();
  }
}
