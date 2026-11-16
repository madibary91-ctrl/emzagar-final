import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "@/lib/config";
import { onShutdown, waitUntil } from "@/lib/shutdown";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { quotaLockTimeoutMs, resolvePoolSettings } from "./pool-config";
import { setSealCodec } from "./sealed-text";

// D-01: ستون‌های sealedText (رازهای ذخیره‌شده) از همین‌جا شفاف رمز/باز می‌شوند. encryptSecret روی مقدارِ از-قبل-رمزشده idempotent است.
setSealCodec({ seal: (v) => (v.startsWith("enc:v1:") ? v : encryptSecret(v)), open: decryptSecret });

/**
 * اتصال تنبل (lazy) به دیتابیس.
 * آدرس دیتابیس از متغیر محیطی یا از فایل پیکربندی نصب‌کننده خوانده می‌شود؛
 * بنابراین برنامه حتی پیش از نصب بدون خطا بالا می‌آید و بعد از نصب نیازی به ری‌استارت نیست.
 */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_NOT_CONFIGURED");
    this.name = "DatabaseNotConfiguredError";
  }
}

type Holder = typeof globalThis & {
  __emzPool?: Pool;
  __emzPoolUrl?: string;
  __emzDb?: NodePgDatabase;
  __emzTxStore?: AsyncLocalStorage<TxScope | undefined>;
};
const g = globalThis as Holder;

export function getPool(): Pool {
  const url = getConfig().databaseUrl;
  if (!url) throw new DatabaseNotConfiguredError();
  if (g.__emzPool && g.__emzPoolUrl === url && !(g.__emzPool as Pool & { ended?: boolean }).ended) return g.__emzPool;
  if (g.__emzPool) void g.__emzPool.end().catch(() => undefined);
  // P-04: اندازه‌ی استخر و مهلت‌ها قابل‌تنظیم‌اند (DB_POOL_MAX و …؛ نگاه کنید به pool-config.ts)
  const s = resolvePoolSettings();
  const next = new Pool({
    connectionString: url,
    max: s.max,
    idleTimeoutMillis: s.idleTimeoutMillis,
    connectionTimeoutMillis: s.connectionTimeoutMillis,
    application_name: s.applicationName,
    ...(s.options ? { options: s.options } : {}),
  });
  next.on("error", () => undefined); // قطع‌شدن اتصال بی‌کار نباید پروسه را بکشد
  g.__emzPool = next;
  g.__emzPoolUrl = url;
  g.__emzDb = drizzle(next);
  return next;
}

export function getDb(): NodePgDatabase {
  getPool();
  return g.__emzDb as NodePgDatabase;
}

/* ═════════════════════════════════════════════════════════════════════════════
 * تراکنش «محیطی» (Ambient Transaction)
 *
 * `withTransaction(fn)` یک تراکنش PostgreSQL باز می‌کند و آن را در AsyncLocalStorage نگه می‌دارد.
 * هر کدی که داخل `fn` (حتی چند لایه‌ی پایین‌تر و بدون هیچ پارامتر اضافه) از `db` استفاده کند،
 * خودکار روی همان تراکنش اجرا می‌شود؛ پس سرویس‌های موجود (logAudit، snapshotRevision، createWorkspace و …)
 * بدون تغییر امضا، بخشی از یک واحد اتمی می‌شوند: «یا همه، یا هیچ».
 *
 *  - تودرتو: فراخوانی `withTransaction` داخل تراکنش، یک SAVEPOINT می‌سازد (شکست آن فقط خودش را برمی‌گرداند).
 *  - `afterCommit(fn)`: کارهای جانبی (ایمیل، وب‌هوک، PDF، …) فقط پس از commit موفق اجرا می‌شوند و در rollback دور ریخته می‌شوند.
 *    خارج از تراکنش بلافاصله اجرا می‌شود.
 *  - `onRollback(fn)`: جبران اثرهای غیر-دیتابیسی (مثلاً حذف فایل نوشته‌شده) هنگام برگشت.
 *  - `outsideTransaction(fn)`: اجرای کد مستقل از تراکنش جاری (مثلاً ثبت لاگ شکست که نباید با rollback از بین برود).
 *  - پس از پایان تراکنش، هر ادامه‌ی ناهمگام جامانده (fire-and-forget) خودکار به اتصال عادی برمی‌گردد
 *    و هرگز از یک تراکنشِ بسته‌شده استفاده نمی‌کند.
 * ═══════════════════════════════════════════════════════════════════════════ */
export type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];
type Hook = () => void | Promise<void>;
interface TxScope {
  tx: Tx;
  commitHooks: Hook[];
  rollbackHooks: Hook[];
  closed: boolean;
}

