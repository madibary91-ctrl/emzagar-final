import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

/**
 * ───────────── محافظت در برابر SSRF (شامل DNS Rebinding) ─────────────
 *
 * بررسی «یک‌بار resolve و بعد fetch» ذاتاً ناامن است: fetch دوباره DNS را می‌پرسد و مهاجم با TTL=0
 * می‌تواند بین دو پرسش از IP عمومی به 127.0.0.1 بپرد (TOCTOU).
 *
 * راه‌حل: `safeFetch` اتصال TCP را با یک تابع lookup «نگهبان» می‌سازد؛ همان resolve که سوکت واقعاً
 * با آن وصل می‌شود، در لحظه‌ی اتصال اعتبارسنجی می‌شود و اگر حتی یکی از آدرس‌ها داخلی باشد اتصال
 * برقرار نمی‌شود. بنابراین بین «بررسی» و «استفاده» هیچ فاصله‌ای نیست و rebinding بی‌اثر است.
 * `assertSafeUrl` فقط برای بازخورد زودهنگام و پیام خطای قابل‌فهم به کاربر است، نه مرز امنیتی.
 */

export class SsrfError extends Error {
  code = "ESSRF";
  constructor(message = "آدرس داخلی مجاز نیست") {
    super(message);
    this.name = "SsrfError";
  }
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of [
  ["::", 96], // شامل :: ، ::1 و IPv4-compatible
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(net6, prefix, "ipv6");

/** IPv6 را به ۸ گروه ۱۶بیتی باز می‌کند (پشتیبانی از «::» و دم نقطه‌دار IPv4)؛ نامعتبر ← null */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (tail) {
    const o = tail.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null;
    s = s.slice(0, tail.index) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...new Array<number>(fill).fill(0), ...rest];
  return all.length === 8 && all.every((n) => Number.isInteger(n)) ? all : null;
}

/**
 * آیا آدرس IP داخلی/خصوصی/رزرو است؟ ورودی نامعتبر هم «غیرمجاز» حساب می‌شود (fail-closed).
 * GLM-1: اتکا به رفتار داخلی BlockList برای IPv4-mapped (::ffff:a.b.c.d) کافی نیست؛ اینجا صریحاً:
 *  • ::ffff:a.b.c.d (و شکل هگز ::ffff:7f00:1) ← IPv4 جاسازی‌شده بیرون کشیده و با قواعد IPv4 سنجیده می‌شود؛
 *  • ::ffff:0:a.b.c.d (SIIT / RFC 2765، «::ffff:0:0/96») ← کامل مسدود (در DNS عمومی هرگز لازم نیست).
 */
export function isPrivateIp(ip: string): boolean {
  const clean = String(ip).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = net.isIP(clean);
  if (kind === 0) return true;
  try {
    if (kind === 6) {
      const g = ipv6Groups(clean);
      if (!g) return true;
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
        const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
        return blocked.check(v4, "ipv4");
      }
      if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true;
      return blocked.check(clean, "ipv6");
    }
    return blocked.check(clean, "ipv4");
  } catch {
    return true;
  }
}

const isInternalName = (host: string) => host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");

/** بررسی ایستا (بدون DNS) میزبان: IP لیترال و نام‌های داخلی */
function assertHostLiteralSafe(rawHost: string): void {
  const host = rawHost.trim().replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || isInternalName(host)) throw new SsrfError();
  if (net.isIP(host) && isPrivateIp(host)) throw new SsrfError();
}

/** lookup نگهبان: خروجی همان آدرس‌هایی است که سوکت به آن‌ها وصل می‌شود، و همگی عمومی‌اند */
function guardedLookup(hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void): void {
  try {
    assertHostLiteralSafe(hostname);
  } catch (e) {
    return cb(e);
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (addrs as dns.LookupAddress[]) ?? [];
    if (list.length === 0) return cb(new SsrfError("میزبان قابل شناسایی نیست"));
    if (list.some((a) => isPrivateIp(a.address))) return cb(new SsrfError());
    if (options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

let agent: Agent | null = null;
function pinnedAgent(): Agent {
  agent ??= new Agent({
    connect: { lookup: guardedLookup as unknown as net.LookupFunction, timeout: 10_000 },
    // اتصال keep-alive فقط به سوکتی است که پیش‌تر از همین نگهبان گذشته؛ عمرش را هم کوتاه می‌کنیم
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 10_000,
  });
  return agent;
}

export type SafeFetchInit = RequestInit & { allowHttp?: boolean };

/**
 * جایگزین امن fetch برای هر آدرسِ تحت کنترل کاربر/مهاجم.
 * - فقط HTTPS (مگر allowHttp)، بدون credentials در URL
 * - اتصال TCP فقط به آدرس‌های عمومی و در همان لحظه‌ی اتصال بررسی می‌شود (ضد DNS Rebinding)
 * - ریدایرکت پیش‌فرض ممنوع است؛ هر ریدایرکت باید دوباره از safeFetch بگذرد
 */
export async function safeFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const { allowHttp, ...rest } = init;
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    throw new SsrfError("آدرس نامعتبر است");
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new SsrfError("فقط آدرس HTTPS مجاز است");
  if (u.username || u.password) throw new SsrfError("آدرس نامعتبر است");
  assertHostLiteralSafe(u.hostname);
  return fetch(u, { ...rest, redirect: rest.redirect ?? "error", dispatcher: pinnedAgent() } as RequestInit);
}

/**
 * بازخورد زودهنگام: فقط HTTPS و فقط میزبان‌هایی که (در این لحظه) به آدرس عمومی resolve می‌شوند.
 * مرز امنیتی واقعی `safeFetch` است؛ هر جا بعد از این تابع درخواست می‌فرستید باید از safeFetch استفاده کنید.
 */
export async function assertSafeUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("آدرس نامعتبر است");
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) throw new Error("فقط آدرس HTTPS مجاز است");
  if (u.username || u.password) throw new Error("آدرس نامعتبر است");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  try {
    assertHostLiteralSafe(host);
  } catch {
    throw new Error("آدرس داخلی مجاز نیست");
  }
  if (net.isIP(host)) return u;
  const addrs = await dnsPromises.lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error("میزبان قابل شناسایی نیست");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("آدرس داخلی مجاز نیست");
  return u;
}

/** فقط بررسی می‌کند میزبان (برای SMTP و …) به آدرس عمومی resolve شود؛ از اسکن شبکه‌ی داخلی جلوگیری می‌کند */
export async function assertPublicHost(rawHost: string): Promise<void> {
  const host = rawHost.trim().replace(/^\[|\]$/g, "");
  if (!host || isInternalName(host.toLowerCase())) throw new Error("میزبان داخلی مجاز نیست");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("میزبان داخلی مجاز نیست");
    return;
  }
  const addrs = await dnsPromises.lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new Error("میزبان قابل شناسایی نیست");
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error("میزبان داخلی مجاز نیست");
}
