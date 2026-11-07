import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getConfig, trustedAppOrigin } from "@/lib/config";
import { simulatorUrl } from "@/lib/external";
import { escapeHtml } from "@/lib/html";
import { APP_VERSION } from "@/lib/version";
import { logAudit } from "@/modules/audit/service";
import { sendMail } from "@/modules/mail";
import { platformAdminEmails } from "@/modules/platform/admin";
import { BIZ_CHECKS } from "./checks-biz";
import { CORE_CHECKS, ENV_AUDIT_DEFS, ageText } from "./checks-core";
import type { CheckContext, CheckDef, CheckResult, EnvAuditItem, HealthSnapshot, HealthStatus, HistoryInfo, IncidentView, Readiness } from "./types";

export const ALL_CHECKS: CheckDef[] = [...CORE_CHECKS, ...BIZ_CHECKS];
export const CHECK_IDS = ALL_CHECKS.map((c) => c.id);
const byId = (id: string) => ALL_CHECKS.find((c) => c.id === id);

const CACHE_MS = 40_000;
const LIGHT_TIMEOUT = 25_000;
const DEEP_TIMEOUT = 50_000;

type Holder = typeof globalThis & {
  __healthCache?: Map<string, { at: number; result: CheckResult }>;
  __healthDeep?: Map<string, NonNullable<CheckResult["lastDeep"]>>;
};
const g = globalThis as Holder;
const cache = (g.__healthCache ??= new Map());
const deepStore = (g.__healthDeep ??= new Map());

const slow = (ms: number, label: string) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`بررسی «${label}» بیش از ${Math.round(ms / 1000)} ثانیه طول کشید`)), ms).unref?.());

/** پیام خطا را از اطلاعات حساس پاک می‌کند (رمز اتصال دیتابیس، کلیدها) */
function scrub(msg: string): string {
  return msg.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, "$1***@").replace(/(key|token|secret|password|pass)=([^&\s]+)/gi, "$1=***").slice(0, 300);
}

/* ───────────────────────── اجرای یک بررسی ───────────────────────── */

export async function runCheck(def: CheckDef, ctx: CheckContext, opts: { deep?: boolean; force?: boolean; record?: boolean } = {}): Promise<CheckResult> {
  const key = `${ctx.workspaceId}:${def.id}`;
  const hit = cache.get(key);
  if (!opts.deep && !opts.force && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true, lastDeep: deepStore.get(def.id) };

  const t0 = performance.now();
  let out: Awaited<ReturnType<CheckDef["run"]>>;
  try {
    out = await Promise.race([def.run(ctx, !!opts.deep), slow(opts.deep ? DEEP_TIMEOUT : LIGHT_TIMEOUT, def.label)]);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const dbDown = /DATABASE_NOT_CONFIGURED/.test(raw) || /ECONNREFUSED|ENOTFOUND|connection terminated|Connection terminated|timeout exceeded when trying to connect|the database system is (starting up|shutting down)|password authentication failed/i.test(raw);
    out = dbDown
      ? { status: "fail", summary: "دیتابیس در دسترس نیست؛ این بررسی به دیتابیس وابسته است", hints: ["ابتدا وضعیت «دیتابیس PostgreSQL» را برطرف کنید (سرویس بالا باشد و DATABASE_URL درست باشد)."] }
      : { status: "fail", summary: scrub(raw) || "خطای ناشناخته در اجرای بررسی", hints: ["اگر این خطا تکرار شد، لاگ سرور را بررسی کنید."] };
  }
  const result: CheckResult = {
    id: def.id,
    group: def.group,
    label: def.label,
    status: out.status,
    summary: scrub(out.summary),
    latencyMs: out.latencyMs ?? Math.round(performance.now() - t0),
    checkedAt: new Date().toISOString(),
    deep: !!opts.deep,
    source: out.source,
    metrics: out.metrics ?? [],
    steps: (out.steps ?? []).map((s) => ({ ...s, detail: s.detail ? scrub(s.detail) : s.detail })),
    hints: out.hints ?? [],
    weight: def.weight,
    blocker: (out.status === "fail" && def.weight > 0) || (out.status === "unconfigured" && def.weight >= 3),
    deepAvailable: !!def.deepAvailable,
    deepLabel: def.deepLabel,
    fixHref: def.fixHref,
    fixLabel: def.fixLabel,
  };
  if (opts.deep) deepStore.set(def.id, { at: result.checkedAt, status: result.status, summary: result.summary, latencyMs: result.latencyMs });
  result.lastDeep = deepStore.get(def.id);
  cache.set(key, { at: Date.now(), result });
  if (opts.record !== false) await recordSample(result).catch(() => undefined);
  return result;
}

