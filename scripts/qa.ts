/**
 * اجراکننده‌ی مرکزی «آزمون‌های کیفیت» امضاگیر — بدون نیاز به هاست واقعی، وردپرس یا سرویس بیرونی.
 *
 *   npx tsx scripts/qa.ts                         همه‌ی لایه‌ها
 *   npx tsx scripts/qa.ts --layers smoke,a11y     فقط لایه‌های دلخواه
 *   npx tsx scripts/qa.ts --build                 ساخت دوباره‌ی برنامه پیش از اجرا
 *   npx tsx scripts/qa.ts --update-visual         به‌روزرسانی عکس‌های مرجع بصری
 *   npx tsx scripts/qa.ts --no-sim                بدون شبیه‌ساز سرویس‌های بیرونی
 *   npx tsx scripts/qa.ts --keep                  سرور را پس از پایان نگه دار (برای اشکال‌یابی)
 *   npx tsx scripts/qa.ts --base-url=https://staging.example.com --layers smoke,security-lite
 *
 * لایه‌ها: smoke · contract · a11y · perf-seo · lighthouse · visual · security · load
 *
 * مراحل: ۱) دیتابیس خالی emz_qa ۲) build در صورت نبود ۳) شبیه‌ساز ۴) سرور تولیدی روی پورت ۳۲۰۰
 *        ۵) آماده‌سازی (نصب‌کننده + کاربر + قرارداد + تیکت + داده‌ی نمونه) ۶) لایه‌ها ۷) گزارش فارسی qa/report/QA-REPORT-FA.md
 * خروجی: کد ۰ فقط اگر همه‌ی لایه‌های اجراشده موفق باشند.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { ADMIN_DB, BASE, CRON_SECRET, DB_NAME, DB_URL, PORT, REPORT_DIR, ROOT, SIM_PORT, STATE_DIR, STORAGE_DIR } from "../qa/lib/env";

const ALL_LAYERS = ["smoke", "contract", "a11y", "perf-seo", "lighthouse", "visual", "security", "load"] as const;
type Layer = (typeof ALL_LAYERS)[number];

const LAYER_TITLES: Record<Layer, string> = {
  smoke: "تست دود (مسیرهای حیاتی)",
  contract: "قرارداد API (Contract)",
  a11y: "دسترس‌پذیری (WCAG / axe)",
  "perf-seo": "عملکرد و سئو",
  lighthouse: "Lighthouse (عملکرد/سئو/بهترین‌روش‌ها)",
  visual: "رگرسیون بصری",
  security: "امنیت پویا (DAST)",
  load: "تست بار",
};

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);

const requested = (opt("layers")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [...ALL_LAYERS]) as Layer[];
for (const l of requested) if (!ALL_LAYERS.includes(l)) throw new Error(`لایه‌ی ناشناخته: ${l} (مجاز: ${ALL_LAYERS.join(", ")})`);
const layers = ALL_LAYERS.filter((l) => requested.includes(l));
const USE_SIM = !flag("no-sim") && process.env.QA_NO_SIM !== "1";
const PW_EXTRA = (() => {
  const i = argv.indexOf("--");
  return i === -1 ? [] : argv.slice(i + 1);
})();

const log = (m: string) => console.log(`\x1b[35m[qa]\x1b[0m ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: ROOT, env: { ...process.env, ...env } });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

async function resetDatabase() {
  const admin = new Pool({ connectionString: ADMIN_DB, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end();
  }
  for (const d of [STORAGE_DIR, STATE_DIR, path.join(REPORT_DIR, "data")]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(REPORT_DIR, "data"), { recursive: true });
  for (const f of fs.readdirSync(REPORT_DIR)) if (/\.json$/.test(f)) fs.rmSync(path.join(REPORT_DIR, f), { force: true });
}

function serverEnv(): Record<string, string> {
  return {
    NODE_ENV: "production",
    PORT: String(PORT),
    DATABASE_URL: DB_URL,
    SESSION_SECRET: "qa-session-secret-0123456789-abcdefghijkl",
    STORAGE_DIR,
    APP_URL: BASE,
    CRON_SECRET,
    ALLOW_DEV_OTP: "1",
    ALLOW_DEMO_PAYMENTS: "1",
    SKIP_EMAIL_DOMAIN_CHECK: "1",
    REQUIRE_EMAIL_VERIFICATION: "1",
    TRUSTED_PROXY_HOPS: "1",
    PDF_FONT_DIR: path.resolve(ROOT, "assets/fonts"),
    BACKUP_ENABLED: "0",
    SEED_DEMO: "0",
    // CR-03: آزمون‌های مرورگری نصب‌کننده را مثل کاربر واقعی و بدون خواندن فایل کلید می‌روند؛ فقط در این محیط آزمایشی صراحتاً باز است
    INSTALL_OPEN: "1",
    ...(USE_SIM ? { EXTERNAL_SIM_URL: `http://127.0.0.1:${SIM_PORT}`, EXTERNAL_TIMEOUT_SCALE: "0.1" } : {}),
  };
}

async function waitFor(url: string, proc: ChildProcess | undefined, what: string, seconds = 90) {
  for (let i = 0; i < seconds * 4; i++) {
    if (proc && proc.exitCode !== null) throw new Error(`${what} بلافاصله بسته شد؛ لاگ را در qa/report ببینید`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* هنوز بالا نیامده */
    }
    await sleep(250);
  }
  throw new Error(`${what} در ${seconds} ثانیه آماده نشد`);
}

