/**
 * M-06 — پرچم‌های توسعه/دمو که در صورت روشن‌ماندن در production «دور زدن کامل احراز هویت» یا «اشتراک رایگان» می‌شوند.
 *
 * پیش‌تر فقط یک `console.warn` می‌زدیم و اجرا ادامه می‌یافت (fail-open). اکنون:
 *  ۱) در production، این پرچم‌ها در «زمان اجرا» نادیده گرفته می‌شوند (هیچ مسیر کدی با `process.env.X === "1"` مستقیم تصمیم نمی‌گیرد؛
 *     همه از `devFlag()` می‌گذرند) — حتی اگر کسی عمداً فراموش کند و آن‌ها را روشن بگذارد، هیچ OTP/لینک بازیابی در پاسخ HTTP نمی‌آید؛
 *  ۲) در راه‌اندازی (`assertSafeDevFlags` در instrumentation) برنامه در production با این پرچم‌ها «بالا نمی‌آید» تا خطا فوراً دیده شود؛
 *  ۳) تنها استثنا «محیط آزمایشی قفل‌شده» است: همان انصراف صریح `INSTALL_OPEN=1` (CR-03، اسکریپت‌های e2e/qa) و فقط وقتی
 *     آدرس سایت (APP_URL) loopback باشد (localhost / 127.0.0.1 / ::1). یک سرور عمومی هرگز این شرایط را ندارد.
 */
export type DevFlag = "ALLOW_DEV_OTP" | "ALLOW_DEMO_PAYMENTS" | "SEED_DEMO";
/** پرچم‌هایی که روشن‌بودنشان در production مجاز نیست و راه‌اندازی را متوقف می‌کند */
export const FATAL_IN_PRODUCTION: DevFlag[] = ["ALLOW_DEV_OTP", "ALLOW_DEMO_PAYMENTS", "SEED_DEMO"];

const isLoopbackHost = (h: string) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(h.toLowerCase());

/** آیا در «محیط آزمایشی قفل‌شده‌ی loopback» هستیم؟ (فقط برای e2e/qa؛ هرگز یک استقرار واقعی) */
export function isLockedTestHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.INSTALL_OPEN !== "1") return false;
  try {
    return isLoopbackHost(new URL(String(env.APP_URL || "")).hostname);
  } catch {
    return false;
  }
}

export function devFlag(name: DevFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return env[name] === "1";
  return env[name] === "1" && isLockedTestHarness(env);
}

/** «نمایش رازهای توسعه (OTP، لینک بازیابی، کد تأیید) در پاسخ»: همیشه در توسعه/آزمون؛ در production هرگز (مگر محیط آزمایشی قفل‌شده) */
export const devSecretsVisible = (env: NodeJS.ProcessEnv = process.env): boolean => env.NODE_ENV !== "production" || devFlag("ALLOW_DEV_OTP", env);

export class UnsafeDevFlagError extends Error {
  constructor(public flags: DevFlag[]) {
    super(`پرچم‌های توسعه در production روشن‌اند و برنامه عمداً بالا نمی‌آید: ${flags.join("، ")}. این پرچم‌ها OTP/لینک بازیابی را در پاسخ نشان می‌دهند یا پرداخت/حساب دمو را فعال می‌کنند. آن‌ها را از محیط سرور حذف کنید (یا برابر 0 بگذارید).`);
    this.name = "UnsafeDevFlagError";
  }
}

/** در راه‌اندازی production فراخوانی می‌شود؛ پرچم خطرناک روشن ⇒ throw (fail-closed) */
export function assertSafeDevFlags(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production" || isLockedTestHarness(env)) return;
  const on = FATAL_IN_PRODUCTION.filter((f) => env[f] === "1");
  if (on.length) throw new UnsafeDevFlagError(on);
}