export async function runChecks(ctx: CheckContext, opts: { ids?: string[]; deep?: boolean; force?: boolean; record?: boolean } = {}): Promise<CheckResult[]> {
  const defs = opts.ids ? ALL_CHECKS.filter((c) => opts.ids!.includes(c.id)) : ALL_CHECKS;
  return Promise.all(defs.map((d) => runCheck(d, ctx, { deep: opts.deep && d.deepAvailable, force: opts.force, record: opts.record })));
}

export function runOne(id: string, ctx: CheckContext, deep: boolean): Promise<CheckResult> | null {
  const def = byId(id);
  return def ? runCheck(def, ctx, { deep: deep && def.deepAvailable, force: true }) : null;
}

/* ───────────────────────── ثبت نمونه و رخداد ───────────────────────── */

async function recordSample(r: CheckResult) {
  await db.execute(sql`insert into health_checks (check_id, status, latency_ms, message) values (${r.id}, ${r.status}, ${r.latencyMs}, ${r.summary.slice(0, 300)})`);
  if (r.status === "fail") {
    const open = (await db.execute(sql`select id from health_incidents where check_id = ${r.id} and resolved_at is null limit 1`)).rows[0] as { id: number } | undefined;
    if (!open) await db.execute(sql`insert into health_incidents (check_id, label, severity, message) values (${r.id}, ${r.label}, 'fail', ${r.summary.slice(0, 300)})`);
    else await db.execute(sql`update health_incidents set message = ${r.summary.slice(0, 300)} where id = ${open.id}`);
  } else {
    await db.execute(sql`update health_incidents set resolved_at = now() where check_id = ${r.id} and resolved_at is null`);
  }
}

export async function getHistory(ids: string[]): Promise<Record<string, HistoryInfo>> {
  const out: Record<string, HistoryInfo> = {};
  for (const id of ids) out[id] = { uptime24h: null, uptime7d: null, samples: [] };
  try {
    const up = (await db.execute(sql`
      select check_id,
        count(*) filter (where created_at > now() - interval '24 hours' and status <> 'unconfigured')::int as t24,
        count(*) filter (where created_at > now() - interval '24 hours' and status in ('ok','warn'))::int as u24,
        count(*) filter (where status <> 'unconfigured')::int as t7,
        count(*) filter (where status in ('ok','warn'))::int as u7
      from health_checks where created_at > now() - interval '7 days' and check_id <> '__probe__' group by check_id`)).rows as { check_id: string; t24: number; u24: number; t7: number; u7: number }[];
    for (const r of up) if (out[r.check_id]) {
      out[r.check_id].uptime24h = r.t24 ? Math.round((r.u24 / r.t24) * 1000) / 10 : null;
      out[r.check_id].uptime7d = r.t7 ? Math.round((r.u7 / r.t7) * 1000) / 10 : null;
    }
    const samples = (await db.execute(sql`
      select check_id, status, latency_ms, created_at from (
        select check_id, status, latency_ms, created_at, row_number() over (partition by check_id order by created_at desc) rn
        from health_checks where created_at > now() - interval '48 hours' and check_id <> '__probe__') x where rn <= 40 order by check_id, created_at`)).rows as { check_id: string; status: HealthStatus; latency_ms: number | null; created_at: Date }[];
    for (const s of samples) out[s.check_id]?.samples.push({ t: new Date(s.created_at).toISOString(), s: s.status, ms: s.latency_ms });
  } catch {
    /* بدون تاریخچه هم داشبورد کار می‌کند */
  }
  return out;
}

export async function getIncidents(limit = 25): Promise<IncidentView[]> {
  try {
    const rows = (await db.execute(sql`select id, check_id, label, severity, message, started_at, resolved_at from health_incidents order by started_at desc limit ${limit}`)).rows as { id: number; check_id: string; label: string; severity: string; message: string; started_at: Date; resolved_at: Date | null }[];
    return rows.map((r) => ({ id: r.id, checkId: r.check_id, label: r.label, severity: r.severity, message: r.message, startedAt: new Date(r.started_at).toISOString(), resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null }));
  } catch {
    return [];
  }
}

