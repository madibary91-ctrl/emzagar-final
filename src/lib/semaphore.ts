/**
 * سمافور درون‌پروسه‌ای (FIFO) برای محدودکردن کارهای سنگین هم‌زمان (رندر PDF و …).
 * بدون وابستگی؛ خطای یک کار، جایگاه را آزاد می‌کند.
 */
export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** تعداد کارهای در حال اجرا */
  readonly active: number;
  /** تعداد منتظران */
  readonly waiting: number;
  readonly max: number;
}

export function createSemaphore(max: number): Semaphore {
  const limit = Math.max(1, Math.trunc(max) || 1);
  let active = 0;
  const queue: (() => void)[] = [];
  const release = () => {
    const next = queue.shift();
    if (next) next(); // جایگاه مستقیم به نفر بعدی منتقل می‌شود (active ثابت می‌ماند)
    else active--;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
      else active++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    max: limit,
  };
}

/** عدد صحیح از متغیر محیطی با بازه‌ی مجاز؛ ورودی نامعتبر بی‌صدا به پیش‌فرض می‌رود */
export function envInt(name: string, def: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}
