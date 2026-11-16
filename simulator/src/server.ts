/**
 * سرور شبیه‌ساز: مسیریابی به ماژول‌های سرویس، اعمال موتور سناریو، ثبت لاگ و پنل کنترل.
 * هم از خط فرمان (simulator/cli.ts) و هم مستقیماً در تست‌ها (startSimulator) قابل استفاده است.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SimState, applyTransport, expandMeta, pickScenario, sendJson, sleep, splitMagic } from "./core";
import type { Ctx, LoggedRequest, ServiceId, ServiceModule, SimOptions } from "./core";
import { handleControl } from "./control";
import { gapgpt } from "./gapgpt";
import { kavenegar } from "./kavenegar";
import { melipayamak } from "./melipayamak";
import { zarinpal } from "./zarinpal";

export const MODULES: ServiceModule[] = [zarinpal, kavenegar, melipayamak, gapgpt];

export interface StartOptions extends SimOptions {
  port?: number;
  host?: string;
  /** اگر داده شود، پنل کنترل فقط با هدر x-sim-token کار می‌کند */
  token?: string;
  quiet?: boolean;
}

export interface SimHandle {
  url: string;
  host: string;
  port: number;
  state: SimState;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function parseParams(url: URL, raw: string, contentType: string): { params: Record<string, unknown>; body: unknown } {
  const params: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => (params[k] = v));
  let body: unknown = raw.length > 4000 ? raw.slice(0, 4000) + "…" : raw || null;
  const trimmed = raw.trim();
  if (/json/i.test(contentType) || trimmed.startsWith("{")) {
    try {
      const j: unknown = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) Object.assign(params, j);
      body = j;
    } catch {
      /* بدنه‌ی نامعتبر: به‌صورت متن لاگ می‌شود */
    }
  } else if (/x-www-form-urlencoded/i.test(contentType) && raw) {
    new URLSearchParams(raw).forEach((v, k) => (params[k] = v));
  }
  return { params, body };
}

const SLOW_OR_TRANSPORT = new Set(["slow", "network_error", "timeout", "service_down", "bad_gateway", "garbage_response", "empty_response", "truncated_response", "redirect"]);

export async function startSimulator(opts: StartOptions = {}): Promise<SimHandle> {
  const sim = new SimState(opts);
  const startedAt = Date.now();
  const log = (m: string) => {
    if (!opts.quiet) console.log(m);
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://sim.local");
        const method = (req.method ?? "GET").toUpperCase();
        const raw = await readBody(req);
        if (await handleControl(sim, MODULES, req, res, url, raw, { token: opts.token, startedAt })) return;

        const mod = MODULES.find((m) => url.pathname === `/${m.id}` || url.pathname.startsWith(`/${m.id}/`));
        const route = mod?.route(method, url.pathname) ?? null;
        if (!mod || !route) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: `مسیر در شبیه‌ساز پیاده‌سازی نشده است: ${method} ${url.pathname}`, hint: "فهرست مسیرها: docs/SIMULATOR-FA.md" }));
          log(`⚠️  404 ${method} ${url.pathname}`);
          return;
        }

        const { params, body } = parseParams(url, raw, String(req.headers["content-type"] ?? ""));
        const ctx: Ctx = { sim, req, res, url, method, rawBody: raw, params, service: mod.id as ServiceId, phase: route.phase, scenario: "success" };

        let picked = { parsed: { name: "success" } as { name: string; arg?: string }, raw: "success", source: "default" as string };
        if (!route.raw) {
          const magic = route.credential ? splitMagic(route.credential(ctx)).magic : null;
          const hdr = req.headers["x-sim-scenario"];
          const p = pickScenario(sim, mod.id, route.phase, typeof hdr === "string" ? hdr : null, magic);
          const expanded = expandMeta(sim, mod.id, p.parsed, mod.faults);
          picked = { parsed: expanded, raw: p.raw, source: p.source };
        }

        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v).slice(0, 200);
        const entry: LoggedRequest = sim.pushLog({
          at: new Date().toISOString(),
          service: mod.id,
          phase: route.phase,
          method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers,
          body,
          scenario: picked.raw,
          source: picked.source,
          status: 0,
          durationMs: 0,
        });
        const t0 = Date.now();
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          entry.status = res.headersSent ? res.statusCode : 0;
          entry.durationMs = Date.now() - t0;
          entry.note = ctx.note ?? (res.headersSent ? undefined : "connection dropped");
          log(`${entry.status >= 400 || entry.status === 0 ? "✖" : "✔"} ${mod.id}/${route.phase} [${entry.scenario}] → ${entry.status || "dropped"} ${entry.durationMs}ms${entry.note ? " · " + entry.note : ""}`);
        };
        res.once("finish", done);
        res.once("close", done);

        const name = picked.parsed.name;
        ctx.scenario = name === "slow" ? "success" : name;
        ctx.arg = picked.parsed.arg;
        const latency = sim.services[mod.id].latencyMs;
        if (latency > 0) await sleep(latency);
        if (SLOW_OR_TRANSPORT.has(name) && (await applyTransport(ctx, name, picked.parsed.arg))) return;
        await route.run(ctx);
      } catch (e) {
        if (!res.headersSent) sendJson({ res } as Ctx, 500, { error: "خطای داخلی شبیه‌ساز", detail: e instanceof Error ? e.message : String(e) });
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 5_000;

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`,
    host,
    port,
    state: sim,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