/** تعداد رخدادهای باز (برای نشان روی منو) */
export async function openIncidentCount(): Promise<number> {
  try {
    return ((await db.execute(sql`select count(*)::int as n from health_incidents where resolved_at is null`)).rows[0] as { n: number }).n;
  } catch {
    return 0;
  }
}

/* ───────────────────────── امتیاز آمادگی لانچ ───────────────────────── */

export function computeReadiness(results: CheckResult[]): Readiness {
  let got = 0, max = 0;
  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, fail: 0, unconfigured: 0 };
  for (const r of results) {
    counts[r.status]++;
    if (r.weight <= 0) continue;
    max += r.weight;
    const pts = r.status === "ok" ? 1 : r.status === "warn" ? 0.6 : r.status === "unconfigured" ? (r.weight >= 3 ? 0 : 0.5) : 0;
    got += r.weight * pts;
  }
  const score = max ? Math.round((got / max) * 100) : 0;
  const blockers = results.filter((r) => r.blocker).map((r) => ({ id: r.id, label: r.label, status: r.status, summary: r.summary, fixHref: r.fixHref }));
  const verdict = blockers.length === 0 && score >= 85 ? "ready" : score >= 65 && blockers.length <= 2 ? "almost" : "not_ready";
  return { score, verdict, verdictLabel: verdict === "ready" ? "آماده‌ی لانچ" : verdict === "almost" ? "تقریباً آماده" : "هنوز آماده نیست", blockers, counts };
}

export function envAudit(): EnvAuditItem[] {
  const cfg = getConfig();
  return ENV_AUDIT_DEFS.map((d) => {
    const set = d.name === "DATABASE_URL" ? !!cfg.databaseUrl : d.name === "SESSION_SECRET" ? !!cfg.sessionSecret : d.name === "APP_URL" ? !!cfg.appUrl : !!process.env[d.name];
    return { ...d, set, risky: d.level === "danger" ? (d.name === "EXTERNAL_SIM_URL" ? set : process.env[d.name] === "1") : undefined };
  });
}

/* ───────────────────────── تصویر کامل داشبورد ───────────────────────── */

export async function buildSnapshot(ctx: CheckContext, opts: { force?: boolean; workspaceName?: string } = {}): Promise<HealthSnapshot> {
  const results = await runChecks(ctx, { force: opts.force });
  const [history, incidents] = await Promise.all([getHistory(results.map((r) => r.id)), getIncidents()]);
  return {
    generatedAt: new Date().toISOString(),
    environment: { nodeEnv: process.env.NODE_ENV || "development", simulator: simulatorUrl()?.origin ?? null, version: APP_VERSION, nodeVersion: process.version, workspaceId: ctx.workspaceId, workspaceName: opts.workspaceName ?? "", uptimeSec: Math.round(process.uptime()) },
    results,
    history,
    incidents,
    readiness: computeReadiness(results),
    envAudit: envAudit(),
  };
}

/** خلاصه‌ی سبک برای پایش بیرونی (UptimeRobot و …) */
export async function statusSummary() {
  const ctx = await sweepContext();
  const results = await runChecks(ctx, { record: false });
  const failing = results.filter((r) => r.status === "fail");
  const critical = failing.filter((r) => r.weight >= 3);
  const rd = computeReadiness(results);
  return {
    status: critical.length ? ("down" as const) : failing.length || results.some((r) => r.status === "warn") ? ("degraded" as const) : ("ok" as const),
    score: rd.score,
    checkedAt: new Date().toISOString(),
    failing: failing.map((r) => ({ id: r.id, label: r.label, summary: r.summary })),
    warnings: results.filter((r) => r.status === "warn").map((r) => r.id),
  };
}

/* ───────────────────────── جاروب زمان‌بندی‌شده و هشدار ───────────────────────── */

async function sweepContext(): Promise<CheckContext> {
  let workspaceId = 0;
  try {
    workspaceId = ((await db.execute(sql`select id from workspaces order by id limit 1`)).rows[0] as { id: number } | undefined)?.id ?? 0;
  } catch {
    workspaceId = 0;
  }
  return { workspaceId, origin: trustedAppOrigin() };
}

