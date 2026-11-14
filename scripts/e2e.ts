/**
 * اجراکننده‌ی سامانه‌ی تست جامع امضاگیر («آزمایشگاه کیفیت»)
 *
 *   npx tsx scripts/e2e.ts                  همه‌چیز: ۸۹+ تست بک‌اند (Vitest) + سناریوی کامل مرورگری (Playwright)
 *   npx tsx scripts/e2e.ts --skip-unit      فقط مرورگری
 *   npx tsx scripts/e2e.ts --only-unit      فقط بک‌اند
 *   npx tsx scripts/e2e.ts --build          ساخت دوباره‌ی برنامه پیش از اجرا
 *   npx tsx scripts/e2e.ts --no-sim         بدون شبیه‌ساز (درگاه «آزمایشی» داخلی و بدون تست سناریوهای خطا)
 *   npx tsx scripts/e2e.ts -- -g "A4"       آرگومان‌های بعد از «--» مستقیم به Playwright می‌روند
 *
 * کارهایی که انجام می‌دهد:
 *  ۰) شبیه‌ساز سرویس‌های بیرونی (زرین‌پال/کاوه‌نگار/ملی‌پیامک/GapGPT) را بالا می‌آورد تا هیچ تماس واقعی و هزینه‌ای نباشد (docs/SIMULATOR-FA.md)
 *  ۱) دیتابیس «خالی» emz_e2e را از نو می‌سازد (تا نصب‌کننده‌ی وب هم مثل کاربر واقعی آزموده شود)
 *  ۲) در صورت نبود، برنامه را build می‌کند و سرور تولیدی (next start) را روی پورت ۳۱۰۰ بالا می‌آورد
 *  ۳) Vitest و سپس Playwright (کروم واقعی، دسکتاپ/تبلت/موبایل) را اجرا می‌کند
 *  ۴) سرور را می‌بندد و گزارش فارسی را در e2e/report/REPORT-FA.md می‌نویسد
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const flags = new Set(dd === -1 ? argv : argv.slice(0, dd));
const pwArgs = dd === -1 ? [] : argv.slice(dd + 1);

const PORT = Number(process.env.E2E_PORT) || 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_DB = process.env.E2E_ADMIN_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const DB_NAME = "emz_e2e";
const DB_URL = process.env.E2E_DATABASE_URL || ADMIN_DB.replace(/\/[^/]*$/, `/${DB_NAME}`);
const STORAGE = path.resolve(ROOT, ".e2e-storage");
const CRON_SECRET = "e2e-cron-secret-0123456789";
const REPORT_DIR = path.resolve(ROOT, "e2e/report");
const USE_SIM = !flags.has("--no-sim") && process.env.E2E_NO_SIM !== "1";
const SIM_PORT = Number(process.env.E2E_SIM_PORT) || 4110;

const log = (m: string) => console.log(`\x1b[36m[e2e]\x1b[0m ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], env: Record<string, string> = {}): number {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, env: { ...process.env, ...env } });
  return r.status ?? 1;
}

async function resetDatabase() {
  const admin = new Pool({ connectionString: ADMIN_DB, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
  fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.mkdirSync(STORAGE, { recursive: true });
  fs.rmSync(path.join(ROOT, "e2e/.state"), { recursive: true, force: true });
  fs.rmSync(REPORT_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function serverEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    PORT: String(PORT),
    DATABASE_URL: DB_URL,
    SESSION_SECRET: "e2e-session-secret-0123456789-abcdefghijkl",
    STORAGE_DIR: STORAGE,
    APP_URL: BASE,
    CRON_SECRET,
    CRON_INTERVAL_MINUTES: "1",
    ALLOW_DEV_OTP: "1",
    ALLOW_DEMO_PAYMENTS: "1",
    SKIP_EMAIL_DOMAIN_CHECK: "1",
    REQUIRE_EMAIL_VERIFICATION: "1",
    TRUSTED_PROXY_HOPS: "1",
    PDF_FONT_DIR: path.resolve(ROOT, "assets/fonts"),
    BACKUP_ENABLED: "1",
    SEED_DEMO: "0",
    // CR-03: آزمون‌های مرورگری نصب‌کننده را مثل کاربر واقعی و بدون خواندن فایل کلید می‌روند؛ فقط در این محیط آزمایشی صراحتاً باز است
    INSTALL_OPEN: "1",
    ...(USE_SIM ? { EXTERNAL_SIM_URL: `http://127.0.0.1:${SIM_PORT}`, EXTERNAL_TIMEOUT_SCALE: "0.1" } : {}),
  };
}

async function waitHealthy(proc: ChildProcess) {
  for (let i = 0; i < 90; i++) {
    if (proc.exitCode !== null) throw new Error("سرور بلافاصله بسته شد؛ لاگ بالا را ببینید");
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* هنوز بالا نیامده */
    }
    await sleep(1000);
  }
  throw new Error("سرور در ۹۰ ثانیه آماده نشد");
}

