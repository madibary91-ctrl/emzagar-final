"use server";

import { getConfig } from "@/lib/config";
import { rateLimit } from "@/lib/rate-limit";
import { getBootstrapOrigin, getRequestInfo } from "@/lib/request";
import { createSession } from "@/modules/auth/session";
import { setActiveWorkspaceCookie } from "@/modules/tenancy/context";
import {
  applySchema,
  buildDatabaseUrl,
  createFirstAdmin,
  describeDbError,
  finalizeInstall,
  getInstallState,
  isInstalled,
  keyAttemptsLocked,
  keyMatches,
  persistConfig,
  recordKeyFailure,
  testDatabase,
  validateAccount,
  type AccountInput,
  type DbInput,
} from "./service";

export type StepResult = { ok: boolean; error?: string; note?: string };

/**
 * هر مرحله باید از این نگهبان بگذرد (CR-03):
 *  ۱. سامانه نصب‌شده نباشد؛ و اگر وضعیت دیتابیس «قابل‌خواندن نیست» (قطعی موقت)، نصب بسته می‌ماند (fail-closed)
 *     تا با قطع دیتابیس نتوان آدرس دیتابیس را بازنویسی یا مدیر جدید ساخت.
 *  ۲. نرخ درخواست از یک IP محدود باشد.
 *  ۳. کلید نصب (INSTALL_KEY یا کلید تصادفی storage/install-key.txt) درست باشد؛ تلاش‌های ناموفق به‌صورت سراسری شمرده می‌شود.
 */
async function guard(installKey: string | undefined): Promise<string | null> {
  const state = await getInstallState();
  if (state === "installed") return "سامانه قبلاً نصب شده است. برای ورود به بخش مدیریت به صفحه‌ی ورود بروید.";
  if (state === "unknown") {
    return "اتصال به دیتابیس پیکربندی‌شده برقرار نیست و وضعیت نصب قابل تأیید نیست؛ برای امنیت، نصب‌کننده بسته است. دیتابیس را راه‌اندازی کنید و دوباره امتحان کنید (برای شروع از صفر، فایل storage/config.json را از روی سرور حذف کنید).";
  }
  const { ip } = await getRequestInfo();
  if (!rateLimit(`install:${ip}`, 60, 15 * 60_000).ok) return "تعداد تلاش‌ها زیاد بود. چند دقیقه بعد دوباره امتحان کنید.";
  if (keyAttemptsLocked()) return "به‌دلیل تلاش‌های ناموفق زیاد، نصب‌کننده برای ۱۵ دقیقه قفل شد.";
  if (!keyMatches(installKey)) {
    recordKeyFailure();
    return "کلید نصب نادرست است. کلید را در فایل storage/install-key.txt روی سرور (یا لاگ سرور، یا مقدار INSTALL_KEY) پیدا کنید.";
  }
  return null;
}

/** مرحله ۱: آزمودن اتصال دیتابیس (بدون ذخیره) */
export async function testDatabaseAction(input: DbInput, installKey?: string): Promise<StepResult> {
  const blocked = await guard(installKey);
  if (blocked) return { ok: false, error: blocked };
  if (getConfig().databaseFromEnv) return { ok: true, note: "دیتابیس از قبل توسط سرور متصل شده است." };
  const built = buildDatabaseUrl(input);
  if (!built.url) return { ok: false, error: built.error };
  const res = await testDatabase(built.url);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, note: res.created ? "اتصال موفق بود و دیتابیس جدید به‌صورت خودکار ساخته شد." : "اتصال به دیتابیس موفق بود." };
}

/** مرحله ۲: ذخیره‌ی پیکربندی + تولید کلید امنیتی + ساخت جدول‌ها */
export async function installDatabaseAction(input: DbInput, installKey?: string): Promise<StepResult> {
  const blocked = await guard(installKey);
  if (blocked) return { ok: false, error: blocked };
  try {
    if (!getConfig().databaseFromEnv) {
      const built = buildDatabaseUrl(input);
      if (!built.url) return { ok: false, error: built.error };
      const res = await testDatabase(built.url);
      if (!res.ok) return { ok: false, error: res.error };
      persistConfig({ databaseUrl: built.url, appUrl: await getBootstrapOrigin() });
    } else {
      persistConfig({ appUrl: await getBootstrapOrigin() });
    }
  } catch {
    return { ok: false, error: "نوشتن فایل پیکربندی ممکن نشد. اجازه‌ی نوشتن (Write) روی پوشه‌ی storage را از پنل هاست بدهید." };
  }
  try {
    await applySchema();
  } catch (e) {
    return { ok: false, error: describeDbError(e) };
  }
  return { ok: true };
}

/** مرحله ۳: ساخت مدیر کل، فضای کاری، قالب‌های نمونه و ورود خودکار */
export async function installAccountAction(input: AccountInput, installKey?: string): Promise<StepResult> {
  const blocked = await guard(installKey);
  if (blocked) return { ok: false, error: blocked };
  const problem = validateAccount(input);
  if (problem) return { ok: false, error: problem };
  try {
    const created = await createFirstAdmin(input);
    if (!created) return { ok: false, error: "سامانه قبلاً نصب شده است." };
    await createSession(created.userId, created.passwordHash);
    await setActiveWorkspaceCookie(created.workspaceId);
  } catch (e) {
    return { ok: false, error: `ساخت حساب مدیر ناموفق بود (${describeDbError(e)})` };
  }
  return { ok: true };
}

/** مرحله ۴: قفل‌کردن نصب‌کننده */
export async function installFinishAction(): Promise<StepResult> {
  // فقط وقتی مجاز است که واقعاً مدیری ساخته شده (isInstalled از روی دیتابیس تصمیم می‌گیرد)
  if (!(await isInstalled())) return { ok: false, error: "نصب هنوز کامل نشده است." };
  try {
    finalizeInstall();
  } catch {
    /* قفل‌نشدن مانع کار نیست؛ وجود کاربر هم نصب را قفل می‌کند */
  }
  return { ok: true };
}
