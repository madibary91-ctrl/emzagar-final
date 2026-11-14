/**
 * هسته‌ی شبیه‌ساز: انواع، وضعیت (State)، موتور سناریو و خطاهای سطح شبکه که برای هر سه سرویس مشترک‌اند.
 * این پوشه هیچ وابستگی‌ای به کد برنامه ندارد و فقط از ماژول‌های داخلی Node استفاده می‌کند.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type ServiceId = "zarinpal" | "kavenegar" | "melipayamak" | "gapgpt";
export const SERVICE_IDS: readonly ServiceId[] = ["zarinpal", "kavenegar", "melipayamak", "gapgpt"];
export const SERVICE_LABELS: Record<ServiceId, string> = {
  zarinpal: "درگاه پرداخت زرین‌پال",
  kavenegar: "پنل پیامک کاوه‌نگار",
  melipayamak: "پنل پیامک ملی‌پیامک",
  gapgpt: "هوش مصنوعی GapGPT",
};
export const isServiceId = (v: string): v is ServiceId => (SERVICE_IDS as readonly string[]).includes(v);

export interface ScenarioInfo {
  id: string;
  title: string;
  description: string;
  group: "success" | "error" | "network" | "stateful";
  /** فازهایی که این سناریو در آن‌ها اثر دارد (خالی = همه) */
  phases?: string[];
  /** نام پارامتر اختیاری/اجباری بعد از «:» */
  arg?: string;
}

export interface QueueItem {
  scenario: string;
  remaining: number;
}
export interface ServiceState {
  scenario: string;
  latencyMs: number;
  queue: QueueItem[];
  calls: number;
}

export interface Payment {
  authority: string;
  merchantId: string;
  /** ریال */
  amount: number;
  callbackUrl: string;
  description: string;
  status: "pending" | "paid" | "canceled" | "failed";
  createdAt: string;
  paidAt?: string;
  verifiedAt?: string;
  refId?: number;
  cardPan?: string;
  verifyCalls: number;
}

export interface SmsRecord {
  id: number;
  messageId: number;
  provider: "kavenegar" | "melipayamak";
  kind: "send" | "lookup";
  to: string;
  text: string;
  token?: string;
  template?: string;
  sender: string;
  at: string;
  delivery: "queued" | "delivered" | "failed";
  /** کد تایید استخراج‌شده (token یا اولین عدد ۴ تا ۸ رقمی متن) */
  code?: string;
}

export interface LoggedRequest {
  id: number;
  at: string;
  service: ServiceId;
  phase: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  scenario: string;
  source: string;
  status: number;
  durationMs: number;
  note?: string;
}

export interface SimSettings {
  /** auto: صفحه‌ی پرداخت بلافاصله «پرداخت موفق» را برمی‌گرداند. manual: کاربر/ربات روی دکمه کلیک می‌کند */
  startPay: "auto" | "manual";
}

export interface SimOptions {
  startPay?: "auto" | "manual";
  seed?: number;
  /** سقف تعداد درخواست‌های نگه‌داری‌شده در لاگ */
  logLimit?: number;
}

export class SimState {
  services = {} as Record<ServiceId, ServiceState>;
  log: LoggedRequest[] = [];
  payments = new Map<string, Payment>();
  sms: SmsRecord[] = [];
  settings: SimSettings;
  seed: number;
  logLimit: number;
  kavenegarCredit = 1000;
  melipayamakCredit = 1000;
  /** اگر خالی نباشد، فقط همین قالب‌ها در verify/lookup کاوه‌نگار پذیرفته می‌شود (وگرنه خطای ۴۲۴) */
  kavenegarTemplates: string[] = [];
  aiWindows = new Map<string, number[]>();
  private seq = 0;
  private rng: number;
  private counters = new Map<string, number>();

  constructor(opts: SimOptions = {}) {
    this.settings = { startPay: opts.startPay ?? "manual" };
    this.seed = opts.seed ?? 1;
    this.rng = this.seed >>> 0;
    this.logLimit = opts.logLimit ?? 2000;
    for (const id of SERVICE_IDS) this.services[id] = { scenario: "success", latencyMs: 0, queue: [], calls: 0 };
  }

