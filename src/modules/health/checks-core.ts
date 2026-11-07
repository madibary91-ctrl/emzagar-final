import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { db, getPool } from "@/db";
import { STORAGE_DIR, getConfig, trustedAppOrigin } from "@/lib/config";
import { simulatorUrl } from "@/lib/external";
import { kycDir } from "@/lib/storage-paths";
import { APP_VERSION } from "@/lib/version";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";
import { getCronSecret } from "@/modules/automation/service";
import { backupOverview, verifyLatestBackup } from "@/modules/backup/service";
import { getAllSettings } from "@/modules/settings/service";
import { platformSms } from "@/modules/sms";
import { extTimeout, externalBase } from "@/lib/external";
import { explainNetError, probeSocket, probeUrl, tlsWarning } from "./probe";
import type { CheckDef, CheckOutput, Metric, Step } from "./types";

export const fa = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const fmtBytes = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} گیگابایت` : `${Math.round(b / (1 << 20))} مگابایت`);
export const ageText = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "چند ثانیه";
  if (m < 60) return `${fa(m)} دقیقه`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${fa(h)} ساعت`;
  return `${fa(Math.floor(h / 24))} روز`;
};
export const isProd = () => process.env.NODE_ENV === "production";

/** مسیر نوشتنی بودن پوشه: یک فایل موقت می‌نویسد و پاک می‌کند */
async function writable(dir: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, `.health-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(f, "ok");
    await fs.unlink(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "خطا" };
  }
}

/** نام جدول‌های مورد انتظار از SQL نصب‌کننده */
const expectedTables = () => SCHEMA_CREATE.map((s) => /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(s)?.[1]).filter((x): x is string => !!x);

const loopLag = async (): Promise<number> => {
  const t0 = performance.now();
  await new Promise<void>((r) => setImmediate(r));
  return Math.round((performance.now() - t0) * 10) / 10;
};

/* ───────────────────────── زیرساخت ───────────────────────── */

const database: CheckDef = {
  id: "database",
  group: "core",
  label: "دیتابیس PostgreSQL",
  weight: 3,
  deepAvailable: true,
  deepLabel: "تست نوشتن/خواندن",
  fixHref: "/platform/health",
  async run(_ctx, deep) {
    const url = getConfig().databaseUrl;
    if (!url) return { status: "unconfigured", summary: "آدرس دیتابیس تنظیم نشده است", hints: ["نصب‌کننده‌ی وب (/install) را کامل کنید یا DATABASE_URL را مقدار دهید."] };
    let where = "";
    try {
      const u = new URL(url);
      where = `${u.hostname}:${u.port || 5432}${u.pathname}`;
    } catch {
      where = "نامعتبر";
    }
    const steps: Step[] = [];
    const t0 = performance.now();
    await db.execute(sql`select 1`);
    const latency = Math.round(performance.now() - t0);
    steps.push({ name: "اتصال", ok: true, ms: latency, detail: where });

    const info = await db.execute(sql`select current_setting('server_version') as v, pg_database_size(current_database())::bigint as size,
      (select count(*)::int from pg_stat_activity where datname = current_database()) as conns,
      current_setting('max_connections')::int as maxc`);
    const row = info.rows[0] as { v: string; size: string; conns: number; maxc: number };
    const have = new Set(((await db.execute(sql`select table_name from information_schema.tables where table_schema = current_schema()`)).rows as { table_name: string }[]).map((r) => r.table_name));
    const missing = expectedTables().filter((t) => !have.has(t));
    steps.push({ name: "ساختار جدول‌ها", ok: missing.length === 0, detail: missing.length ? `${fa(missing.length)} جدول ناموجود: ${missing.slice(0, 5).join("، ")}` : `${fa(have.size)} جدول موجود` });

    const pool = getPool();
    const usage = row.maxc ? row.conns / row.maxc : 0;
    const metrics: Metric[] = [
      { label: "نسخه‌ی PostgreSQL", value: row.v },
      { label: "حجم دیتابیس", value: fmtBytes(Number(row.size)) },
      { label: "اتصال‌های فعال", value: `${fa(row.conns)} از ${fa(row.maxc)}`, tone: usage > 0.85 ? "fail" : usage > 0.7 ? "warn" : "ok" },
      { label: "استخر اتصال برنامه", value: `${fa(pool.totalCount)} کل · ${fa(pool.idleCount)} آزاد · ${fa(pool.waitingCount)} منتظر`, tone: pool.waitingCount > 3 ? "warn" : "ok" },
      { label: "تأخیر پرس‌وجو", value: `${fa(latency)} میلی‌ثانیه`, tone: latency > 500 ? "fail" : latency > 150 ? "warn" : "ok" },
      { label: "مبدأ پیکربندی", value: getConfig().databaseFromEnv ? "متغیر محیطی" : "فایل نصب‌کننده" },
    ];
    let writeNote = "";
    if (deep) {
      // آزمون نوشتن: درج + خواندن داخل تراکنشی که حتماً برگردانده می‌شود (هیچ ردی نمی‌ماند)
      const c = await pool.connect();
      const w0 = performance.now();
      try {
        await c.query("BEGIN");
        const ins = await c.query("insert into health_checks (check_id, status, message) values ('__probe__','ok','write-test') returning id");
        const back = await c.query("select count(*)::int as n from health_checks where id = $1", [ins.rows[0].id]);
        steps.push({ name: "نوشتن/خواندن", ok: back.rows[0].n === 1, ms: Math.round(performance.now() - w0), detail: "درج و بازخوانی موفق (تراکنش برگردانده شد)" });
        writeNote = " · نوشتن/خواندن تأیید شد";
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
    }
    const status = missing.length > 0 ? "fail" : usage > 0.85 || latency > 500 ? "warn" : latency > 150 || usage > 0.7 ? "warn" : "ok";
    return {
      status,
      latencyMs: latency,
      summary: missing.length ? `${fa(missing.length)} جدول ناموجود است (ساختار ناقص)` : `متصل · ${fa(latency)} میلی‌ثانیه${writeNote}`,
      metrics,
      steps,
      hints: missing.length ? ["برنامه را ری‌استارت کنید تا ساختار خودکار ارتقا یابد، یا از نصب‌کننده/‌drizzle-kit push استفاده کنید."] : [],
    };
  },
};

const runtime: CheckDef = {
  id: "runtime",
  group: "core",
  label: "سرور و پردازه‌ی Node.js",
  weight: 1,
  async run() {
    const mem = process.memoryUsage();
    const lag = await loopLag();
    const total = os.totalmem();
    const freePct = Math.round((os.freemem() / total) * 100);
    const load = os.loadavg()[0];
    const cpus = os.cpus().length || 1;
    const metrics: Metric[] = [
      { label: "نسخه‌ی Node.js", value: process.version },
      { label: "نسخه‌ی برنامه", value: APP_VERSION },
      { label: "زمان کارکرد", value: ageText(process.uptime() * 1000) },
      { label: "حافظه‌ی پردازه (RSS)", value: fmtBytes(mem.rss), tone: mem.rss > 1.5 * (1 << 30) ? "warn" : "ok" },
      { label: "Heap مصرفی", value: `${fmtBytes(mem.heapUsed)} از ${fmtBytes(mem.heapTotal)}` },
      { label: "حافظه‌ی آزاد سیستم", value: `${fa(freePct)}٪`, tone: freePct < 5 ? "fail" : freePct < 12 ? "warn" : "ok" },
      { label: "بار CPU (۱ دقیقه)", value: `${load.toFixed(2)} روی ${fa(cpus)} هسته`, tone: load > cpus * 1.5 ? "warn" : "ok" },
      { label: "تأخیر حلقه‌ی رویداد", value: `${lag} میلی‌ثانیه`, tone: lag > 200 ? "warn" : "ok" },
    ];
    const bad = freePct < 5 ? "حافظه‌ی آزاد سیستم رو به اتمام است" : "";
    const warn = freePct < 12 || load > cpus * 1.5 || lag > 200 || mem.rss > 1.5 * (1 << 30);
    return { status: bad ? "fail" : warn ? "warn" : "ok", summary: bad || (warn ? "فشار منابع سرور بالاست" : `Node ${process.version} · ${ageText(process.uptime() * 1000)} کارکرد`), metrics, latencyMs: lag };
  },
};

const storage: CheckDef = {
  id: "storage",
  group: "core",
  label: "ذخیره‌سازی و فضای دیسک",
  weight: 2,
  async run() {
    const dirs: [string, string][] = [
      ["storage (امضا و PDF)", STORAGE_DIR],
      ["مدارک KYC", kycDir()],
    ];
    const steps: Step[] = [];
    let anyBad = false;
    for (const [label, dir] of dirs) {
      const t0 = performance.now();
      const w = await writable(dir);
      steps.push({ name: label, ok: w.ok, ms: Math.round(performance.now() - t0), detail: w.ok ? "قابل نوشتن" : w.error });
      if (!w.ok) anyBad = true;
    }
    const metrics: Metric[] = [{ label: "مسیر ذخیره‌سازی", value: STORAGE_DIR }];
    let status: CheckOutput["status"] = anyBad ? "fail" : "ok";
    let summary = anyBad ? "پوشه‌ی ذخیره‌سازی قابل نوشتن نیست" : "پوشه‌ها قابل نوشتن‌اند";
    try {
      const st = await fs.statfs(STORAGE_DIR);
      const free = st.bavail * st.bsize;
      const totalB = st.blocks * st.bsize;
      const pct = totalB ? Math.round((free / totalB) * 100) : 100;
      metrics.push({ label: "فضای آزاد دیسک", value: `${fmtBytes(free)} (${fa(pct)}٪)`, tone: free < 200 * (1 << 20) ? "fail" : pct < 10 || free < (1 << 30) ? "warn" : "ok" });
      if (!anyBad) {
        if (free < 200 * (1 << 20)) {
          status = "fail";
          summary = `فضای دیسک رو به اتمام است (${fmtBytes(free)})`;
        } else if (pct < 10 || free < 1 << 30) {
          status = "warn";
          summary = `فضای آزاد دیسک کم است (${fmtBytes(free)})`;
        } else summary = `${fmtBytes(free)} فضای آزاد · پوشه‌ها قابل نوشتن`;
      }
    } catch {
      metrics.push({ label: "فضای آزاد دیسک", value: "قابل خواندن نیست" });
    }
    return { status, summary, metrics, steps, hints: anyBad ? ["مجوز نوشتن کاربر سرویس روی پوشه‌ی storage را بررسی کنید یا STORAGE_DIR را به مسیر نوشتنی تغییر دهید."] : [] };
  },
};

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

const config: CheckDef = {
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

const publicUrl: CheckDef = {
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

const scheduler: CheckDef = {
  id: "scheduler",
  group: "core",
  label: "زمان‌بند و کرون",
  weight: 2,
  fixHref: "/admin/automation",
  fixLabel: "یادآوری و انقضا",
  async run() {
    const g = globalThis as typeof globalThis & { __amzScheduler?: NodeJS.Timeout };
    const interval = Math.max(1, Number(process.env.CRON_INTERVAL_MINUTES) || 10);
    const last = (await db.execute(sql`select trigger, error, created_at from cron_runs order by id desc limit 1`)).rows[0] as { trigger: string; error: string | null; created_at: Date } | undefined;
    const running = !!g.__amzScheduler;
    const metrics: Metric[] = [
      { label: "زمان‌بند داخلی", value: running ? `فعال (هر ${fa(interval)} دقیقه)` : "غیرفعال", tone: running ? "ok" : "warn" },
    ];
    if (last) {
      const age = Date.now() - new Date(last.created_at).getTime();
      metrics.push({ label: "آخرین اجرا", value: `${ageText(age)} پیش (${last.trigger})`, tone: age > interval * 60_000 * 4 ? "warn" : "ok" });
      if (last.error) metrics.push({ label: "خطای آخرین اجرا", value: last.error.slice(0, 120), tone: "fail" });
    } else metrics.push({ label: "آخرین اجرا", value: "هنوز اجرا نشده" });
    const age = last ? Date.now() - new Date(last.created_at).getTime() : Infinity;
    const stale = age > Math.max(interval * 60_000 * 4, 3600_000);
    if (last?.error) return { status: "warn", summary: "آخرین اجرای زمان‌بند خطا داشت", metrics, hints: ["لاگ سرور را برای جزئیات بررسی کنید."] };
    if (!running && stale) return { status: "fail", summary: "زمان‌بند فعال نیست و اجرای اخیری ثبت نشده", metrics, hints: ["اگر هاست پردازه‌ی دائمی ندارد، /api/cron/run را با کرون هاست (با CRON_SECRET) فراخوانی کنید."] };
    if (stale && last) return { status: "warn", summary: `${ageText(age)} است اجرایی ثبت نشده`, metrics };
    return { status: running || last ? "ok" : "warn", summary: last ? `آخرین اجرا ${ageText(age)} پیش` : "زمان‌بند فعال؛ هنوز اجرایی ثبت نشده", metrics };
  },
};

const backup: CheckDef = {
  id: "backup",
  group: "core",
  label: "بک‌آپ خودکار",
  weight: 2,
  deepAvailable: true,
  deepLabel: "راستی‌آزمایی آخرین بک‌آپ",
  fixHref: "/platform",
  async run(_ctx, deep) {
    const ov = await backupOverview();
    const metrics: Metric[] = [
      { label: "بک‌آپ خودکار", value: ov.cfg.enabled ? `روشن (هر ${fa(ov.cfg.intervalHours)} ساعت، نگهداری ${fa(ov.cfg.keep)} نسخه)` : "خاموش", tone: ov.cfg.enabled ? "ok" : "warn" },
      { label: "مقصد", value: ov.cfg.dir },
      { label: "تعداد نسخه‌ها", value: fa(ov.list.length) },
    ];
    const steps: Step[] = [];
    if (deep) {
      const t0 = performance.now();
      const v = await verifyLatestBackup();
      steps.push({ name: "راستی‌آزمایی", ok: !!v && (v as { ok?: boolean }).ok !== false, ms: Math.round(performance.now() - t0), detail: v ? `${v.name}: ${JSON.stringify(v).slice(0, 120)}` : "بک‌آپی برای بررسی نیست" });
    }
    if (!ov.cfg.enabled) return { status: "warn", summary: "بک‌آپ خودکار خاموش است", metrics, steps, hints: ["BACKUP_ENABLED=0 را بردارید؛ پیش از لانچ بک‌آپ منظم ضروری است."] };
    const lastOk = ov.list.find((b) => b.ok);
    if (!lastOk && !ov.last) return { status: "warn", summary: "هنوز بک‌آپی گرفته نشده", metrics, steps, hints: ["اولین بک‌آپ طی ۴۵ ثانیه تا چند دقیقه پس از بالا آمدن سرور گرفته می‌شود."] };
    if (ov.last && !ov.last.ok) return { status: "fail", summary: `آخرین بک‌آپ ناموفق بود: ${(ov.last.error || "").slice(0, 100)}`, metrics, steps };
    const at = new Date(ov.last?.at ?? 0).getTime() || (lastOk ? new Date(lastOk.createdAt).getTime() : 0);
    if (at) {
      const age = Date.now() - at;
      metrics.push({ label: "آخرین بک‌آپ موفق", value: `${ageText(age)} پیش`, tone: age > ov.cfg.intervalHours * 3600_000 * 2.5 ? "warn" : "ok" });
      if (age > ov.cfg.intervalHours * 3600_000 * 2.5) return { status: "warn", summary: `آخرین بک‌آپ ${ageText(age)} پیش بوده`, metrics, steps };
      return { status: "ok", summary: `آخرین بک‌آپ ${ageText(age)} پیش`, metrics, steps };
    }
    return { status: "ok", summary: "بک‌آپ‌ها موجودند", metrics, steps };
  },
};

/* ───────────────────────── ایمیل و پیامک ───────────────────────── */

type SmtpCfg = { host: string; port: number; user: string; pass: string; from: string; source: string };

/** همان منطق sendMail: SMTP فضای کاری، وگرنه SMTP پلتفرم (محیط) */
export async function effectiveSmtp(workspaceId: number): Promise<SmtpCfg | null> {
  const s = await getAllSettings(workspaceId);
  if (workspaceId && s.smtp_host) return { host: s.smtp_host, port: Number(s.smtp_port) || 587, user: s.smtp_user, pass: s.smtp_pass, from: s.smtp_from || s.smtp_user || s.admin_email, source: "فضای کاری" };
  if (process.env.SMTP_HOST) return { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587, user: process.env.SMTP_USER || "", pass: process.env.SMTP_PASS || "", from: process.env.SMTP_FROM || process.env.SMTP_USER || "", source: "پلتفرم (محیط)" };
  return null;
}

const email: CheckDef = {
  id: "email",
  group: "comms",
  label: "ایمیل (SMTP)",
  weight: 3,
  fixHref: "/admin/settings",
  fixLabel: "تنظیمات ایمیل",
  async run(ctx) {
    const cfg = await effectiveSmtp(ctx.workspaceId);
    if (!cfg) {
      const must = process.env.REQUIRE_EMAIL_VERIFICATION !== "0";
      return {
        status: must && isProd() ? "fail" : "unconfigured",
        summary: "SMTP تنظیم نشده؛ ایمیل‌ها فقط در صندوق ارتباطات ثبت می‌شوند",
        hints: [must ? "تأیید ایمیل هنگام ثبت‌نام اجباری است؛ بدون SMTP کاربران نمی‌توانند حساب را فعال کنند." : "برای ارسال لینک امضا و بازیابی رمز، SMTP را تنظیم کنید.", "تنظیم: «تنظیمات ← ایمیل» یا متغیرهای SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS."],
      };
    }
    const secure = cfg.port === 465;
    const sock = await probeSocket(cfg.host, cfg.port, { secure, readBanner: !secure, timeoutMs: 8000 });
    const metrics: Metric[] = [
      { label: "میزبان", value: `${cfg.host}:${cfg.port}` },
      { label: "رمزنگاری", value: secure ? "TLS مستقیم (465)" : cfg.port === 587 ? "STARTTLS (587)" : "پورت غیراستاندارد" },
      { label: "فرستنده", value: cfg.from || "—" },
      { label: "احراز هویت", value: cfg.user ? `کاربر ${cfg.user}` : "بدون احراز هویت", tone: cfg.user ? "ok" : "warn" },
    ];
    if (!sock.ok) return { status: "fail", latencyMs: sock.latencyMs, summary: sock.error || "اتصال به سرور SMTP برقرار نشد", steps: sock.steps, metrics, source: cfg.source, hints: ["میزبان/پورت را بررسی کنید؛ بسیاری از هاست‌ها پورت 25 و گاهی 587 را مسدود می‌کنند.", "برای پورت 465 رمزنگاری مستقیم و برای 587 STARTTLS لازم است."] };
    // احراز هویت کامل (بدون ارسال ایمیل)
    const t0 = performance.now();
    const steps = [...sock.steps];
    try {
      const tr = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
      await tr.verify();
      tr.close();
      steps.push({ name: "احراز هویت SMTP", ok: true, ms: Math.round(performance.now() - t0), detail: "ورود موفق (ایمیلی ارسال نشد)" });
    } catch (e) {
      const m = e instanceof Error ? e.message : "خطا";
      const authFail = /auth|535|credentials|username|password/i.test(m);
      steps.push({ name: "احراز هویت SMTP", ok: false, ms: Math.round(performance.now() - t0), detail: m.slice(0, 160) });
      return { status: "fail", latencyMs: sock.latencyMs + Math.round(performance.now() - t0), summary: authFail ? "نام کاربری یا رمز SMTP پذیرفته نشد" : `SMTP پاسخ نامعتبر داد: ${m.slice(0, 80)}`, steps, metrics, source: cfg.source, hints: authFail ? ["رمز برنامه‌ای (App Password) سرویس ایمیل را بررسی کنید."] : [] };
    }
    const total = sock.latencyMs + Math.round(performance.now() - t0);
    const tls0 = tlsWarning(sock);
    return { status: tls0 || total > 6000 ? "warn" : "ok", latencyMs: total, summary: tls0 ?? `ورود موفق · ${fa(total)} میلی‌ثانیه`, steps, metrics, source: cfg.source, hints: ["برای اطمینان از رسیدن ایمیل به صندوق ورودی، از ابزار «ارسال ایمیل آزمایشی» استفاده کنید."] };
  },
};

type SmsInfo = { id: "log" | "kavenegar" | "melipayamak"; source: string; key?: string; user?: string; pass?: string };

async function effectiveSms(workspaceId: number): Promise<SmsInfo> {
  const s = await getAllSettings(workspaceId);
  if (s.sms_provider === "kavenegar" && s.kavenegar_api_key) return { id: "kavenegar", source: "فضای کاری", key: s.kavenegar_api_key };
  if (s.sms_provider === "melipayamak" && s.melipayamak_username) return { id: "melipayamak", source: "فضای کاری", user: s.melipayamak_username, pass: s.melipayamak_password };
  const p = platformSms();
  if (p?.provider.id === "kavenegar") return { id: "kavenegar", source: "پلتفرم (مدیریت‌شده)", key: p.cfg.kavenegar_api_key };
  if (p?.provider.id === "melipayamak") return { id: "melipayamak", source: "پلتفرم (مدیریت‌شده)", user: p.cfg.melipayamak_username, pass: p.cfg.melipayamak_password };
  return { id: "log", source: "حالت آزمایشی" };
}

const sms: CheckDef = {
  id: "sms",
  group: "comms",
  label: "پیامک (OTP و لینک امضا)",
  weight: 2,
  fixHref: "/admin/settings",
  fixLabel: "تنظیمات پیامک",
  async run(ctx) {
    const info = await effectiveSms(ctx.workspaceId);
    if (info.id === "log") {
      return {
        status: isProd() ? "warn" : "unconfigured",
        source: info.source,
        summary: "پنل پیامک تنظیم نشده؛ پیامک‌ها فقط در لاگ ثبت می‌شوند",
        hints: ["کد تأیید امضا (OTP) از طریق پیامک واقعی نمی‌رسد؛ در «تنظیمات ← پیامک» کاوه‌نگار یا ملی‌پیامک را وصل کنید.", "یا PLATFORM_SMS_PROVIDER را برای پنل مدیریت‌شده‌ی پلتفرم تنظیم کنید."],
      };
    }
    const label = info.id === "kavenegar" ? "کاوه‌نگار" : "ملی‌پیامک";
    const base = info.id === "kavenegar" ? externalBase("kavenegar", "https://api.kavenegar.com") : externalBase("melipayamak", "https://rest.payamak-panel.com");
    const t0 = performance.now();
    const steps: Step[] = [];
    const metrics: Metric[] = [{ label: "سرویس", value: label }];
    try {
      let credit: number | null = null;
      if (info.id === "kavenegar") {
        const res = await fetch(`${base}/v1/${encodeURIComponent(info.key || "")}/account/info.json`, { signal: AbortSignal.timeout(extTimeout(10_000)), redirect: "error" });
        const j = (await res.json().catch(() => null)) as { return?: { status?: number; message?: string }; entries?: { remaincredit?: number; expiredate?: number; type?: string } } | null;
        const st = j?.return?.status;
        if (st !== 200) {
          const msg = st === 403 ? "کلید API کاوه‌نگار نامعتبر است" : st === 416 ? "IP سرور در فهرست مجاز کاوه‌نگار نیست" : st === 401 ? "حساب کاوه‌نگار غیرفعال است" : res.status >= 500 ? `پنل کاوه‌نگار در دسترس نیست (HTTP ${res.status})` : `پاسخ ناموفق (کد ${st ?? res.status})`;
          steps.push({ name: "account/info", ok: false, ms: Math.round(performance.now() - t0), detail: msg });
          return { status: "fail", latencyMs: Math.round(performance.now() - t0), summary: msg, steps, metrics, source: info.source };
        }
        credit = Number(j?.entries?.remaincredit ?? NaN);
        if (j?.entries?.type) metrics.push({ label: "نوع حساب", value: String(j.entries.type) });
        if (j?.entries?.expiredate) metrics.push({ label: "انقضای حساب", value: new Date(j.entries.expiredate * 1000).toLocaleDateString("fa-IR") });
      } else {
        const res = await fetch(`${base}/api/SendSMS/GetCredit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: info.user, password: info.pass }), signal: AbortSignal.timeout(extTimeout(10_000)), redirect: "error" });
        const j = (await res.json().catch(() => null)) as { RetStatus?: number; Value?: string; StrRetStatus?: string } | null;
        if (!res.ok || !j || Number(j.RetStatus) !== 1) {
          const msg = !res.ok ? `پنل ملی‌پیامک در دسترس نیست (HTTP ${res.status})` : "نام کاربری یا رمز ملی‌پیامک اشتباه است";
          steps.push({ name: "GetCredit", ok: false, ms: Math.round(performance.now() - t0), detail: msg });
          return { status: "fail", latencyMs: Math.round(performance.now() - t0), summary: msg, steps, metrics, source: info.source };
        }
        credit = Number(j.Value);
      }
      const ms = Math.round(performance.now() - t0);
      steps.push({ name: "احراز و اعتبار", ok: true, ms, detail: Number.isFinite(credit) ? `اعتبار: ${fa(credit as number)}` : "پاسخ معتبر" });
      if (credit !== null && Number.isFinite(credit)) metrics.push({ label: "اعتبار باقی‌مانده", value: fa(credit), tone: credit <= 0 ? "fail" : credit < 5000 ? "warn" : "ok" });
      if (credit !== null && Number.isFinite(credit) && credit <= 0) return { status: "fail", latencyMs: ms, summary: "اعتبار پنل پیامک تمام شده است", steps, metrics, source: info.source, hints: ["پنل را شارژ کنید؛ بدون اعتبار کد امضا ارسال نمی‌شود."] };
      const low = credit !== null && Number.isFinite(credit) && credit < 5000;
      return { status: low || ms > 6000 ? "warn" : "ok", latencyMs: ms, summary: low ? `اعتبار پنل کم است (${fa(credit as number)})` : `${label} متصل · ${fa(ms)} میلی‌ثانیه`, steps, metrics, source: info.source, hints: ["برای اطمینان از رسیدن پیامک، از ابزار «ارسال پیامک آزمایشی» استفاده کنید."] };
    } catch (e) {
      const msg = explainNetError(e);
      steps.push({ name: "اتصال", ok: false, ms: Math.round(performance.now() - t0), detail: msg });
      return { status: "fail", latencyMs: Math.round(performance.now() - t0), summary: `ارتباط با ${label} برقرار نشد: ${msg}`, steps, metrics, source: info.source };
    }
  },
};

