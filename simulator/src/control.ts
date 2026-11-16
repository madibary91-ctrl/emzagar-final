/**
 * پنل کنترل شبیه‌ساز (JSON API زیر /__sim). ربات تست با آن سناریوها را تنظیم و نتیجه را بررسی می‌کند.
 * مستندات کامل: docs/SIMULATOR-FA.md
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { SERVICE_IDS, SERVICE_LABELS, TRANSPORT_SCENARIOS, isServiceId, parseScenario } from "./core";
import type { ServiceId, ServiceModule, SimState } from "./core";
import { settlePayment } from "./zarinpal";
import { dashboardHtml } from "./ui";

export const PRESETS: Record<string, { title: string; description: string; scenarios: Partial<Record<ServiceId, string>> }> = {
  happy: { title: "همه چیز سالم", description: "همه‌ی سرویس‌ها موفق (بازگشت به حالت عادی)", scenarios: {} },
  "total-outage": { title: "قطعی کامل", description: "هر سه سرویس 503 می‌دهند", scenarios: { zarinpal: "service_down", kavenegar: "service_down", melipayamak: "service_down", gapgpt: "service_down" } },
  "network-chaos": { title: "آشوب شبکه", description: "با احتمال ۳۰٪ هر درخواست به یکی از خطاهای ممکن می‌خورد (قابل‌تکرار با seed)", scenarios: { zarinpal: "chaos:30", kavenegar: "chaos:30", melipayamak: "chaos:30", gapgpt: "chaos:30" } },
  flaky: { title: "اینترنت ناپایدار", description: "با احتمال ۴۰٪ خطای شبکه", scenarios: { zarinpal: "flaky:40", kavenegar: "flaky:40", melipayamak: "flaky:40", gapgpt: "flaky:40" } },
  slow: { title: "همه‌چیز کند", description: "هر پاسخ ۳ ثانیه تاخیر دارد", scenarios: { zarinpal: "slow:3000", kavenegar: "slow:3000", melipayamak: "slow:3000", gapgpt: "slow:3000" } },
  "payments-down": { title: "درگاه پرداخت قطع", description: "فقط زرین‌پال 503", scenarios: { zarinpal: "service_down" } },
  "verify-outage": { title: "قطعی فقط هنگام تایید پرداخت", description: "پرداخت شروع می‌شود ولی verify شکست می‌خورد (سخت‌ترین حالت برای حسابداری)", scenarios: { zarinpal: "verify@service_down" } },
  "no-sms-credit": { title: "اتمام اعتبار پیامک", description: "کاوه‌نگار ۴۱۸ و ملی‌پیامک Value=2", scenarios: { kavenegar: "insufficient_credit", melipayamak: "insufficient_credit" } },
  "ai-rate-limited": { title: "محدودیت نرخ هوش مصنوعی", description: "GapGPT 429", scenarios: { gapgpt: "rate_limit" } },
  "ai-hostile": { title: "هوش مصنوعی مخرب", description: "خروجی حاوی XSS", scenarios: { gapgpt: "xss_payload" } },
};

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

function parseObj(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function catalog(modules: ServiceModule[]) {
  const out: Record<string, { label: string; scenarios: unknown[] }> = {};
  for (const m of modules) out[m.id] = { label: SERVICE_LABELS[m.id], scenarios: [...m.scenarios, ...TRANSPORT_SCENARIOS] };
  return out;
}

function validScenario(modules: ServiceModule[], service: ServiceId, raw: string): string | null {
  const name = parseScenario(raw).name;
  const mod = modules.find((m) => m.id === service);
  const ids = new Set([...(mod?.scenarios ?? []), ...TRANSPORT_SCENARIOS].map((s) => s.id));
  return ids.has(name) ? null : `سناریوی «${name}» برای ${service} وجود ندارد. گزینه‌ها: ${[...ids].join(", ")}`;
}

export interface ControlOpts {
  token?: string;
  startedAt: number;
}

/** اگر مسیر متعلق به پنل کنترل بود true برمی‌گرداند */
export async function handleControl(sim: SimState, modules: ServiceModule[], req: IncomingMessage, res: ServerResponse, url: URL, raw: string, opts: ControlOpts): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/" && !path.startsWith("/__sim")) return false;
  const method = (req.method ?? "GET").toUpperCase();

  if (path === "/" || path === "/__sim" || path === "/__sim/ui") {
    const html = dashboardHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Cache-Control": "no-store" });
    res.end(html);
    return true;
  }
  if (path === "/__sim/health") {
    json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000), services: SERVICE_IDS });
    return true;
  }
  if (opts.token) {
    const given = req.headers["x-sim-token"] ?? url.searchParams.get("token");
    if (given !== opts.token) {
      json(res, 401, { error: "توکن شبیه‌ساز نامعتبر است (هدر x-sim-token)" });
      return true;
    }
  }

  const body = parseObj(raw);
  const seg = path.split("/").slice(2); // بعد از /__sim
  const bad = (message: string, status = 400) => json(res, status, { error: message });
  const svcOf = (name: string | undefined): ServiceId | null => (name && isServiceId(name) ? name : null);

  if (method === "GET" && seg[0] === "state") {
    json(res, 200, {
      services: sim.services,
      settings: sim.settings,
      seed: sim.seed,
      counts: { requests: sim.log.length, payments: sim.payments.size, sms: sim.sms.length },
      credit: { kavenegar: sim.kavenegarCredit, melipayamak: sim.melipayamakCredit },
      kavenegarTemplates: sim.kavenegarTemplates,
    });
    return true;
  }
  if (method === "GET" && seg[0] === "scenarios") {
    json(res, 200, { services: catalog(modules), presets: Object.entries(PRESETS).map(([id, p]) => ({ id, title: p.title, description: p.description, scenarios: p.scenarios })) });
    return true;
  }

  if ((method === "PUT" || method === "POST") && seg[0] === "scenario") {
    const svc = svcOf(seg[1]);
    if (!svc) return bad("نام سرویس نامعتبر است"), true;
    const scenario = typeof body.scenario === "string" ? body.scenario : "success";
    const err = validScenario(modules, svc, scenario);
    if (err) return bad(err), true;
    sim.services[svc].scenario = scenario;
    if (body.latencyMs !== undefined) sim.services[svc].latencyMs = Math.max(0, Math.min(120_000, Number(body.latencyMs) || 0));
    json(res, 200, { ok: true, service: svc, state: sim.services[svc] });
    return true;
  }

  if (seg[0] === "queue") {
    const svc = svcOf(seg[1]);
    if (!svc) return bad("نام سرویس نامعتبر است"), true;
    if (method === "DELETE") {
      sim.services[svc].queue = [];
      json(res, 200, { ok: true });
      return true;
    }
    if (method === "POST" || method === "PUT") {
      const items: { scenario: string; remaining: number }[] = [];
      if (Array.isArray(body.scenarios)) for (const s of body.scenarios) items.push({ scenario: String(s), remaining: 1 });
      else if (typeof body.scenario === "string") items.push({ scenario: body.scenario, remaining: Math.max(1, Math.min(1000, Number(body.times) || 1)) });
      if (items.length === 0) return bad("scenarios (آرایه) یا scenario (+times) لازم است"), true;
      for (const it of items) {
        const err = validScenario(modules, svc, it.scenario);
        if (err) return bad(err), true;
      }
      sim.services[svc].queue.push(...items);
      json(res, 200, { ok: true, queue: sim.services[svc].queue });
      return true;
    }
  }

  if (method === "POST" && seg[0] === "reset") {
    const q = url.searchParams.get("service");
    if (q && !isServiceId(q)) return bad("نام سرویس نامعتبر است"), true;
    sim.reset(q && isServiceId(q) ? q : undefined);
    json(res, 200, { ok: true });
    return true;
  }

  if (seg[0] === "requests") {
    if (method === "DELETE") {
      sim.log = [];
      json(res, 200, { ok: true });
      return true;
    }
    if (method === "GET") {
      const svc = url.searchParams.get("service");
      const phase = url.searchParams.get("phase");
      const since = Number(url.searchParams.get("since")) || 0;
      const limit = Math.min(1000, Number(url.searchParams.get("limit")) || 200);
      const rows = sim.log.filter((l) => l.id > since && (!svc || l.service === svc) && (!phase || l.phase === phase)).slice(-limit);
      json(res, 200, { total: rows.length, requests: rows });
      return true;
    }
  }

  if (method === "GET" && seg[0] === "sms") {
    const to = url.searchParams.get("to");
    const provider = url.searchParams.get("provider");
    const rows = sim.sms.filter((s) => (!to || s.to === to) && (!provider || s.provider === provider));
    if (seg[1] === "last") {
      const last = rows[rows.length - 1];
      if (!last) return bad("پیامکی پیدا نشد", 404), true;
      json(res, 200, { sms: last, code: last.code ?? null });
      return true;
    }
    json(res, 200, { total: rows.length, sms: rows.slice(-Math.min(500, Number(url.searchParams.get("limit")) || 100)) });
    return true;
  }

  if ((method === "PUT" || method === "POST") && (seg[0] === "kavenegar" || seg[0] === "melipayamak") && seg[1] === "credit") {
    const v = Number(body.value);
    if (!Number.isFinite(v)) return bad("value عددی لازم است"), true;
    if (seg[0] === "kavenegar") sim.kavenegarCredit = v;
    else sim.melipayamakCredit = v;
    json(res, 200, { ok: true, credit: v });
    return true;
  }
  if ((method === "PUT" || method === "POST") && seg[0] === "kavenegar" && seg[1] === "templates") {
    sim.kavenegarTemplates = Array.isArray(body.names) ? body.names.map(String) : [];
    json(res, 200, { ok: true, templates: sim.kavenegarTemplates });
    return true;
  }

  if (seg[0] === "zarinpal" && seg[1] === "payments") {
    if (method === "GET" && !seg[2]) {
      json(res, 200, { total: sim.payments.size, payments: [...sim.payments.values()] });
      return true;
    }
    if (method === "GET" && seg[2]) {
      const p = sim.payments.get(decodeURIComponent(seg[2]));
      if (!p) return bad("تراکنش پیدا نشد", 404), true;
      json(res, 200, p);
      return true;
    }
    if (method === "POST" && seg[2] && seg[3] === "settle") {
      const p = sim.payments.get(decodeURIComponent(seg[2]));
      if (!p) return bad("تراکنش پیدا نشد", 404), true;
      const o = String(body.outcome ?? "success");
      const outcome = o === "cancel" || o === "fail" || o === "fake_ok" ? o : "success";
      const callbackUrl = settlePayment(p, outcome);
      let followed: { status: number; location: string | null } | undefined;
      if (body.follow === true) {
        try {
          const r = await fetch(callbackUrl, { redirect: "manual" });
          followed = { status: r.status, location: r.headers.get("location") };
        } catch (e) {
          followed = { status: 0, location: e instanceof Error ? e.message : "error" };
        }
      }
      json(res, 200, { ok: true, status: p.status, callbackUrl, followed });
      return true;
    }
  }

  if ((method === "PUT" || method === "POST") && seg[0] === "settings") {
    if (body.startPay === "auto" || body.startPay === "manual") sim.settings.startPay = body.startPay;
    if (body.seed !== undefined && Number.isFinite(Number(body.seed))) sim.setSeed(Number(body.seed));
    json(res, 200, { ok: true, settings: sim.settings, seed: sim.seed });
    return true;
  }

  if (method === "POST" && seg[0] === "preset") {
    const preset = PRESETS[seg[1] ?? ""];
    if (!preset) return bad(`پیش‌تنظیم نامعتبر. گزینه‌ها: ${Object.keys(PRESETS).join(", ")}`), true;
    for (const id of SERVICE_IDS) {
      sim.services[id].scenario = preset.scenarios[id] ?? "success";
      sim.services[id].queue = [];
      sim.services[id].latencyMs = 0;
    }
    json(res, 200, { ok: true, preset: seg[1], services: sim.services });
    return true;
  }

  json(res, 404, { error: `مسیر کنترل ناشناخته: ${method} ${path}` });
  return true;
}
