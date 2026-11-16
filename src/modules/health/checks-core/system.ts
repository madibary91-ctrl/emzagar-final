import { APP_VERSION } from "@/lib/version";
import { type CheckDef, type CheckOutput, type Metric, type Step } from "../types";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";
import { STORAGE_DIR, getConfig } from "@/lib/config";
import { ageText, fa, fmtBytes, writable } from "./util";
import { db, getPool } from "@/db";
import fs from "node:fs/promises";
import { kycDir } from "@/lib/storage-paths";
import os from "node:os";
import { sql } from "drizzle-orm";

/** نام جدول‌های مورد انتظار از SQL نصب‌کننده */
const expectedTables = () => SCHEMA_CREATE.map((s) => /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(s)?.[1]).filter((x): x is string => !!x);
const loopLag = async (): Promise<number> => {
  const t0 = performance.now();
  await new Promise<void>((r) => setImmediate(r));
  return Math.round((performance.now() - t0) * 10) / 10;
};
/* ───────────────────────── زیرساخت ───────────────────────── */

export const database: CheckDef = {
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
export const runtime: CheckDef = {
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
export const storage: CheckDef = {
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
