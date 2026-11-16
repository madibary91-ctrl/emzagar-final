/**
 * U-06 — فراخوانی امن Server Action از کلاینت.
 *
 * ریشه‌ی باگ: بیش از ده نقطه `const r = await someAction(...)` بدون try/catch بودند. وقتی اینترنت قطع می‌شد fetch رد می‌شد،
 * `setBusy(null)` هرگز اجرا نمی‌شد (دکمه برای همیشه چرخان می‌ماند) و داخل `startTransition` خطا تا مرز خطای React بالا می‌رفت و
 * کل صفحه (حتی صفحه‌ی امضا با فرم نیمه‌پر) با «مشکلی پیش آمد» جایگزین می‌شد.
 *
 * `safeCall` هرگز نمی‌اندازد؛ خطای شبکه/زمان‌سنج/۵۰۰ را به همان شکل شناخته‌شده‌ی `{ ok: false, error }` برمی‌گرداند
 * تا همه‌ی فرم‌ها با همان مسیر خطای معمول (نمایش پیام + آزادشدن دکمه) کار کنند و ورودی‌های کاربر حفظ شود.
 */

export const NET_MESSAGES = {
  offline: "اتصال اینترنت شما قطع است. اطلاعاتی که وارد کرده‌اید حفظ شده؛ اتصال را بررسی کنید و دوباره تلاش کنید.",
  timeout: "پاسخی از سرور نرسید (اینترنت کند یا ناپایدار است). اگر مطمئن نیستید کار انجام شده، صفحه را تازه کنید و دوباره تلاش کنید.",
  server: "ارتباط با سرور موقتاً برقرار نشد. چند لحظه بعد دوباره تلاش کنید؛ اطلاعات شما حفظ شده است.",
} as const;

export type NetFailKind = keyof typeof NET_MESSAGES;

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** خطاهای کنترلی Next (redirect / notFound) نباید بلعیده شوند */
export function isNextControlError(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK") || digest === "NEXT_NOT_FOUND");
}

/** نوع خطای شبکه را برای نمایش پیام درست تشخیص می‌دهد */
export function classifyNetError(e: unknown): NetFailKind {
  if (isOffline()) return "offline";
  if ((e as { name?: string } | null)?.name === "TimeoutError") return "timeout";
  return "server";
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

export interface SafeCallOptions {
  /** سقف انتظار؛ پیش‌فرض ۴۵ ثانیه (برای امضا/آپلود بیشتر بدهید). ۰ = بدون سقف */
  timeoutMs?: number;
}

export const DEFAULT_ACTION_TIMEOUT_MS = 45_000;

/**
 * نتیجه‌ی اکشن را برمی‌گرداند؛ در خطای شبکه `{ ok: false, error, offline?, timeout? }`.
 * نوع بازگشتی عمداً `T` است: همه‌ی اکشن‌های پروژه شکل `{ ok: boolean; error?: string }` دارند و شاخه‌ی شکست ما با آن سازگار است.
 */
export async function safeCall<T>(fn: () => Promise<T>, opts: SafeCallOptions = {}): Promise<T> {
  return safeCallWith(fn, (message, kind) => ({ ok: false, error: message, offline: kind === "offline", timeout: kind === "timeout", networkFailure: true }) as unknown as T, opts);
}

/** مثل safeCall، ولی برای اکشن‌هایی که شکل خروجی‌شان `{ ok, error }` نیست (آرایه، `{ level, message }`، `{ state }` …) */
export async function safeCallWith<T>(fn: () => Promise<T>, onFail: (message: string, kind: NetFailKind) => T, opts: SafeCallOptions = {}): Promise<T> {
  const ms = opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!ms) return await fn();
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError("timeout")), ms);
      }),
    ]);
  } catch (e) {
    if (isNextControlError(e)) throw e;
    const kind = classifyNetError(e);
    return onFail(NET_MESSAGES[kind], kind);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** برای `useTransition`/دکمه‌های بی‌خروجی: پیام خطا (یا null در موفقیت) برمی‌گرداند و هرگز نمی‌اندازد */
export async function runSafely(fn: () => Promise<unknown>, opts?: SafeCallOptions): Promise<string | null> {
  const r = (await safeCall(async () => ({ ok: true as const, value: await fn() }), opts)) as { ok: boolean; error?: string };
  return r.ok ? null : r.error ?? NET_MESSAGES.server;
}
