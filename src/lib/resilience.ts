/**
 * ابزارهای پایداری برای تماس با سرویس‌های بیرونی (پیامک، ایمیل، وب‌هوک، درگاه): jitter، مهلت سخت، retry محدود و قطع‌کننده‌ی مدار.
 * بدون وابستگی و بدون حالت مشترک بین پروسه‌ها (هر پروسه برای خودش قضاوت می‌کند؛ این عمداً ساده و ایمن است).
 */

/**
 * قطع‌کننده و retry در آزمون‌های موجود (که قطعی‌های شبیه‌سازی‌شده‌ی پیاپی دارند و شمارش تماس می‌کنند) خاموش است؛
 * آزمون‌های این قابلیت با RESILIENCE_FORCE=1 آن را روشن می‌کنند. در production همیشه روشن است.
 */
export const resilienceEnabled = (): boolean => process.env.NODE_ENV !== "test" || process.env.RESILIENCE_FORCE === "1";

/** تأخیر با «jitter متعادل»: نیمی ثابت + نیمی تصادفی (هم‌زمان‌نشدن retryهای پس از یک قطعی بزرگ — thundering herd) */
export function withJitter(ms: number, rnd: () => number = Math.random): number {
  const base = Math.max(0, ms);
  return Math.round(base / 2 + rnd() * (base / 2));
}

/** محدوده‌ی jitter برای مقدار پایه‌ی ms (برای آزمون/مستند) */
export const backoffJitterBounds = (attempt: number): { min: number; max: number } => {
  const base = Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000);
  return { min: Math.round(base / 2), max: base };
};

export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: مهلت ${Math.round(ms / 1000)} ثانیه‌ای تمام شد`);
    this.name = "DeadlineError";
  }
}

/** مهلت «سخت» کل عملیات (علاوه بر timeoutهای هر مرحله‌ی سوکت که سقف کل نمی‌دهند) */
export async function withDeadline<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new DeadlineError(label, ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** retry محدود فقط برای خطاهای «گذرا» (isTransient)؛ فاصله‌ی نمایی + jitter. خطای دائمی فوراً پرتاب می‌شود. */
export async function retryTransient<T>(fn: (attempt: number) => Promise<T>, o: { retries?: number; baseMs?: number; isTransient?: (e: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const retries = o.retries ?? 1;
  const base = o.baseMs ?? 400;
  const isTransient = o.isTransient ?? (() => true);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= retries || !isTransient(e)) throw e;
      await sleep(withJitter(base * 2 ** attempt));
    }
  }
}

/* ───────────── قطع‌کننده‌ی مدار (Circuit Breaker) ───────────── */

export class CircuitOpenError extends Error {
  constructor(public readonly key: string, public readonly retryAfterMs: number) {
    super(`سرویس «${key}» موقتاً از دسترس خارج است؛ ${Math.ceil(retryAfterMs / 1000)} ثانیه‌ی دیگر دوباره تلاش می‌شود`);
    this.name = "CircuitOpenError";
  }
}

interface BreakerState {
  failures: number;
  openUntil: number;
  /** نوبت یک «کاوشگر» نیمه‌باز در جریان است */
  probing: boolean;
  opens: number;
}
type Holder = typeof globalThis & { __emzBreakers?: Map<string, BreakerState> };
const states = (): Map<string, BreakerState> => ((globalThis as Holder).__emzBreakers ??= new Map());

export interface BreakerOptions {
  /** تعداد شکست پیاپیِ گذرا تا باز شدن مدار (پیش‌فرض ۵) */
  threshold?: number;
  /** مدت اولیه‌ی باز ماندن (پیش‌فرض ۳۰ ثانیه؛ با هر باز شدن پیاپی دو برابر تا سقف maxOpenMs) */
  openMs?: number;
  maxOpenMs?: number;
  now?: () => number;
}

/**
 * وقتی یک سرویس بیرونی خراب است، هر تماس تا مهلتش (۱۰–۱۵ ثانیه) یک کارگر صف/درخواست را نگه می‌دارد و با ۴ کارگر، کل صف قفل می‌شود.
 * مدار پس از `threshold` شکست گذره‌ی پیاپی «باز» می‌شود و تماس‌ها فوراً با CircuitOpenError رد می‌شوند؛ پس از `openMs`
 * فقط «یک» تماس آزمایشی (half-open) اجازه می‌گیرد: موفق ⇒ بسته؛ شکست ⇒ دوباره باز با مدت دو برابر.
 * فقط خطاهای گذرا (isFailure) به حساب می‌آیند؛ پاسخ «شماره‌ی نامعتبر» نشانه‌ی خرابیِ سرویس نیست.
 */
export async function guarded<T>(key: string, fn: () => Promise<T>, o: BreakerOptions & { isFailure?: (e: unknown) => boolean } = {}): Promise<T> {
  if (!resilienceEnabled()) return fn();
  const now = o.now ?? Date.now;
  const threshold = o.threshold ?? 5;
  const openMs = o.openMs ?? 30_000;
  const maxOpen = o.maxOpenMs ?? 10 * 60_000;
  const map = states();
  const st = map.get(key) ?? { failures: 0, openUntil: 0, probing: false, opens: 0 };
  map.set(key, st);
  const t = now();
  if (st.openUntil > t) throw new CircuitOpenError(key, st.openUntil - t);
  const halfOpen = st.openUntil > 0; // مدت باز تمام شده ولی هنوز بسته نشده
  if (halfOpen) {
    if (st.probing) throw new CircuitOpenError(key, 1000);
    st.probing = true;
  }
  try {
    const out = await fn();
    st.failures = 0;
    st.openUntil = 0;
    st.opens = 0;
    return out;
  } catch (e) {
    if (o.isFailure ? o.isFailure(e) : true) {
      st.failures++;
      if (halfOpen || st.failures >= threshold) {
        st.opens++;
        st.openUntil = now() + Math.min(openMs * 2 ** Math.max(st.opens - 1, 0), maxOpen);
      }
    }
    throw e;
  } finally {
    if (halfOpen) st.probing = false;
  }
}

export function breakerSnapshot(key: string): { failures: number; open: boolean; retryAfterMs: number } {
  const st = states().get(key);
  const t = Date.now();
  return { failures: st?.failures ?? 0, open: !!st && st.openUntil > t, retryAfterMs: st && st.openUntil > t ? st.openUntil - t : 0 };
}

export function resetBreakers(): void {
  states().clear();
}