const txStore: AsyncLocalStorage<TxScope | undefined> = (g.__emzTxStore ??= new AsyncLocalStorage<TxScope | undefined>());

function activeScope(): TxScope | null {
  const s = txStore.getStore();
  return s && !s.closed ? s : null;
}

/** آیا کد فعلی داخل یک تراکنش باز اجرا می‌شود؟ */
export function inTransaction(): boolean {
  return activeScope() !== null;
}

async function runHooks(hooks: Hook[], label: string): Promise<void> {
  for (const h of hooks) {
    try {
      await h();
    } catch (e) {
      console.error(`[tx:${label}]`, e);
    }
  }
}

export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const parent = activeScope();
  const scope: TxScope = { tx: undefined as unknown as Tx, commitHooks: [], rollbackHooks: [], closed: false };
  const body = async (tx: Tx) => {
    scope.tx = tx;
    const out = await txStore.run(scope, () => fn(tx));
    // سد ایمنی: اگر کدی خطای SQL را بلعیده باشد، PostgreSQL تراکنش را «ناقص» (aborted) نگه می‌دارد و COMMIT بی‌صدا
    // به ROLLBACK تبدیل می‌شود. این پرسش در آن حالت خطا می‌دهد تا هرگز موفقیتِ دروغین گزارش نشود.
    await tx.execute(sql`select 1`);
    return out;
  };
  let result: T;
  try {
    result = await (parent ? parent.tx.transaction(body) : getDb().transaction(body));
  } catch (e) {
    scope.closed = true;
    await txStore.exit(() => runHooks([...scope.rollbackHooks].reverse(), "rollback"));
    throw e;
  }
  scope.closed = true;
  if (parent) {
    // تراکنش تودرتو: اثرهای جانبی به تراکنش بیرونی منتقل می‌شوند و فقط با commit نهایی آن اجرا می‌شوند
    parent.commitHooks.push(...scope.commitHooks);
    parent.rollbackHooks.push(...scope.rollbackHooks);
  } else {
    await txStore.exit(() => runHooks(scope.commitHooks, "after-commit"));
  }
  return result;
}

/** اجرای کار جانبی پس از commit موفق (خارج از تراکنش: فوراً). خطای آن هرگز داده‌ی commit‌شده را باطل نمی‌کند. */
export async function afterCommit(fn: Hook): Promise<void> {
  const s = activeScope();
  if (s) {
    s.commitHooks.push(fn);
    return;
  }
  await runHooks([fn], "after-commit");
}

/** جبران اثر غیر-دیتابیسی در صورت rollback (خارج از تراکنش: بی‌اثر) */
export function onRollback(fn: Hook): void {
  activeScope()?.rollbackHooks.push(fn);
}

/** انتظار برای قفل ظرفیت از این مقدار بیشتر طول کشید (سیستم شلوغ است؛ کاربر می‌تواند دوباره تلاش کند) */
export class QuotaLockTimeoutError extends Error {
  constructor() {
    super("سیستم لحظه‌ای شلوغ است؛ چند ثانیه بعد دوباره تلاش کنید.");
    this.name = "QuotaLockTimeoutError";
  }
}

/**
 * قفل مشورتیِ «تراکنشی» برای سریال‌کردن چرخه‌ی «بخوان ← تصمیم بگیر ← بنویس» روی یک سقف (سقف قرارداد/عضو/AI).
 *
 * چرا لازم است: در سطح READ COMMITTED دو تراکنش هم‌زمان هر دو «۹ از ۱۰» می‌خوانند و هر دو می‌نویسند ⇒ ۱۱ (TOCTOU).
 * با گرفتن این قفل «پیش از خواندن شمارنده»، تراکنش دوم تا commit/rollback اولی منتظر می‌ماند و سپس شمارنده‌ی تازه را
 * (با یک اسنپ‌شات جدید) می‌بیند. قفل خودکار با پایان تراکنش آزاد می‌شود؛ هیچ ردیفی قفل نمی‌شود،
 * پس با کلیدهای خارجی/نوشتن‌های دیگر روی فضای کاری تداخل یا بن‌بست نمی‌سازد.
 *
 * فقط داخل `withTransaction` معنا دارد (بیرون از تراکنش قفل بلافاصله آزاد می‌شد و بی‌اثر بود) ⇒ خطا می‌دهد.
 * سقف انتظار پیش‌فرض ۵ ثانیه است (`QUOTA_LOCK_TIMEOUT_MS`؛ P-04): بخش بحرانی میلی‌ثانیه‌ای است و هر منتظرِ قفل یک اتصال
 * استخر را نگه می‌دارد؛ پس اگر همه‌ی اتصال‌ها پشت یک قفل بمانند کل سایت (حتی کاربران فضاهای کاری دیگر) منتظر می‌ماند.
 * برای مسیرهای پرتراکم (مثل سهمیه‌ی AI) پیش از گرفتن اتصال از `withScopeMutex` استفاده کنید تا صف انتظار «بدون اتصال» تشکیل شود.
 */