/* ───────── خواندن نتایج Playwright ───────── */
type PwResult = { status: string; duration: number; error?: { message?: string } };
type PwTest = { results: PwResult[]; status: string; annotations?: { type: string; description?: string }[] };
type PwSpec = { title: string; file: string; tests: PwTest[] };
type PwSuite = { specs?: PwSpec[]; suites?: PwSuite[] };
const flatten = (s: PwSuite, out: PwSpec[] = []): PwSpec[] => {
  for (const sp of s.specs ?? []) out.push(sp);
  for (const c of s.suites ?? []) flatten(c, out);
  return out;
};

interface LayerResult {
  layer: Layer;
  code: number | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  seconds: number;
  failures: { title: string; error: string }[];
  warnings: string[];
}

function readLayer(layer: Layer, code: number | null, seconds: number): LayerResult {
  const res: LayerResult = { layer, code, total: 0, passed: 0, failed: 0, skipped: 0, seconds, failures: [], warnings: [] };
  const file = path.join(REPORT_DIR, `${layer}.json`);
  if (!fs.existsSync(file)) return res;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { suites: PwSuite[] };
    const specs: PwSpec[] = [];
    for (const s of json.suites ?? []) flatten(s, specs);
    for (const sp of specs) {
      res.total++;
      const t = sp.tests;
      const ok = t.every((x) => x.status === "expected");
      const skipped = !ok && t.some((x) => x.status === "skipped") && !t.some((x) => x.status === "unexpected");
      if (ok) res.passed++;
      else if (skipped) res.skipped++;
      else {
        res.failed++;
        const err = t.flatMap((x) => x.results).find((r) => r.error)?.error?.message ?? "";
        res.failures.push({ title: sp.title, error: err.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 1800) });
      }
      for (const x of t) for (const a of x.annotations ?? []) if (a.type === "warning" && a.description) res.warnings.push(`${sp.title}: ${a.description}`);
    }
  } catch {
    /* گزارش ناقص */
  }
  return res;
}

