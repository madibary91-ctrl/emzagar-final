import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { Step } from "./types";

/**
 * ابزار عیب‌یابی شبکه: DNS ← اتصال TCP ← دست‌دادن TLS (و تاریخ انقضای گواهی) ← پاسخ HTTP.
 * فقط برای میزبان‌هایی استفاده می‌شود که خود سیستم (پیکربندی/ثابت‌های کد) تعیین کرده است؛
 * هرگز آدرس دلخواه از ورودی کاربر دریافت نمی‌کند.
 */
export interface ProbeResult {
  ok: boolean;
  steps: Step[];
  latencyMs: number;
  httpStatus?: number;
  tlsDaysLeft?: number;
  tlsValidTo?: string;
  tlsIssuer?: string;
  banner?: string;
  error?: string;
}

const now = () => performance.now();
const ms = (t0: number) => Math.round(now() - t0);

export function explainNetError(e: unknown): string {
  const err = e as { code?: string; message?: string; name?: string } | null;
  const code = String(err?.code ?? "");
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "نام دامنه پیدا نشد (مشکل DNS یا نبود اینترنت روی سرور)";
    case "ECONNREFUSED":
      return "اتصال رد شد (پورت بسته است یا سرویس بالا نیست)";
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
      return "مهلت اتصال تمام شد (احتمالاً فایروال یا فیلترینگ)";
    case "ECONNRESET":
      return "اتصال از سمت مقابل قطع شد";
    case "CERT_HAS_EXPIRED":
      return "گواهی TLS منقضی شده است";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
      return "گواهی TLS خودامضاست و معتبر نیست";
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return "زنجیره‌ی گواهی TLS ناقص یا نامعتبر است";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "نام دامنه با گواهی TLS مطابقت ندارد";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "مسیر شبکه به میزبان وجود ندارد";
  }
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "مهلت پاسخ تمام شد";
  return String(err?.message || "خطای ناشناخته‌ی شبکه").slice(0, 160);
}

async function dnsStep(host: string, steps: Step[]): Promise<boolean> {
  if (net.isIP(host)) {
    steps.push({ name: "DNS", ok: true, ms: 0, detail: "آدرس IP مستقیم" });
    return true;
  }
  const t0 = now();
  try {
    const addrs = await dns.lookup(host, { all: true });
    steps.push({ name: "DNS", ok: true, ms: ms(t0), detail: addrs.slice(0, 3).map((a) => a.address).join("، ") });
    return true;
  } catch (e) {
    steps.push({ name: "DNS", ok: false, ms: ms(t0), detail: explainNetError(e) });
    return false;
  }
}