export async function lockScope(scope: string, id: number): Promise<void> {
  if (!inTransaction()) throw new Error("lockScope فقط داخل withTransaction مجاز است");
  const prev = await db.execute(sql`select current_setting('lock_timeout') as v`);
  const old = String((prev.rows[0] as { v?: string } | undefined)?.v ?? "0");
  await db.execute(sql`select set_config('lock_timeout', ${`${quotaLockTimeoutMs()}ms`}, true)`);
  try {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${scope}), ${id})`);
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === "55P03") throw new QuotaLockTimeoutError();
    throw e;
  }
  await db.execute(sql`select set_config('lock_timeout', ${old}, true)`);
}

/**
 * قفل «درون‌پروسه‌ای» کلیدی (P-04): صف FIFO در حافظه‌ی همین پروسه، پیش از گرفتن اتصال از استخر.
 *
 * مشکل: `lockScope` (قفل مشورتی Postgres) داخل تراکنش گرفته می‌شود؛ یعنی هر درخواستِ منتظر یک اتصال را اشغال می‌کند.
 * هجوم ۲۰ درخواست هم‌زمان برای یک فضای کاری، کل استخر را پشت یک قفل می‌خوابانَد و درخواست‌های بی‌ربط هم timeout می‌خورند.
 * راه‌حل: درخواست‌های هم‌کلید همین پروسه در حافظه صف می‌کشند (بی‌هزینه، بدون اتصال) و فقط «یکی» به دیتابیس می‌رود.
 * قفل مشورتی همچنان برای هم‌زمانی «بین پروسه‌ها/سرورها» لازم است و دست‌نخورده می‌ماند (دو لایه: سریع‌ترین مسیر + صحت سراسری).
 * صف هم سقف انتظار دارد (همان `QUOTA_LOCK_TIMEOUT_MS`) و در صورت عبور `QuotaLockTimeoutError` می‌دهد.
 */
const mutexTails: Map<string, Promise<void>> = ((g as Holder & { __emzMutex?: Map<string, Promise<void>> }).__emzMutex ??= new Map());

export async function withScopeMutex<T>(scope: string, id: number, fn: () => Promise<T>): Promise<T> {
  const key = `${scope}:${id}`;
  const prev = mutexTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => gate);
  mutexTails.set(key, tail);
  void tail.then(() => {
    if (mutexTails.get(key) === tail) mutexTails.delete(key);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const acquired = await Promise.race([
    prev.then(() => true),
    new Promise<false>((res) => {
      timer = setTimeout(() => res(false), quotaLockTimeoutMs());
    }),
  ]);
  clearTimeout(timer);
  if (!acquired) {
    // صف را نمی‌شکنیم: نفرات بعدی پشت «نوبت» ما نمی‌مانند و به‌محض آزاد شدن نفر قبلی نوبت ما رد می‌شود
    void prev.then(release);
    throw new QuotaLockTimeoutError();
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/** وضعیت لحظه‌ای استخر (برای پایش و آزمون) */
export function poolStats(): { max: number; total: number; idle: number; waiting: number } {
  const p = getPool();
  return { max: (p.options as { max?: number }).max ?? 0, total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount };
}

/** اجرای کد روی اتصال عادی، مستقل از تراکنش جاری (نوشته‌های آن با rollback برنمی‌گردند) */
export function outsideTransaction<T>(fn: () => T): T {
  return txStore.exit(fn);
}

function lazy<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = resolve();
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

export const pool: Pool = lazy(getPool);
/** در داخل `withTransaction` همان تراکنش جاری است، وگرنه اتصال عادی */
export const db: NodePgDatabase = lazy(() => (activeScope()?.tx as unknown as NodePgDatabase | undefined) ?? getDb());

/**
 * R-02: پایان خاموشی — استخر فقط وقتی بسته می‌شود که هیچ اتصالِ «در حال استفاده» نمانده باشد (درخواست‌های در حال تخلیه‌ی Next
 * نباید «Cannot use a pool after calling end» بگیرند). اگر مهلت تمام شد، بستن را به خروج پروسه می‌سپاریم (سیستم‌عامل سوکت‌ها را می‌بندد).
 */
onShutdown(
  "db-pool",
  async (ctx) => {
    const p = g.__emzPool;
    if (!p || !ctx.exiting) return; // فقط وقتی پروسه واقعاً در حال خروج است
    const idle = await waitUntil(() => p.totalCount - p.idleCount <= 0, ctx.deadline - 500);
    if (idle) await p.end().catch(() => undefined);
  },
  90,
);
