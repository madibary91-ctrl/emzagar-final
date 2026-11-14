import { type CheckDef, type Metric } from "../types";
import { fa, isProd } from "./util";
import { getConfig, trustedAppOrigin } from "@/lib/config";
import { getCronSecret } from "@/modules/automation/service";
import { probeUrl, tlsWarning } from "../probe";
import { simulatorUrl } from "@/lib/external";

/** فهرست متغیرهای محیطی برای ممیزی پیکربندی (فقط «تنظیم‌شده/نشده»؛ مقدار هرگز نمایش داده نمی‌شود) */
export const ENV_AUDIT_DEFS: { name: string; level: "required" | "recommended" | "optional" | "danger"; note: string }[] = [
  { name: "DATABASE_URL", level: "required", note: "آدرس دیتابیس (یا از نصب‌کننده)" },
  { name: "SESSION_SECRET", level: "required", note: "کلید امضای نشست و رمزنگاری (حداقل ۱۶ نویسه)" },
  { name: "APP_URL", level: "required", note: "آدرس عمومی HTTPS سایت؛ پایه‌ی لینک ایمیل و callback درگاه" },
  { name: "SMTP_HOST", level: "recommended", note: "ایمیل پلتفرم (تأیید ایمیل، بازیابی رمز، تیکت)" },
  { name: "CRON_SECRET", level: "recommended", note: "کلید فراخوانی /api/cron/run و پایش بیرونی" },
  { name: "PLATFORM_ADMIN_EMAILS", level: "recommended", note: "مدیران کل پلتفرم (دریافت هشدار سلامت)" },
  { name: "ZARINPAL_MERCHANT_ID", level: "recommended", note: "مرچنت زرین‌پال (یا هر درگاه دیگر از پنل)" },
  { name: "LICENSE_PUBLIC_KEY", level: "recommended", note: "کلید عمومی فروشنده برای راستی‌آزمایی پاسخ لایسنس" },
  { name: "PLATFORM_SMS_PROVIDER", level: "optional", note: "پنل پیامک مدیریت‌شده‌ی پلتفرم" },
  { name: "AI_API_KEY", level: "optional", note: "کلید پیش‌فرض هوش مصنوعی پلتفرم" },
  { name: "TRUSTED_PROXY_HOPS", level: "optional", note: "تعداد پراکسی مورد اعتماد (تشخیص IP)" },
  { name: "BACKUP_DIR", level: "optional", note: "مقصد بک‌آپ جدا از دیسک اصلی" },
  { name: "ALLOW_DEV_OTP", level: "danger", note: "نمایش کد OTP در پاسخ سرور — فقط توسعه" },
  { name: "ALLOW_DEMO_PAYMENTS", level: "danger", note: "پرداخت آزمایشی در production" },
  { name: "SEED_DEMO", level: "danger", note: "ساخت حساب‌های دمو" },
  { name: "SKIP_EMAIL_DOMAIN_CHECK", level: "danger", note: "غیرفعال‌کردن بررسی دامنه‌ی ایمیل" },
  { name: "EXTERNAL_SIM_URL", level: "danger", note: "هدایت پرداخت/پیامک/AI به شبیه‌ساز" },
];
export const config: CheckDef = {
  id: "config",
  group: "core",
  label: "پیکربندی و امنیت",
  weight: 3,
  fixHref: "/platform/health",
  async run() {
    const cfg = getConfig();
    const prod = isProd();
    const problems: string[] = [];
    const warns: string[] = [];
    const metrics: Metric[] = [];
    const hints: string[] = [];

    metrics.push({ label: "NODE_ENV", value: process.env.NODE_ENV || "—" });
    metrics.push({ label: "کلید امنیتی (SESSION_SECRET)", value: cfg.sessionSecret ? (cfg.secretFromEnv ? "تنظیم‌شده (محیط)" : "تنظیم‌شده (نصب‌کننده)") : "تنظیم نشده", tone: cfg.sessionSecret ? "ok" : prod ? "fail" : "warn" });
    if (!cfg.sessionSecret) (prod ? problems : warns).push("کلید امنیتی تنظیم نشده است");

    const app = trustedAppOrigin();
    metrics.push({ label: "APP_URL", value: app || "تنظیم نشده", tone: app ? (app.startsWith("https://") || !prod ? "ok" : "warn") : prod ? "warn" : "ok" });
    if (!app && prod) {
      warns.push("APP_URL تنظیم نیست (لینک ایمیل از هدر Host ساخته می‌شود)");
      hints.push("APP_URL را به آدرس HTTPS سایت مقدار دهید تا لینک‌های ایمیل و بازگشت درگاه امن و ثابت باشند.");
    } else if (app && prod && !app.startsWith("https://")) {
      warns.push("APP_URL در production باید HTTPS باشد");
    }

    const cron = await getCronSecret().catch(() => ({ secret: "", fromEnv: false }));
    metrics.push({ label: "کلید کرون/پایش", value: cron.secret ? (cron.fromEnv ? "محیط" : "ذخیره در پنل") : "ساخته نشده", tone: cron.secret ? "ok" : "warn" });

    const risky: [string, string][] = [
      ["ALLOW_DEV_OTP", "نمایش OTP در پاسخ سرور"],
      ["ALLOW_DEMO_PAYMENTS", "پرداخت آزمایشی"],
      ["SEED_DEMO", "داده‌ی دمو"],
      ["SKIP_EMAIL_DOMAIN_CHECK", "نبود بررسی دامنه‌ی ایمیل"],
    ];
    const riskyOn = risky.filter(([k]) => process.env[k] === "1");
    for (const [k, why] of risky) metrics.push({ label: k, value: process.env[k] === "1" ? "روشن" : "خاموش", tone: process.env[k] === "1" ? (prod ? "fail" : "warn") : "ok" });
    if (riskyOn.length) (prod ? problems : warns).push(`پرچم‌های توسعه روشن‌اند: ${riskyOn.map(([k]) => k).join("، ")}`);
    if (riskyOn.length && prod) hints.push("پرچم‌های ALLOW_DEV_OTP / ALLOW_DEMO_PAYMENTS / SEED_DEMO را در production خاموش کنید؛ هرکدام مستقیماً یک راه دور زدن امنیت یا پرداخت است.");

    if (prod && process.env.REQUIRE_EMAIL_VERIFICATION === "0") warns.push("تأیید ایمیل ثبت‌نام خاموش است");
    const sim = simulatorUrl();
    if (sim) {
      warns.push("شبیه‌ساز سرویس‌های بیرونی فعال است");
      metrics.push({ label: "شبیه‌ساز (EXTERNAL_SIM_URL)", value: `فعال: ${sim.origin}`, tone: prod ? "fail" : "warn" });
      if (prod) problems.push("شبیه‌ساز در production روشن است: پرداخت، پیامک و AI واقعی نیستند");
      hints.push("برای لانچ، EXTERNAL_SIM_URL را خالی بگذارید تا سرویس‌های واقعی فراخوانی شوند.");
    }
    if (prod && process.env.TRUSTED_PROXY_HOPS === undefined) warns.push("TRUSTED_PROXY_HOPS تنظیم نشده (پیش‌فرض ۱)");

    const status = problems.length ? "fail" : warns.length ? "warn" : "ok";
    return { status, summary: problems[0] ?? warns[0] ?? "پیکربندی امن و کامل است", metrics, hints, source: prod ? "production" : "توسعه" };
  },
};
export const publicUrl: CheckDef = {
  id: "public-url",
  group: "core",
  label: "آدرس عمومی سایت (APP_URL)",
  weight: 2,
  async run() {
    const app = trustedAppOrigin();
    if (!app) return { status: isProd() ? "fail" : "unconfigured", summary: "APP_URL تنظیم نشده است", hints: ["بدون آدرس عمومی، بازگشت از درگاه پرداخت و لینک‌های ایمیل درست کار نمی‌کنند."] };
    const p = await probeUrl(`${app}/api/health`, { timeoutMs: 8000 });
    const metrics: Metric[] = [{ label: "آدرس", value: app }];
    if (p.tlsDaysLeft !== undefined) metrics.push({ label: "گواهی TLS", value: `${fa(p.tlsDaysLeft)} روز تا انقضا (${p.tlsIssuer || "—"})`, tone: p.tlsDaysLeft < 0 ? "fail" : p.tlsDaysLeft <= 14 ? "warn" : "ok" });
    const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(app);
    if (local) metrics.push({ label: "هشدار", value: "آدرس محلی است؛ از اینترنت قابل دسترس نیست", tone: isProd() ? "warn" : "ok" });
    if (!p.ok) return { status: "fail", latencyMs: p.latencyMs, summary: p.error || "سایت از روی همین سرور با آدرس عمومی در دسترس نیست", steps: p.steps, metrics, hints: ["DNS دامنه، پراکسی معکوس (nginx) و گواهی TLS را بررسی کنید."] };
    const tw = tlsWarning(p);
    const httpsMissing = isProd() && !app.startsWith("https://");
    return {
      status: tw || httpsMissing || (local && isProd()) ? "warn" : "ok",
      latencyMs: p.latencyMs,
      summary: tw ?? (httpsMissing ? "آدرس عمومی HTTPS نیست" : local && isProd() ? "آدرس عمومی محلی است" : `در دسترس · ${fa(p.latencyMs)} میلی‌ثانیه`),
      steps: p.steps,
      metrics,
    };
  },
};