const gs = globalThis as typeof globalThis & { __healthSweeping?: boolean };

/**
 * از زمان‌بند داخلی هر چند دقیقه اجرا می‌شود: همه‌ی بررسی‌های سبک را اجرا و ثبت می‌کند،
 * رخدادهای پایدار (حداقل ۵ دقیقه باز) را به مدیران کل ایمیل می‌کند و بازیابی را هم اطلاع می‌دهد.
 */
export async function runHealthSweep(): Promise<{ checked: number; alerts: number }> {
  if (gs.__healthSweeping) return { checked: 0, alerts: 0 };
  gs.__healthSweeping = true;
  try {
    const ctx = await sweepContext();
    const results = await runChecks(ctx, { force: true, record: true });
    let alerts = 0;
    // اگر خود ایمیل خراب است، هشدار ایمیلی بی‌معناست (در صندوق ارتباطات ثبت می‌شود)
    const open = (await db.execute(sql`select id, check_id, label, message, started_at from health_incidents where resolved_at is null and alerted_at is null and started_at < now() - interval '5 minutes' and check_id <> 'email'`)).rows as { id: number; check_id: string; label: string; message: string; started_at: Date }[];
    const recovered = (await db.execute(sql`select id, label, started_at, resolved_at from health_incidents where resolved_at is not null and alerted_at is not null and recovery_alerted_at is null and resolved_at > now() - interval '2 days'`)).rows as { id: number; label: string; started_at: Date; resolved_at: Date }[];
    const to = await platformAdminEmails().catch(() => [] as string[]);
    const site = trustedAppOrigin();
    const link = site ? `<p><a href="${escapeHtml(site)}/platform/health">باز کردن داشبورد سلامت سیستم</a></p>` : "";
    if (to.length && open.length) {
      const html = `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:1.9"><h3>⚠️ ${open.length} سرویس دچار مشکل است</h3><ul>${open.map((o) => `<li><b>${escapeHtml(o.label)}</b> — ${escapeHtml(o.message)} <small>(از ${escapeHtml(ageText(Date.now() - new Date(o.started_at).getTime()))} پیش)</small></li>`).join("")}</ul>${link}</div>`;
      for (const addr of to) await sendMail({ to: addr, subject: `[سلامت سیستم] ${open.length} سرویس دچار مشکل شد`, html, workspaceId: 0 }).catch(() => undefined);
      await db.execute(sql`update health_incidents set alerted_at = now() where id in (${sql.join(open.map((o) => sql`${o.id}`), sql`, `)})`);
      alerts += open.length;
    } else if (open.length) {
      await db.execute(sql`update health_incidents set alerted_at = now() where id in (${sql.join(open.map((o) => sql`${o.id}`), sql`, `)})`);
    }
    if (to.length && recovered.length) {
      const html = `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:1.9"><h3>✅ ${recovered.length} سرویس به حالت عادی برگشت</h3><ul>${recovered.map((o) => `<li><b>${escapeHtml(o.label)}</b> — مدت قطعی: ${escapeHtml(ageText(new Date(o.resolved_at).getTime() - new Date(o.started_at).getTime()))}</li>`).join("")}</ul>${link}</div>`;
      for (const addr of to) await sendMail({ to: addr, subject: `[سلامت سیستم] ${recovered.length} سرویس بازیابی شد`, html, workspaceId: 0 }).catch(() => undefined);
    }
    if (recovered.length) await db.execute(sql`update health_incidents set recovery_alerted_at = now() where id in (${sql.join(recovered.map((o) => sql`${o.id}`), sql`, `)})`);
    // نگهداری: نمونه‌ها ۱۴ روز، رخدادهای بسته‌شده ۹۰ روز
    await db.execute(sql`delete from health_checks where created_at < now() - interval '14 days'`);
    await db.execute(sql`delete from health_incidents where resolved_at is not null and resolved_at < now() - interval '90 days'`);
    return { checked: results.length, alerts };
  } finally {
    gs.__healthSweeping = false;
  }
}

/** ثبت در لاگ ممیزی هنگام اجرای دستی ابزارها */
export async function auditHealthAction(userId: number, action: string, detail: string) {
  await logAudit({ workspaceId: 0, userId, action, detail }).catch(() => undefined);
}
