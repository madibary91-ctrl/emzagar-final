/**
 * خاموشی نرم (Graceful Shutdown) — R-02.
 *
 * Next.js خودش روی SIGTERM «سرور HTTP را می‌بندد و exit(143) می‌زند»؛ اما از وضعیت «ما» خبر ندارد:
 *   - رزروهای سهمیه‌ی هوش مصنوعی که تماس‌شان وسط راه قطع می‌شود تا ۲۴ ساعت از سهمیه‌ی مشتری می‌سوزند؛
 *   - کارهای صف که «در حال اجرا» بودند تا پایان اجاره (۵ دقیقه) رها می‌مانند و بدون دلیل یک تلاش از سقفشان مصرف می‌شود؛
 *   - استخر دیتابیس بدون بستن، اتصال‌ها را تا timeout سمت Postgres باز می‌گذارد (در هر دیپلوی «اتصال یتیم»).
 *
 * این ماژول یک «هماهنگ‌کننده‌ی خاموشی» است: ماژول‌ها با `onShutdown(name, fn, order)` قلاب ثبت می‌کنند؛ هنگام سیگنال،
 * قلاب‌ها به ترتیب `order` (هم‌ترتیب‌ها هم‌زمان) و با سقف زمانی `SHUTDOWN_GRACE_MS` (پیش‌فرض ۲۰ ثانیه) اجرا می‌شوند.
 *
 * نکته‌ی فنی: هندلر SIGTERM خودِ Next پس از بستن سرور «فوراً» `process.exit(143)` می‌زند و قلاب‌های ناهمگام ما نیمه‌کاره می‌ماند.
 * به همین دلیل پس از دریافت سیگنال، `process.exit` تا پایان قلاب‌ها «به تعویق» می‌افتد (فقط در حالت خاموشی؛ در حالت عادی دست‌نخورده).
 * اگر Next هیچ‌وقت exit نزند (مثلاً NEXT_MANUAL_SIG_HANDLE=1 یا درخواست‌های طولانی)، خودمان در پایان مهلت خارج می‌شویم تا
 * پروسه هرگز معلق نماند.
 *
 * بدون وابستگی به دیتابیس/Next: در پروسه‌ی فرزند هم آزمون‌پذیر است.
 */
export interface ShutdownContext {
  reason: string;
  /** true = پروسه بلافاصله پس از قلاب‌ها خارج می‌شود (سیگنال واقعی)؛ در آزمون/فراخوانی دستی false */
  exiting: boolean;
  startedAt: number;
  /** مهلت کل (ms epoch) */
  deadline: number;
  /** مهلت «انتظار برای تمام شدن کارهای در جریان»؛ پس از آن قلاب‌ها باید کار باقی‌مانده را آزاد/جبران کنند */
  drainDeadline: number;
}
export type ShutdownHook = (ctx: ShutdownContext) => void | Promise<void>;

interface HookEntry {
  name: string;
  order: number;
  fn: ShutdownHook;
}
interface State {
  hooks: Map<string, HookEntry>;
  installed: boolean;
  running: Promise<void> | null;
  realExit?: typeof process.exit;
}
type Holder = typeof globalThis & { __emzShutdown?: State };
const g = globalThis as Holder;
const state: State = (g.__emzShutdown ??= { hooks: new Map(), installed: false, running: null });

export const isShuttingDown = (): boolean => state.running !== null;

export function shutdownGraceMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SHUTDOWN_GRACE_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(120_000, Math.max(1_000, Math.trunc(n))) : 20_000;
}