/* ───────── گزارش فارسی ───────── */
type PwResult = { status: string; duration: number; error?: { message?: string } };
type PwTest = { results: PwResult[]; status: string };
type PwSpec = { title: string; file: string; tests: PwTest[] };
type PwSuite = { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] };

const REQUIRED: [string, string][] = [
  ["A1", "ورود مدیر و بررسی داشبورد"], ["A2", "ساخت قالب قرارداد (فیلدهای پویا + هوش مصنوعی)"], ["A3", "تنظیمات سیستم (پیامک، هوش مصنوعی، برندینگ، تاریک/روشن)"],
  ["A4", "صدور قرارداد برای مشتری جدید و لینک امضا"], ["A5", "لاگ‌های امنیتی و رویدادها"], ["A6", "صورتحساب و پلن‌های اشتراک"], ["A7", "پاسخ به تیکت پشتیبانی"],
  ["B1", "ثبت‌نام، تأیید ایمیل و ورود"], ["B2", "داشبورد و لیست قراردادهای کاربر"], ["B3", "امضای مهمان: لینک، OTP، فیلدها، امضا"], ["B4", "دانلود PDF و بررسی هش امنیتی"],
  ["B5", "مشخصات حساب، رمز عبور و دستگاه‌ها"], ["B6", "ثبت تیکت پشتیبانی"], ["B7", "خروجی داده‌های شخصی و حذف حساب"],
  ["S1", "شبیه‌ساز: پرداخت — قطعی، انصراف، OK جعلی، قطعی هنگام تایید"], ["S2", "شبیه‌ساز: هوش مصنوعی — خطا، خروجی مخرب، موفقیت"],
  ["C1", "اعلان‌ها (زنگوله)"], ["C2", "ریسپانسیو بودن صفحه‌ها (دسکتاپ/تبلت/موبایل)"], ["C3", "زمان‌بند (یادآوری و انقضا)"], ["C4", "بک‌آپ خودکار"],
];

function flatten(s: PwSuite, out: PwSpec[] = []): PwSpec[] {
  for (const sp of s.specs ?? []) out.push(sp);
  for (const c of s.suites ?? []) flatten(c, out);
  return out;
}

type SimRow = { service: string; status: number };
function writeReport(unitCode: number | null, pwCode: number | null, simLog?: SimRow[]) {
  const file = path.join(REPORT_DIR, "results.json");
  let specs: PwSpec[] = [];
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { suites: PwSuite[] };
    for (const s of json.suites) flatten(s, specs);
  } catch {
    specs = [];
  }
  const status = (sp: PwSpec): "pass" | "fail" | "skip" => (sp.tests.every((t) => t.status === "expected") ? "pass" : sp.tests.some((t) => t.status === "skipped") && !sp.tests.some((t) => t.status === "unexpected") ? "skip" : "fail");
  const icon = { pass: "✅", fail: "❌", skip: "⏭️" } as const;
  const lines: string[] = [];
  lines.push("# گزارش سامانه‌ی تست جامع امضاگیر", "", `تاریخ: ${new Date().toLocaleString("fa-IR")}`, "");
  lines.push(`- بک‌آپ و منطق (Vitest): ${unitCode === null ? "اجرا نشد" : unitCode === 0 ? "✅ همه موفق" : "❌ ناموفق"}`);
  lines.push(`- سناریوی کامل مرورگری (Playwright): ${pwCode === null ? "اجرا نشد" : pwCode === 0 ? "✅ همه موفق" : "❌ ناموفق"}`, "");
  lines.push("## پوشش موارد درخواستی", "", "| کد | مورد | وضعیت |", "|---|---|---|");
  for (const [code, title] of REQUIRED) {
    const hit = specs.filter((s) => s.title.includes(`[${code}]`));
    const st = hit.length === 0 ? "—" : hit.every((s) => status(s) === "pass") ? "✅" : hit.some((s) => status(s) === "fail") ? "❌" : "⏭️";
    lines.push(`| ${code} | ${title} | ${st} (${hit.length} آزمون) |`);
  }
  lines.push("", "## همه‌ی آزمون‌های مرورگری", "", "| وضعیت | آزمون | فایل | زمان (ثانیه) |", "|---|---|---|---|");
  for (const sp of specs) {
    const st = status(sp);
    const ms = sp.tests.flatMap((t) => t.results).reduce((a, r) => a + r.duration, 0);
    lines.push(`| ${icon[st]} | ${sp.title.replace(/\|/g, "/")} | ${sp.file} | ${(ms / 1000).toFixed(1)} |`);
  }
  const failed = specs.filter((s) => status(s) === "fail");
  if (failed.length) {
    lines.push("", "## جزئیات خطاها", "");
    for (const sp of failed) {
      const err = sp.tests.flatMap((t) => t.results).find((r) => r.error)?.error?.message ?? "";
      lines.push(`### ${sp.title}`, "```", err.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1500), "```", "");
    }
  }
  if (simLog) {
    const byService = new Map<string, { total: number; failed: number }>();
    for (const r of simLog) {
      const s = byService.get(r.service) ?? { total: 0, failed: 0 };
      s.total++;
      if (r.status === 0 || r.status >= 400) s.failed++;
      byService.set(r.service, s);
    }
    lines.push("", "## ترافیک شبیه‌ساز سرویس‌های بیرونی", "", "| سرویس | کل درخواست‌ها | پاسخ خطا/قطع |", "|---|---|---|");
    for (const [svc, s] of byService) lines.push(`| ${svc} | ${s.total} | ${s.failed} |`);
    fs.writeFileSync(path.join(REPORT_DIR, "simulator-requests.json"), JSON.stringify(simLog, null, 1));
    lines.push("", "جزئیات هر درخواست: `e2e/report/simulator-requests.json`");
  }
  lines.push("", "نمونه‌ی تصویر هر صفحه در هر اندازه‌ی نمایش: `e2e/report/screenshots/` — موارد غیرخودکار: `docs/MANUAL-CHECKLIST-FA.md`");
  fs.writeFileSync(path.join(REPORT_DIR, "REPORT-FA.md"), lines.join("\n"));
  log(`گزارش فارسی: e2e/report/REPORT-FA.md`);
}

