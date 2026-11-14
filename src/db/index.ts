import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "@/lib/config";

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
  if (g.__emzPool && g.__emzPoolUrl === url) return g.__emzPool;
  if (g.__emzPool) void g.__emzPool.end().catch(() => undefined);
  const next = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000 });
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