/** اتصال TCP (و در صورت secure، TLS) + خواندن بنر اختیاری (مثلاً SMTP 220) */
export async function probeSocket(host: string, port: number, opts: { secure?: boolean; timeoutMs?: number; readBanner?: boolean; /** M-01: IP پین‌شده برای اتصال (نام فقط برای نمایش/SNI) */ connectHost?: string } = {}): Promise<ProbeResult> {
  const steps: Step[] = [];
  const total = now();
  const timeout = opts.timeoutMs ?? 8000;
  if (!opts.connectHost && !(await dnsStep(host, steps))) return { ok: false, steps, latencyMs: ms(total), error: steps[0].detail };

  const t0 = now();
  return new Promise<ProbeResult>((resolve) => {
    let done = false;
    const finish = (r: Partial<ProbeResult> & { ok: boolean }) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* بسته شده */
      }
      resolve({ steps, latencyMs: ms(total), ...r });
    };
    const onConnect = () => {
      const connectMs = ms(t0);
      let tlsInfo: Partial<ProbeResult> = {};
      if (opts.secure) {
        const s = sock as tls.TLSSocket;
        const cert = s.getPeerCertificate();
        if (cert?.valid_to) {
          const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400_000);
          const issuer = cert.issuer as { O?: string; CN?: string } | undefined;
          tlsInfo = { tlsDaysLeft: daysLeft, tlsValidTo: cert.valid_to, tlsIssuer: String(issuer?.O || issuer?.CN || "") };
        }
        steps.push({ name: "TCP", ok: true, ms: connectMs, detail: `${host}:${port}` });
        steps.push({ name: "TLS", ok: true, ms: connectMs, detail: `${s.getProtocol?.() ?? "TLS"}${tlsInfo.tlsDaysLeft !== undefined ? ` · انقضای گواهی ${tlsInfo.tlsDaysLeft} روز دیگر` : ""}` });
      } else {
        steps.push({ name: "TCP", ok: true, ms: connectMs, detail: `${host}:${port}` });
      }
      if (!opts.readBanner) return finish({ ok: true, ...tlsInfo });
      // بنر سرور (مثلاً «220 smtp…») تا ۳ ثانیه
      const bt = setTimeout(() => {
        steps.push({ name: "بنر", ok: false, detail: "سرور بنر نفرستاد" });
        finish({ ok: true, ...tlsInfo });
      }, 3000);
      sock.once("data", (d) => {
        clearTimeout(bt);
        const banner = String(d).split(/\r?\n/)[0].slice(0, 120);
        steps.push({ name: "بنر", ok: true, detail: banner });
        finish({ ok: true, banner, ...tlsInfo });
      });
    };
    const onError = (e: unknown) => {
      const msg = explainNetError(e);
      steps.push({ name: opts.secure ? "TCP/TLS" : "TCP", ok: false, ms: ms(t0), detail: msg });
      finish({ ok: false, error: msg });
    };
    const sock: net.Socket = opts.secure
      ? tls.connect({ host: opts.connectHost ?? host, port, servername: net.isIP(host) ? undefined : host, timeout }, onConnect)
      : net.connect({ host: opts.connectHost ?? host, port, timeout }, onConnect);
    sock.once("error", onError);
    sock.once("timeout", () => onError({ code: "ETIMEDOUT" }));
  });
}

/** پیمایش کامل یک آدرس HTTP(S): DNS ← TCP/TLS ← پاسخ HTTP. هر پاسخ HTTP غیر ۵xx (حتی 404) یعنی «سرویس در دسترس است» */
export async function probeUrl(raw: string, opts: { timeoutMs?: number; method?: "GET" | "HEAD" } = {}): Promise<ProbeResult> {
  const total = now();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, steps: [{ name: "آدرس", ok: false, detail: "آدرس نامعتبر است" }], latencyMs: 0, error: "آدرس نامعتبر است" };
  }
  const secure = u.protocol === "https:";
  const port = Number(u.port) || (secure ? 443 : 80);
  const sock = await probeSocket(u.hostname.replace(/^\[|\]$/g, ""), port, { secure, timeoutMs: opts.timeoutMs });
  if (!sock.ok) return { ...sock, latencyMs: ms(total) };

  const t0 = now();
  const steps = [...sock.steps];
  try {
    const res = await fetch(u, { method: opts.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { "User-Agent": "emzagar-health/1.0", Accept: "*/*" } });
    // بدنه را نمی‌خوانیم؛ فقط وضعیت مهم است
    void res.body?.cancel().catch(() => undefined);
    steps.push({ name: "HTTP", ok: res.status < 500, ms: ms(t0), detail: `HTTP ${res.status}` });
    return { ...sock, ok: res.status < 500, steps, httpStatus: res.status, latencyMs: ms(total), error: res.status >= 500 ? `سرور خطای ${res.status} داد` : undefined };
  } catch (e) {
    const msg = explainNetError(e);
    steps.push({ name: "HTTP", ok: false, ms: ms(t0), detail: msg });
    return { ...sock, ok: false, steps, latencyMs: ms(total), error: msg };
  }
}

/** پیام فارسی برای وضعیت گواهی TLS؛ null اگر مشکلی نیست */
export function tlsWarning(p: ProbeResult): string | null {
  if (p.tlsDaysLeft === undefined) return null;
  if (p.tlsDaysLeft < 0) return "گواهی TLS منقضی شده است";
  if (p.tlsDaysLeft <= 14) return `گواهی TLS تا ${p.tlsDaysLeft} روز دیگر منقضی می‌شود`;
  return null;
}