const deliverability: CheckDef = {
  id: "deliverability",
  group: "comms",
  label: "کیفیت تحویل پیام (۲۴ ساعت)",
  weight: 1,
  fixHref: "/admin/logs",
  async run() {
    const rows = (await db.execute(sql`select channel, status, count(*)::int as n from notifications where created_at > now() - interval '24 hours' group by channel, status`)).rows as { channel: string; status: string; n: number }[];
    const by = (ch: string, st: string) => rows.find((r) => r.channel === ch && r.status === st)?.n ?? 0;
    const metrics: Metric[] = [];
    let worst: "ok" | "warn" | "fail" = "ok";
    let summary = "";
    for (const [ch, label] of [["email", "ایمیل"], ["sms", "پیامک"]] as const) {
      const sent = by(ch, "sent"), failed = by(ch, "failed"), logged = by(ch, "logged");
      const real = sent + failed;
      const rate = real ? Math.round((failed / real) * 100) : 0;
      const tone = real >= 5 && rate > 50 ? "fail" : failed > 0 && rate > 20 ? "warn" : "ok";
      metrics.push({ label: `${label}: موفق / ناموفق / فقط ثبت‌شده`, value: `${fa(sent)} / ${fa(failed)} / ${fa(logged)}`, tone });
      if (tone === "fail") { worst = "fail"; summary = `${label}: ${fa(rate)}٪ ارسال‌ها ناموفق است`; }
      else if (tone === "warn" && worst !== "fail") { worst = "warn"; summary = `${label}: ${fa(failed)} ارسال ناموفق`; }
    }
    const last = (await db.execute(sql`select channel, error, created_at from notifications where status = 'failed' and created_at > now() - interval '24 hours' order by id desc limit 1`)).rows[0] as { channel: string; error: string | null; created_at: Date } | undefined;
    if (last?.error) metrics.push({ label: "آخرین خطا", value: `${last.channel}: ${last.error.slice(0, 110)}`, tone: "warn" });
    const total = rows.reduce((a, r) => a + r.n, 0);
    return { status: worst, summary: summary || (total ? `${fa(total)} پیام در ۲۴ ساعت گذشته بدون مشکل` : "در ۲۴ ساعت گذشته پیامی ارسال نشده"), metrics };
  },
};

export const CORE_CHECKS: CheckDef[] = [database, runtime, storage, config, publicUrl, scheduler, backup, email, sms, deliverability];
