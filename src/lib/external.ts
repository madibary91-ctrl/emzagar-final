/**
 * لایه‌ی مرکزی «سرویس‌های بیرونی» (زرین‌پال، کاوه‌نگار، ملی‌پیامک، GapGPT).
 *
 * اگر متغیر محیطی EXTERNAL_SIM_URL تنظیم شده باشد (مثلاً http://127.0.0.1:4010)،
 * همه‌ی تماس‌های بیرونی به «شبیه‌ساز» (پوشه‌ی simulator/) هدایت می‌شوند و هیچ درخواست واقعی
 * (و هیچ هزینه‌ای) به اینترنت نمی‌رود. بدون این متغیر، رفتار برنامه دقیقاً مثل قبل است.
 *
 * ایمنی: برای جلوگیری از ارسال کلیدهای واقعی به یک میزبان ناشناس، فقط میزبان‌های محلی/خصوصی پذیرفته
 * می‌شوند؛ برای میزبان‌های دیگر (مثل سرویس docker) باید EXTERNAL_SIM_ALLOW_REMOTE=1 بدهید.
 */
import net from "node:net";

export type ExternalService = "zarinpal" | "kavenegar" | "melipayamak" | "gapgpt" | "telegram" | "bale";

const PRIVATE_V4 = /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  return net.isIPv4(h) && PRIVATE_V4.test(h);
}

/** آدرس شبیه‌ساز (یا null اگر غیرفعال/نامعتبر/غیرمجاز باشد) */
export function simulatorUrl(): URL | null {
  const raw = (process.env.EXTERNAL_SIM_URL || "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!isLocalHost(u.hostname) && process.env.EXTERNAL_SIM_ALLOW_REMOTE !== "1") return null;
  return u;
}

export const simActive = (): boolean => simulatorUrl() !== null;

/** شناسه‌ی مرچنت ساختگی برای زمانی که شبیه‌ساز فعال است و مرچنت واقعی تنظیم نشده */
export const SIM_MERCHANT_ID = "00000000-0000-0000-0000-000000000000";

const PREFIX: Record<ExternalService, string> = {
  zarinpal: "/zarinpal",
  kavenegar: "/kavenegar",
  melipayamak: "/melipayamak",
  gapgpt: "/gapgpt/v1",
  telegram: "/telegram",
  bale: "/bale",
};

/** آدرس پایه‌ی سرویس برای تماس سرور به سرور: شبیه‌ساز در صورت فعال بودن، وگرنه آدرس واقعی */
export function externalBase(service: ExternalService, realBase: string): string {
  const sim = simulatorUrl();
  return sim ? `${sim.origin}${PREFIX[service]}` : realBase;
}

/** آدرس پایه برای مرورگر کاربر (مثلاً صفحه‌ی پرداخت). در docker می‌توان EXTERNAL_SIM_PUBLIC_URL را جدا داد. */
export function externalPublicBase(service: ExternalService, realBase: string): string {
  const sim = simulatorUrl();
  if (!sim) return realBase;
  const pub = (process.env.EXTERNAL_SIM_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return `${pub || sim.origin}${PREFIX[service]}`;
}

/** آیا این آدرس همان شبیه‌ساز است؟ (برای عبور از فیلتر SSRF که فقط HTTPS عمومی می‌پذیرد) */
export function isSimulatorOrigin(u: URL): boolean {
  const sim = simulatorUrl();
  return !!sim && u.origin === sim.origin;
}

/**
 * مهلت تماس بیرونی. در حالت شبیه‌ساز با EXTERNAL_TIMEOUT_SCALE (مثلاً 0.02) کوتاه می‌شود
 * تا آزمون «قطع بودن/کندی سرویس» دقیقه‌ها طول نکشد. در حالت عادی دست‌نخورده است.
 */
export function extTimeout(ms: number): number {
  if (!simActive()) return ms;
  const scale = Number(process.env.EXTERNAL_TIMEOUT_SCALE);
  return scale > 0 ? Math.max(150, Math.round(ms * scale)) : ms;
}

type ErrLike = { name?: string; message?: string; code?: string; cause?: unknown };

function causeCode(e: unknown): string {
  const c = (e as ErrLike | null)?.cause as ErrLike | undefined;
  return String(c?.code ?? (e as ErrLike | null)?.code ?? "");
}

/** خطای شبکه/تایم‌اوت را به پیام فارسی قابل‌فهم برای کاربر تبدیل می‌کند (هرگز «fetch failed» خام نمایش داده نشود) */
export function friendlyNetworkError(e: unknown, label: string): string {
  const err = e as ErrLike | null;
  const name = err?.name ?? "";
  const msg = String(err?.message ?? "");
  const code = causeCode(e);
  const causeMsg = String(((err?.cause ?? null) as ErrLike | null)?.message ?? "");
  if (name === "TimeoutError" || name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "ETIMEDOUT") {
    return `پاسخی از ${label} دریافت نشد (مهلت تمام شد)`;
  }
  if (/redirect/i.test(`${msg} ${causeMsg}`)) return `${label} پاسخ نامعتبر (ریدایرکت) داد`;
  if (msg === "fetch failed" || /^(ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(code) || /terminated|socket|ECONN/i.test(msg)) {
    return `ارتباط با ${label} برقرار نشد`;
  }
  return msg || `خطای ناشناخته در ارتباط با ${label}`;
}

/** SSRF-safe بودن آدرس سرویس هوش مصنوعی؛ شبیه‌ساز (فقط وقتی فعال است) مستثنا می‌شود */
export async function assertSafeAiUrl(raw: string): Promise<URL> {
  try {
    const u = new URL(raw);
    if (isSimulatorOrigin(u)) return u;
  } catch {
    /* آدرس نامعتبر را assertSafeUrl با پیام فارسی رد می‌کند */
  }
  const { assertSafeUrl } = await import("@/lib/ssrf");
  return assertSafeUrl(raw);
}