function readJsonl(name: string): Record<string, unknown>[] {
  const f = path.join(REPORT_DIR, "data", `${name}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const md = (rows: Record<string, unknown>[], cols: [string, string][]) => {
  if (!rows.length) return ["_بدون داده_", ""];
  const out = [`| ${cols.map((c) => c[1]).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${cols.map(([k]) => String(r[k] ?? "—").replace(/\|/g, "/")).join(" | ")} |`);
  out.push("");
  return out;
};

function writeReport(results: LayerResult[]) {
  const L: string[] = ["# گزارش آزمون‌های کیفیت امضاگیر", "", `تاریخ: ${new Date().toLocaleString("fa-IR")}`, `آدرس: ${BASE}`, ""];
  L.push("## خلاصه", "", "| لایه | وضعیت | موفق | ناموفق | رد شده | زمان (ثانیه) |", "|---|---|---|---|---|---|");
  for (const r of results) {
    const st = r.code === null ? "—" : r.code === 0 && r.failed === 0 ? "✅" : "❌";
    L.push(`| ${LAYER_TITLES[r.layer]} | ${st} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.seconds.toFixed(0)} |`);
  }
  L.push("");

  const a11y = readJsonl("a11y");
  if (a11y.length) L.push("## دسترس‌پذیری — تخلف‌ها به تفکیک صفحه", "", ...md(a11y.filter((r) => Number(r.violations) > 0), [["page", "صفحه"], ["device", "دستگاه"], ["theme", "تم"], ["violations", "تخلف"], ["rules", "قواعد"]]));
  const perf = readJsonl("perf");
  if (perf.length) L.push("## عملکرد صفحه‌های عمومی (Chromium واقعی)", "", ...md(perf, [["page", "صفحه"], ["ttfb", "TTFB ms"], ["fcp", "FCP ms"], ["lcp", "LCP ms"], ["cls", "CLS"], ["jsKb", "JS KB(gzip)"], ["requests", "درخواست"], ["dom", "DOM"]]));
  const lh = readJsonl("lighthouse");
  if (lh.length) L.push("## Lighthouse (۰ تا ۱۰۰)", "", ...md(lh, [["page", "صفحه"], ["form", "دستگاه"], ["performance", "عملکرد"], ["seo", "سئو"], ["accessibility", "دسترس‌پذیری"], ["bestPractices", "بهترین‌روش‌ها"]]));
  const loadFile = path.join(REPORT_DIR, "load.json");
  if (fs.existsSync(loadFile)) {
    const rows = (JSON.parse(fs.readFileSync(loadFile, "utf8")) as { scenarios: Record<string, unknown>[] }).scenarios;
    L.push("## تست بار", "", ...md(rows, [["name", "سناریو"], ["connections", "اتصال هم‌زمان"], ["rps", "درخواست/ثانیه"], ["p50", "p50 ms"], ["p90", "p90 ms"], ["p99", "p99 ms"], ["ok2xx", "2xx"], ["rateLimited", "429"], ["errors", "خطا ۵xx/قطع"], ["verdict", "نتیجه"]]));
  }

  for (const r of results) {
    if (r.warnings.length) L.push(`## هشدارهای ${LAYER_TITLES[r.layer]}`, "", ...r.warnings.slice(0, 60).map((w) => `- ${w}`), "");
    if (r.failures.length) {
      L.push(`## خطاهای ${LAYER_TITLES[r.layer]}`, "");
      for (const f of r.failures) L.push(`### ${f.title}`, "```", f.error, "```", "");
    }
  }
  L.push("", "اجرای دوباره: `npm run qa` — راهنما: `docs/QA-FA.md`");
  fs.writeFileSync(path.join(REPORT_DIR, "QA-REPORT-FA.md"), L.join("\n"));
  log("گزارش فارسی: qa/report/QA-REPORT-FA.md");
}