  nextId(): number {
    return ++this.seq;
  }

  /** شمارنده‌ی نام‌دار (برای شناسه‌های قابل‌پیش‌بینی مثل authority و ref_id) */
  counter(name: string, start = 0): number {
    const n = (this.counters.get(name) ?? start) + 1;
    this.counters.set(name, n);
    return n;
  }

  /** مولد تصادفی قطعی (mulberry32): با seed یکسان، آشوب (chaos) هر بار دقیقاً تکرار می‌شود */
  random(): number {
    this.rng = (this.rng + 0x6d2b79f5) >>> 0;
    let t = this.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  setSeed(seed: number) {
    this.seed = seed;
    this.rng = seed >>> 0;
  }

  reset(service?: ServiceId) {
    const ids = service ? [service] : SERVICE_IDS;
    for (const id of ids) this.services[id] = { scenario: "success", latencyMs: 0, queue: [], calls: 0 };
    if (!service) {
      this.log = [];
      this.payments.clear();
      this.sms = [];
      this.kavenegarCredit = 1000;
      this.melipayamakCredit = 1000;
      this.kavenegarTemplates = [];
      this.aiWindows.clear();
      this.counters.clear();
      this.rng = this.seed >>> 0;
      return;
    }
    this.log = this.log.filter((l) => l.service !== service);
    if (service === "zarinpal") this.payments.clear();
    if (service === "kavenegar") {
      this.sms = this.sms.filter((s) => s.provider !== "kavenegar");
      this.kavenegarCredit = 1000;
      this.kavenegarTemplates = [];
    }
    if (service === "melipayamak") {
      this.sms = this.sms.filter((s) => s.provider !== "melipayamak");
      this.melipayamakCredit = 1000;
    }
    if (service === "gapgpt") this.aiWindows.clear();
  }

  pushLog(entry: Omit<LoggedRequest, "id">): LoggedRequest {
    const row: LoggedRequest = { id: this.nextId(), ...entry };
    this.log.push(row);
    if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit);
    return row;
  }
}

/* ───────── زمینه‌ی درخواست ───────── */

export interface Ctx {
  sim: SimState;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  rawBody: string;
  /** پارامترهای query و بدنه (JSON یا فرم) ادغام‌شده */
  params: Record<string, unknown>;
  service: ServiceId;
  phase: string;
  scenario: string;
  arg?: string;
  note?: string;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function sendText(ctx: Ctx, status: number, body: string, contentType = "text/plain; charset=utf-8", headers: Record<string, string> = {}) {
  if (ctx.res.headersSent) return;
  ctx.res.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...headers });
  ctx.res.end(body);
}

export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}) {
  sendText(ctx, status, JSON.stringify(body), "application/json; charset=utf-8", headers);
}

export function sendHtml(ctx: Ctx, status: number, body: string) {
  sendText(ctx, status, body, "text/html; charset=utf-8");
}

