/**
 * ۶) تست بار (Load / Stress) با autocannon — پایداری سرور تولیدی زیر ترافیک هم‌زمان
 *  سناریوها: سلامت، صفحه‌ی اصلی، قیمت‌ها، ورود، لینک امضا (با دیتابیس)، API کلید-محور (با محدودیت نرخ ۶۰/دقیقه)،
 *  داشبورد واردشده، ترکیبی، اوج ناگهانی (spike) و «بازیابی» پس از فشار.
 * معیار: صفر خطای ۵xx/قطع اتصال، صفر timeout، تأخیر کمتر از آستانه، و پاسخ‌گویی پس از فشار.
 */
import fs from "node:fs";
import path from "node:path";
import autocannon from "autocannon";
import { AUTH, BASE, REPORT_DIR } from "../lib/env";
import { readState } from "../lib/state";

interface Scenario {
  name: string;
  path?: string;
  connections: number;
  duration: number;
  /** حداکثر تأخیر p90 (ms) */
  p90: number;
  headers?: Record<string, string>;
  requests?: { method?: "GET"; path: string }[];
  /** این سناریو عمداً به محدودیت نرخ می‌خورد (۴۲۹ مورد انتظار است) */
  expectRateLimit?: boolean;
  minRps?: number;
}

const s = readState();
const cookie = (() => {
  try {
    const st = JSON.parse(fs.readFileSync(AUTH.user, "utf8")) as { cookies: { name: string; value: string }[] };
    return st.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
})();

const SCENARIOS: Scenario[] = [
  { name: "سلامت (/api/health)", path: "/api/health", connections: 50, duration: 8, p90: 250, minRps: 300 },
  { name: "صفحه‌ی اصلی (لندینگ)", path: "/", connections: 20, duration: 8, p90: 800, minRps: 40 },
  { name: "قیمت‌ها", path: "/pricing", connections: 20, duration: 8, p90: 800, minRps: 40 },
  { name: "صفحه‌ی ورود", path: "/login", connections: 20, duration: 8, p90: 800, minRps: 40 },
  { name: "لینک امضا (جست‌وجوی DB)", path: `/sign/${s.signToken ?? "a".repeat(43)}`, connections: 20, duration: 8, p90: 1200, minRps: 20 },
  { name: "داشبورد کاربر واردشده", path: "/dashboard", connections: 10, duration: 8, p90: 1500, headers: { cookie }, minRps: 10 },
  { name: "API کلید-محور (محدودیت نرخ)", path: "/api/v1/stats", connections: 5, duration: 6, p90: 1000, headers: { authorization: `Bearer ${s.apiKey ?? ""}` }, expectRateLimit: true },
  {
    name: "ترکیبی (عمومی)",
    connections: 30,
    duration: 10,
    p90: 1200,
    minRps: 30,
    requests: ["/", "/pricing", "/login", "/register", "/api/health", "/robots.txt", "/sitemap.xml", "/manifest.webmanifest"].map((p) => ({ path: p })),
  },
  { name: "اوج ناگهانی (۱۰۰ اتصال)", path: "/api/health", connections: 100, duration: 5, p90: 800, minRps: 200 },
];

const row = (sc: Scenario, r: autocannon.Result) => {
  const codes = Object.entries(r.statusCodeStats ?? {}) as [string, { count: number }][];
  const count = (f: (c: number) => boolean) => codes.filter(([c]) => f(Number(c))).reduce((a, [, v]) => a + v.count, 0);
  const server5xx = count((c) => c >= 500);
  const rateLimited = count((c) => c === 429);
  const ok2xx = r["2xx"];
  const errors = r.errors + r.timeouts + server5xx;
  const reasons: string[] = [];
  if (errors > 0) reasons.push(`${errors} خطا (۵xx/قطع/timeout)`);
  if (r.latency.p90 > sc.p90) reasons.push(`p90=${r.latency.p90}ms بیش از ${sc.p90}ms`);
  if (sc.minRps && r.requests.average < sc.minRps) reasons.push(`${Math.round(r.requests.average)} rps کمتر از ${sc.minRps}`);
  if (sc.expectRateLimit) {
    if (ok2xx < 30) reasons.push(`فقط ${ok2xx} پاسخ ۲xx پیش از محدودیت نرخ`);
    if (rateLimited === 0 && r.requests.total > 80) reasons.push("محدودیت نرخ فعال نشد");
  } else if (r.non2xx > 0) reasons.push(`${r.non2xx} پاسخ غیر ۲xx (${codes.map(([c, v]) => `${c}:${v.count}`).join(" ")})`);
  return {
    name: sc.name,
    connections: sc.connections,
    rps: Math.round(r.requests.average),
    p50: r.latency.p50,
    p90: r.latency.p90,
    p99: r.latency.p99,
    ok2xx,
    rateLimited,
    errors,
    verdict: reasons.length ? "❌" : "✅",
    reason: reasons.join("؛ "),
  };
};

async function run(sc: Scenario) {
  const base: autocannon.Options = { url: BASE, connections: sc.connections, duration: sc.duration, timeout: 20, headers: { "x-forwarded-for": "10.99.0.1", ...(sc.headers ?? {}) } };
  const opts: autocannon.Options = sc.requests ? { ...base, requests: sc.requests.map((r) => ({ method: "GET", path: r.path })) } : { ...base, url: BASE + sc.path };
  return autocannon(opts);
}

const results: ReturnType<typeof row>[] = [];
for (const sc of SCENARIOS) {
  process.stdout.write(`▶ ${sc.name} (${sc.connections} اتصال، ${sc.duration}s) … `);
  const r = await run(sc);
  const x = row(sc, r);
  results.push(x);
  console.log(`${x.verdict} ${x.rps} rps · p50 ${x.p50}ms · p90 ${x.p90}ms · p99 ${x.p99}ms${x.reason ? " — " + x.reason : ""}`);
}

// بازیابی: پس از همه‌ی فشارها سرور باید به سرعت عادی برگردد
await new Promise((r) => setTimeout(r, 1500));
const t0 = performance.now();
const h = await fetch(`${BASE}/api/health`, { headers: { "x-forwarded-for": "10.99.0.2" } });
const rec = performance.now() - t0;
const ok = h.ok && rec < 300;
results.push({ name: "بازیابی پس از فشار (یک درخواست)", connections: 1, rps: 0, p50: Math.round(rec), p90: Math.round(rec), p99: Math.round(rec), ok2xx: h.ok ? 1 : 0, rateLimited: 0, errors: h.ok ? 0 : 1, verdict: ok ? "✅" : "❌", reason: ok ? "" : `پاسخ ${h.status} در ${Math.round(rec)}ms` });
console.log(`${ok ? "✅" : "❌"} بازیابی پس از فشار: ${Math.round(rec)}ms`);

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, "load.json"), JSON.stringify({ at: new Date().toISOString(), base: BASE, scenarios: results }, null, 1));
process.exitCode = results.some((r) => r.verdict !== "✅") ? 1 : 0;