/** ثبت قلاب خاموشی. نام تکراری جایگزین می‌شود (امن در برابر بارگذاری مجدد ماژول/HMR). `order` کوچک‌تر زودتر. */
export function onShutdown(name: string, fn: ShutdownHook, order = 50): void {
  state.hooks.set(name, { name, order, fn });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** صبر تا شرط برقرار شود یا مهلت برسد؛ true = شرط برقرار شد */
export async function waitUntil(cond: () => boolean, untilMs: number, stepMs = 50): Promise<boolean> {
  while (!cond()) {
    if (Date.now() >= untilMs) return false;
    await sleep(Math.min(stepMs, untilMs - Date.now()));
  }
  return true;
}

/** اجرای همه‌ی قلاب‌ها (idempotent: فراخوانی دوباره همان اجرای جاری را برمی‌گرداند). هرگز reject نمی‌شود. */
export function runShutdown(reason = "manual", opts: { graceMs?: number; exiting?: boolean } = {}): Promise<void> {
  if (state.running) return state.running;
  const startedAt = Date.now();
  const graceMs = opts.graceMs ?? shutdownGraceMs();
  const ctx: ShutdownContext = { reason, exiting: opts.exiting ?? false, startedAt, deadline: startedAt + graceMs, drainDeadline: startedAt + Math.floor(graceMs * 0.6) };
  state.running = (async () => {
    console.warn(`[shutdown] دریافت «${reason}» — خاموشی نرم آغاز شد (مهلت ${Math.round(graceMs / 1000)} ثانیه)`);
    const groups = new Map<number, HookEntry[]>();
    for (const h of state.hooks.values()) groups.set(h.order, [...(groups.get(h.order) ?? []), h]);
    for (const order of [...groups.keys()].sort((a, b) => a - b)) {
      const left = ctx.deadline - Date.now();
      if (left <= 0) {
        console.error(`[shutdown] مهلت تمام شد؛ قلاب‌های order=${order} به بعد اجرا نشدند`);
        break;
      }
      await Promise.all(
        groups.get(order)!.map(async (h) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<void>((res) => {
            timer = setTimeout(() => {
              console.error(`[shutdown:${h.name}] از مهلت گذشت`);
              res();
            }, left);
          });
          const ran = Promise.resolve()
            .then(() => h.fn(ctx))
            .catch((e) => console.error(`[shutdown:${h.name}]`, e instanceof Error ? e.message : e));
          await Promise.race([ran, timedOut]);
          clearTimeout(timer); // قلاب به‌موقع تمام شد: هشدار دروغین و تایمر معلق نمی‌خواهیم
        }),
      );
    }
    console.warn(`[shutdown] پایان خاموشی نرم پس از ${Date.now() - startedAt}ms`);
  })();
  return state.running;
}

/** فقط برای آزمون: پایان «حالت خاموشی» تا آزمون‌های بعدی همان پروسه عادی کار کنند (قلاب‌های ثبت‌شده حفظ می‌شوند) */
export function __resetShutdownForTests(): void {
  state.running = null;
}

const SIGNAL_CODE: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * نصب هندلر SIGTERM/SIGINT (idempotent). در `instrumentation.ts` فراخوانی می‌شود.
 */
export function installShutdownHandlers(): void {
  if (state.installed) return;
  state.installed = true;
  const realExit = process.exit.bind(process) as typeof process.exit;
  state.realExit = realExit;

  // exit «به تعویق‌افتاده»: در خاموشی، هر exit (از جمله exit(143) خودِ Next) تا پایان قلاب‌ها صبر می‌کند
  process.exit = ((code?: number | string | null) => {
    if (!state.running) return realExit(code as number | undefined);
    void state.running.finally(() => realExit(code as number | undefined));
    return undefined as never;
  }) as typeof process.exit;

  const onSignal = (signal: NodeJS.Signals) => {
    if (state.running) return; // سیگنال تکراری (مثلاً Ctrl+C در شل) نادیده گرفته می‌شود
    const grace = shutdownGraceMs();
    const done = runShutdown(signal, { exiting: true });
    // اگر Next هندلر خودش را ندارد، ما خارج می‌شویم؛ وگرنه پس از اتمام مهلت (درخواست‌های بسیار طولانی)
    const code = SIGNAL_CODE[signal] ?? 128;
    // تنها شنونده‌ی سیگنال ما هستیم (یا Next غیرفعال شده) ⇒ پس از قلاب‌ها همان لحظه خارج می‌شویم
    const sole = process.listenerCount(signal) <= 1 || !!process.env.NEXT_MANUAL_SIG_HANDLE;
    void done.then(() => {
      if (sole) realExit(code);
    });
    setTimeout(() => realExit(code), grace + 1_500).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}