/* ───────── اجرا ───────── */
async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const external = !!opt("base-url") || !!process.env.QA_BASE_URL;
  if (external) log(`حالت سرور بیرونی: ${BASE} (فقط لایه‌های بدون نیاز به ساخت DB: smoke/security/perf-seo/load/lighthouse)`);

  let server: ChildProcess | undefined;
  let sim: ChildProcess | undefined;
  const cleanup = async () => {
    if (flag("keep")) return;
    for (const p of [server, sim]) {
      if (p && p.exitCode === null) {
        p.kill("SIGTERM");
        await sleep(400);
        if (p.exitCode === null) p.kill("SIGKILL");
      }
    }
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

  const results: LayerResult[] = [];
  try {
    // --reuse: دیتابیس و داده‌ی آماده‌سازی قبلی را نگه می‌دارد (تکرار سریع هنگام توسعه‌ی آزمون)
    const reuse = flag("reuse") && fs.existsSync(path.join(STATE_DIR, "state.json"));
    if (!external) {
      if (reuse) log("۱) استفاده‌ی دوباره از دیتابیس و داده‌ی قبلی (--reuse)");
      else {
        log("۱) دیتابیس خالی " + DB_NAME);
        await resetDatabase();
      }

      if (flag("build") || !fs.existsSync(path.join(ROOT, ".next/BUILD_ID"))) {
        log("۲) ساخت برنامه (next build)");
        if ((await run("npm", ["run", "build"])) !== 0) throw new Error("build ناموفق بود");
      } else log("۲) از build موجود استفاده می‌شود (برای ساخت دوباره --build)");

      // خروجی پردازه‌ها مستقیم به فایل می‌رود (نه pipe)؛ در غیر این صورت پر شدن بافر، سرور را قفل می‌کند
      const out = (n: string) => fs.openSync(path.join(REPORT_DIR, n), "w");
      if (USE_SIM) {
        sim = spawn(path.join(ROOT, "node_modules/.bin/tsx"), ["simulator/cli.ts", "--port", String(SIM_PORT), "--startpay", "auto", "--quiet"], { cwd: ROOT, stdio: ["ignore", out("simulator.log"), out("simulator.log")] });
        await waitFor(`http://127.0.0.1:${SIM_PORT}/__sim/health`, sim, "شبیه‌ساز", 15);
        log(`۳) شبیه‌ساز سرویس‌های بیرونی روی ${SIM_PORT}`);
      }
      log(`۴) سرور تولیدی روی ${BASE}`);
      const sl = out("server.log");
      server = spawn(path.join(ROOT, "node_modules/.bin/next"), ["start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: ROOT, env: { ...process.env, ...serverEnv() }, stdio: ["ignore", sl, sl] });
      await waitFor(`${BASE}/api/health`, server, "سرور");

      if (!reuse) {
        log("۵) آماده‌سازی: نصب‌کننده، کاربر، کلید API، قرارداد، تیکت و داده‌ی نمونه");
        const code = await run("npx", ["playwright", "test", "-c", "qa/playwright.config.ts", "--project=setup"], { PLAYWRIGHT_JSON_OUTPUT_NAME: "" });
        if (code !== 0) throw new Error("مرحله‌ی آماده‌سازی ناموفق بود (خروجی بالا را ببینید)");
      }
    } else {
      await waitFor(`${BASE}/api/health`, undefined, "سرور بیرونی", 20);
    }

    for (const layer of layers) {
      if (external && ["contract", "a11y", "visual"].includes(layer)) {
        log(`⏭️  ${LAYER_TITLES[layer]} روی سرور بیرونی اجرا نمی‌شود (نیاز به داده‌ی آماده‌سازی)`);
        continue;
      }
      log(`▶ ${LAYER_TITLES[layer]}`);
      // معیارهای اجرای قبلی همین لایه پاک می‌شود (با --reuse نباید ردیف قدیمی در گزارش بماند)
      fs.rmSync(path.join(REPORT_DIR, "data", `${layer === "perf-seo" ? "perf" : layer}.jsonl`), { force: true });
      const t0 = Date.now();
      let code: number;
      if (layer === "load") code = await run("npx", ["tsx", "qa/load/run.ts"]);
      else {
        const args = ["playwright", "test", "-c", "qa/playwright.config.ts", `--project=${layer}`, "--reporter=list,json"];
        if (layer === "visual" && flag("update-visual")) args.push("--update-snapshots");
        code = await run("npx", [...args, ...PW_EXTRA], { PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(REPORT_DIR, `${layer}.json`) });
      }
      const r = readLayer(layer, code, (Date.now() - t0) / 1000);
      if (layer === "load") {
        const f = path.join(REPORT_DIR, "load.json");
        if (fs.existsSync(f)) {
          const j = JSON.parse(fs.readFileSync(f, "utf8")) as { scenarios: { name: string; verdict: string; reason?: string }[] };
          r.total = j.scenarios.length;
          r.failed = j.scenarios.filter((s) => s.verdict !== "✅").length;
          r.passed = r.total - r.failed;
          r.failures = j.scenarios.filter((s) => s.verdict !== "✅").map((s) => ({ title: s.name, error: s.reason ?? "" }));
        }
      }
      if (code !== 0 && r.failed === 0) r.failed = 1;
      results.push(r);
    }
  } finally {
    await cleanup();
  }
  writeReport(results);
  const bad = results.filter((r) => r.code !== 0 || r.failed > 0);
  console.log("\n" + results.map((r) => `${r.code === 0 && r.failed === 0 ? "✅" : "❌"} ${LAYER_TITLES[r.layer]} — ${r.passed}/${r.total}`).join("\n"));
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