async function main() {
  let unitCode: number | null = null;
  let pwCode: number | null = null;

  if (!flags.has("--skip-unit")) {
    log("۱) تست‌های بک‌اند (Vitest، دیتابیس emz_test)");
    unitCode = run("npx", ["vitest", "run"]);
    if (flags.has("--only-unit")) {
      process.exitCode = unitCode;
      return;
    }
  }

  log("۲) آماده‌سازی دیتابیس خالی emz_e2e");
  await resetDatabase();

  if (flags.has("--build") || !fs.existsSync(path.join(ROOT, ".next/BUILD_ID"))) {
    log("۳) ساخت برنامه (next build)");
    const c = run("npm", ["run", "build"]);
    if (c !== 0) throw new Error("build ناموفق بود");
  } else log("۳) از build موجود استفاده می‌شود (برای ساخت دوباره --build)");

  // شبیه‌ساز باید «پردازه‌ی جدا» باشد: اجراکننده در حین Playwright با spawnSync بلاک است و شبیه‌سازِ درون‌پردازه پاسخ نمی‌داد
  let sim: ChildProcess | undefined;
  const SIM_URL = `http://127.0.0.1:${SIM_PORT}`;
  if (USE_SIM) {
    sim = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["simulator/cli.ts", "--port", String(SIM_PORT), "--startpay", "auto", "--quiet"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const simLogFile = fs.createWriteStream(path.join(REPORT_DIR, "simulator.log"));
    sim.stdout?.pipe(simLogFile);
    sim.stderr?.pipe(simLogFile);
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      if (sim.exitCode !== null) throw new Error("شبیه‌ساز بالا نیامد؛ e2e/report/simulator.log را ببینید");
      up = await fetch(`${SIM_URL}/__sim/health`).then((r) => r.ok, () => false);
      if (!up) await sleep(250);
    }
    if (!up) throw new Error("شبیه‌ساز در ۱۰ ثانیه آماده نشد");
    log(`۳.۵) شبیه‌ساز سرویس‌های بیرونی روی ${SIM_URL} (زرین‌پال، کاوه‌نگار، ملی‌پیامک، GapGPT)`);
  } else log("۳.۵) بدون شبیه‌ساز (--no-sim)");

  log(`۴) راه‌اندازی سرور تولیدی روی ${BASE}`);
  const server = spawn(path.join(ROOT, "node_modules/.bin/next"), ["start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: ROOT, env: { ...process.env, ...serverEnv() }, stdio: ["ignore", "pipe", "pipe"] });
  const serverLog = fs.createWriteStream(path.join(REPORT_DIR, "server.log"));
  server.stdout?.pipe(serverLog);
  server.stderr?.pipe(serverLog);
  try {
    await waitHealthy(server);
    log("۵) سناریوی کامل مرورگری (Playwright)");
    pwCode = run("npx", ["playwright", "test", ...pwArgs], {
      E2E_BASE_URL: BASE,
      E2E_DATABASE_URL: DB_URL,
      E2E_STORAGE_DIR: STORAGE,
      CRON_SECRET,
      ...(sim ? { E2E_SIM_URL: SIM_URL } : {}),
    });
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  let simLog: SimRow[] | undefined;
  if (sim) {
    simLog = await fetch(`${SIM_URL}/__sim/requests?limit=1000`).then((r) => r.json() as Promise<{ requests: SimRow[] }>).then((j) => j.requests, () => undefined);
    sim.kill("SIGTERM");
  }
  writeReport(unitCode, pwCode, simLog);
  process.exitCode = (unitCode ?? 0) !== 0 || (pwCode ?? 0) !== 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
