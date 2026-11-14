import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateIp } from "@/lib/ssrf";

/**
 * M-01 — محافظ اتصال SMTP برای میزبان‌هایی که «مدیر فضای کاری» وارد می‌کند (SSRF / اسکن پورت / DNS Rebinding).
 *
 *  ۱) فهرست سفید پورت: فقط 25 / 465 / 587 / 2525 (Redis، Postgres، متادیتای ابر و … از این راه قابل‌دسترس نیست).
 *  ۲) «حل‌کردن و پین‌کردن» در لحظه‌ی استفاده: نام فقط «یک بار» در همین لحظه resolve می‌شود، همه‌ی آدرس‌ها باید عمومی باشند
 *     و اتصال مستقیماً به همان IP انجام می‌شود (نام اصلی فقط برای SNI/اعتبارسنجی گواهی می‌ماند). چون nodemailer دوباره
 *     DNS نمی‌پرسد، پنجره‌ی TOCTOU بین «بررسی» و «اتصال» وجود ندارد.
 *  ۳) پیام خطا عمداً کلی است: تفاوت «بسته/فیلتر/داخلی» برای مهاجم قابل‌مشاهده نیست (اسکن پورت ممکن نمی‌شود).
 *
 * SMTP «پلتفرم» (متغیرهای محیطی SMTP_*) را مدیر سرور تنظیم کرده و مورد اعتماد است (مثلاً رله‌ی داخلی)؛ آن مسیر از این محافظ عبور نمی‌کند.
 */
export const SMTP_PORT_ALLOWLIST = [25, 465, 587, 2525] as const;

export class SmtpTargetError extends Error {
  code = "ESMTPTARGET";
  constructor(message = "میزبان یا پورت SMTP مجاز نیست") {
    super(message);
    this.name = "SmtpTargetError";
  }
}

export function parseSmtpPort(raw: string | number | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 587;
}

export function isAllowedSmtpPort(port: number): boolean {
  return (SMTP_PORT_ALLOWLIST as readonly number[]).includes(port);
}

const INTERNAL_NAME = (h: string) => h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".");

export type SmtpConnectOptions = {
  host: string; // IP پین‌شده (یا همان میزبان برای SMTP مورد اعتماد)
  port: number;
  secure: boolean;
  tls?: { servername: string };
  /** نام اصلی برای نمایش/لاگ */
  displayHost: string;
};

export async function guardedSmtpOptions(rawHost: string, rawPort: string | number | null | undefined, opts: { trusted?: boolean } = {}): Promise<SmtpConnectOptions> {
  const displayHost = String(rawHost).trim().replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const port = parseSmtpPort(rawPort);
  const secure = port === 465;
  if (opts.trusted) return { host: displayHost, port, secure, displayHost };
  if (!displayHost || displayHost.length > 253) throw new SmtpTargetError();
  if (!isAllowedSmtpPort(port)) throw new SmtpTargetError(`پورت SMTP باید یکی از ${SMTP_PORT_ALLOWLIST.join("، ")} باشد`);
  if (net.isIP(displayHost)) {
    if (isPrivateIp(displayHost)) throw new SmtpTargetError();
    return { host: displayHost, port, secure, displayHost };
  }
  if (INTERNAL_NAME(displayHost)) throw new SmtpTargetError();
  const addrs = await dns.lookup(displayHost, { all: true }).catch(() => []);
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) throw new SmtpTargetError();
  const pick = addrs.find((a) => a.family === 4) ?? addrs[0];
  return { host: pick.address, port, secure, tls: { servername: displayHost }, displayHost };
}
