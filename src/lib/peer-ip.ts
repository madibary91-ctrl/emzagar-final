import http from "node:http";

/**
 * H-04 — آدرس «واقعی» سوکت (peer) برای محدودکننده‌ی نرخ.
 *
 * App Router آدرس سوکت را به کد برنامه نمی‌دهد؛ پیش‌تر فقط هدرهای X-Forwarded-For/X-Real-IP (که کلاینت می‌تواند
 * جعل کند) در دسترس بود. نتیجه: بدون پراکسی همه‌ی IPها "unknown" (یک سطل جهانی ⇒ قفل شدن ورود همه) یا هدر جعلی
 * پذیرفته می‌شد (دور زدن همه‌ی محدودیت‌ها).
 *
 * راه‌حل: هنگام بالا آمدن سرور (instrumentation) رویداد "request" سرور HTTP قلاب می‌شود و پیش از رسیدن به Next:
 *   ۱) هر هدر X-Emz-Peer-Ip که از بیرون آمده باشد حذف می‌شود (جعل‌ناپذیر)؛
 *   ۲) آدرس واقعی سوکت در همان هدر نوشته می‌شود.
 * پس `clientIpFrom` همیشه یک منبع مورد اعتماد برای IP دارد و فقط وقتی (و تا جایی که) پراکسی مورد اعتماد
 * تنظیم شده باشد به هدرهای forwarded رجوع می‌کند.
 */
export const PEER_IP_HEADER = "x-emz-peer-ip";
const FLAG = Symbol.for("emz.peerIpStamp.installed");

/** حذف هر نسخه‌ی کلاینتی هدر و نوشتن آدرس واقعی سوکت (در headers و rawHeaders) */
export function stampPeerIp(req: Pick<http.IncomingMessage, "headers" | "rawHeaders" | "socket">): void {
  delete req.headers[PEER_IP_HEADER];
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) for (let i = raw.length - 2; i >= 0; i -= 2) if (raw[i].toLowerCase() === PEER_IP_HEADER) raw.splice(i, 2);
  const addr = req.socket?.remoteAddress;
  if (addr) {
    req.headers[PEER_IP_HEADER] = addr;
    if (Array.isArray(raw)) raw.push("X-Emz-Peer-Ip", addr);
  }
}

/** یک‌بار روی http.Server نصب می‌شود (ایدمپوتنت). true = همین حالا نصب شد */
export function installPeerIpStamp(): boolean {
  const proto = http.Server.prototype as unknown as Record<string | symbol, unknown> & { emit: (...a: unknown[]) => boolean };
  if (proto[FLAG]) return false;
  const original = proto.emit;
  proto.emit = function patchedEmit(this: unknown, event: unknown, ...args: unknown[]) {
    if (event === "request" && args[0]) {
      try {
        stampPeerIp(args[0] as http.IncomingMessage);
      } catch {
        /* هرگز درخواست را خراب نکن */
      }
    }
    return original.call(this, event, ...args);
  };
  proto[FLAG] = true;
  return true;
}