export function redirectTo(ctx: Ctx, location: string, status = 302) {
  if (ctx.res.headersSent) return;
  ctx.res.writeHead(status, { Location: location, "Cache-Control": "no-store", "Content-Length": 0 });
  ctx.res.end();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/* ───────── موتور سناریو ───────── */

export interface Parsed {
  phase?: string;
  name: string;
  arg?: string;
}

/** «verify@network_error» یا «slow:3000» یا «chaos:30» */
export function parseScenario(raw: string): Parsed {
  let s = raw.trim();
  let phase: string | undefined;
  const at = s.indexOf("@");
  if (at > 0) {
    phase = s.slice(0, at);
    s = s.slice(at + 1);
  }
  const c = s.indexOf(":");
  return c > 0 ? { phase, name: s.slice(0, c), arg: s.slice(c + 1) } : { phase, name: s || "success" };
}

export interface Picked {
  parsed: Parsed;
  raw: string;
  source: "header" | "magic-key" | "queue" | "default";
}

const appliesTo = (p: Parsed, phase: string) => !p.phase || p.phase === phase;

/**
 * اولویت: هدر x-sim-scenario ← «کلید جادویی» (پسوند ‎~سناریو‎ در API key/رمز) ← صف (اولین مورد مناسب این فاز) ← سناریوی پیش‌فرض سرویس
 * سناریوی دارای پیشوند فاز (مثل verify@service_down) فقط روی همان فاز اثر دارد و در سایر فازها موفقیت است.
 */
export function pickScenario(sim: SimState, service: ServiceId, phase: string, header?: string | null, magic?: string | null): Picked {
  const st = sim.services[service];
  st.calls++;
  let raw = "";
  let source: Picked["source"] = "default";
  if (header) {
    raw = header;
    source = "header";
  } else if (magic) {
    raw = magic;
    source = "magic-key";
  } else {
    const idx = st.queue.findIndex((q) => appliesTo(parseScenario(q.scenario), phase));
    if (idx >= 0) {
      raw = st.queue[idx].scenario;
      source = "queue";
      st.queue[idx].remaining -= 1;
      if (st.queue[idx].remaining <= 0) st.queue.splice(idx, 1);
    }
  }
  if (!raw) raw = st.scenario;
  let parsed = parseScenario(raw);
  if (!appliesTo(parsed, phase)) parsed = { name: "success" };
  return { parsed, raw, source };
}

/** سناریوهای فرادستوری (chaos/flaky/nth) را به یک سناریوی مشخص تبدیل می‌کند */
export function expandMeta(sim: SimState, service: ServiceId, p: Parsed, faults: readonly string[]): Parsed {
  const pct = Number(p.arg);
  if (p.name === "chaos") {
    const pool = [...faults, ...TRANSPORT_FAULTS];
    return sim.random() * 100 < (Number.isFinite(pct) ? pct : 30) ? { name: pool[Math.floor(sim.random() * pool.length)] } : { name: "success" };
  }
  if (p.name === "flaky") {
    return sim.random() * 100 < (Number.isFinite(pct) ? pct : 30) ? { name: TRANSPORT_FAULTS[Math.floor(sim.random() * TRANSPORT_FAULTS.length)] } : { name: "success" };
  }
  if (p.name === "nth") {
    const n = Math.max(2, Math.floor(pct) || 3);
    return sim.services[service].calls % n === 0 ? { name: "service_down" } : { name: "success" };
  }
  return p;
}

/* ───────── خطاهای سطح شبکه (برای همه‌ی سرویس‌ها) ───────── */

/** خطاهایی که در chaos/flaky به‌طور تصادفی انتخاب می‌شوند (timeout عمداً نیست تا آزمون‌ها معلق نمانند) */
export const TRANSPORT_FAULTS = ["network_error", "service_down", "bad_gateway", "garbage_response", "empty_response", "truncated_response"] as const;

export const TRANSPORT_SCENARIOS: ScenarioInfo[] = [
  { id: "network_error", title: "قطع اتصال (ECONNRESET)", description: "سوکت بدون هیچ پاسخی بسته می‌شود؛ مثل قطع اینترنت یا ریست‌شدن اتصال.", group: "network" },
  { id: "timeout", title: "بی‌پاسخ ماندن (Timeout)", description: "اتصال باز می‌ماند و پاسخی نمی‌آید تا کلاینت مهلتش را تمام کند. پارامتر اختیاری: timeout:میلی‌ثانیه (پیش‌فرض ۲ دقیقه).", group: "network", arg: "ms" },
  { id: "service_down", title: "قطعی سرویس (HTTP 503)", description: "پاسخ ۵۰۳ با صفحه‌ی HTML (مثل صفحه‌ی تعمیر nginx).", group: "network" },
  { id: "bad_gateway", title: "Bad Gateway (HTTP 502)", description: "پاسخ ۵۰۲ از پروکسی بالادستی.", group: "network" },
  { id: "garbage_response", title: "پاسخ ۲۰۰ ولی غیر JSON", description: "بدنه‌ی HTML به‌جای JSON (مثل صفحه‌ی ورود اجباری شبکه یا خطای WAF).", group: "network" },
  { id: "empty_response", title: "پاسخ خالی", description: "HTTP 200 با بدنه‌ی خالی.", group: "network" },
  { id: "truncated_response", title: "پاسخ ناقص", description: "نیمه‌ی JSON ارسال و سپس اتصال قطع می‌شود.", group: "network" },
  { id: "redirect", title: "ریدایرکت مشکوک", description: "پاسخ 302 به یک دامنه‌ی خارجی (برنامه باید ریدایرکت‌ها را دنبال نکند).", group: "network" },
  { id: "slow", title: "پاسخ کند ولی موفق", description: "پس از تاخیر مشخص، پاسخ موفق می‌دهد. مثال: slow:3000", group: "network", arg: "ms" },
  { id: "flaky", title: "ناپایدار (احتمالی)", description: "با احتمال مشخص (درصد) یکی از خطاهای شبکه رخ می‌دهد. مثال: flaky:40", group: "stateful", arg: "درصد" },
  { id: "nth", title: "هر N‌امین درخواست خراب", description: "هر N‌امین درخواست ۵۰۳ می‌شود، بقیه موفق. مثال: nth:3", group: "stateful", arg: "N" },
  { id: "chaos", title: "آشوب (Chaos)", description: "با احتمال مشخص، یکی از همه‌ی خطاهای ممکن سرویس به‌صورت تصادفی (ولی با seed ثابت و قابل‌تکرار) رخ می‌دهد. مثال: chaos:30", group: "stateful", arg: "درصد" },
];

/** اعمال خطای شبکه. اگر پاسخ داده شد true برمی‌گرداند (یعنی دیگر handler اصلی اجرا نشود) */
export async function applyTransport(ctx: Ctx, name: string, arg?: string): Promise<boolean> {
  const { res, req } = ctx;
  switch (name) {
    case "slow": {
      await sleep(Math.min(Math.max(Number(arg) || 2000, 0), 120_000));
      return false;
    }
    case "network_error":
      req.socket.destroy();
      return true;
    case "timeout": {
      const ms = Math.min(Math.max(Number(arg) || 120_000, 100), 600_000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
        res.on("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (!res.writableEnded) req.socket.destroy();
      return true;
    }
    case "service_down":
      sendText(ctx, 503, "<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>", "text/html; charset=utf-8", { "Retry-After": "30" });
      return true;
    case "bad_gateway":
      sendText(ctx, 502, "<html><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>", "text/html; charset=utf-8");
      return true;
    case "garbage_response":
      sendText(ctx, 200, "<!doctype html><html><body><h1>سایت در حال تعمیر است</h1><p>Maintenance mode</p></body></html>", "text/html; charset=utf-8");
      return true;
    case "empty_response":
      sendText(ctx, 200, "", "application/json; charset=utf-8");
      return true;
    case "truncated_response":
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": 600 });
      res.write('{"data":{"code":100,"message":"Succ');
      setTimeout(() => req.socket.destroy(), 20);
      return true;
    case "redirect":
      redirectTo(ctx, "https://evil.example.invalid/phish", 302);
      return true;
    default:
      return false;
  }
}

/** استخراج کلید جادویی: «KEY~سناریو» ← { key: "KEY", magic: "سناریو" } */
export function splitMagic(credential: string): { key: string; magic: string | null } {
  const i = credential.indexOf("~");
  if (i < 0) return { key: credential, magic: null };
  return { key: credential.slice(0, i), magic: credential.slice(i + 1) || null };
}

/* ───────── قرارداد ماژول سرویس ───────── */

export interface Route {
  /** نام فاز (مثل request/verify/send/chat) برای سناریوهای فاز-محدود */
  phase: string;
  run: (ctx: Ctx) => Promise<void> | void;
  /** مشخصات اعتبارسنجی (API key/رمز) که ممکن است «کلید جادویی» (~سناریو) داشته باشد */
  credential?: (ctx: Ctx) => string;
  /** اگر true باشد موتور سناریو دور زده می‌شود (مثلاً کلیک کاربر روی صفحه‌ی پرداخت) */
  raw?: boolean;
}

export interface ServiceModule {
  id: ServiceId;
  /** فهرست سناریوهای اختصاصی سرویس (برای مستندات، داشبورد و /__sim/scenarios) */
  scenarios: ScenarioInfo[];
  /** سناریوهای خطا که در chaos به‌طور تصادفی انتخاب می‌شوند */
  faults: readonly string[];
  route(method: string, path: string): Route | null;
}
