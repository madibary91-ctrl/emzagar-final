/**
 * پیکربندی استخر اتصال PostgreSQL (P-04) — تابع خالص و بدون وابستگی تا آزمون‌پذیر باشد.
 *
 * پیش‌تر `max` روی ۱۰ هاردکد بود: برنامه نه با سخت‌افزار بزرگ‌تر مقیاس می‌گرفت و نه با Postgres کوچک‌تر سازگار می‌شد.
 * اکنون همه‌چیز با متغیر محیطی تنظیم می‌شود و مقدارهای نامعتبر بی‌صدا به پیش‌فرض امن برمی‌گردند (هرگز کرش نمی‌کند).
 *
 *  - DB_POOL_MAX              حداکثر اتصال این پروسه (پیش‌فرض ۲۰؛ بازه‌ی ۲ تا ۲۰۰).
 *                             قاعده‌ی سرانگشتی: (max_connections پستگرس − ۱۰) ÷ تعداد پروسه‌ها.
 *  - DB_POOL_IDLE_MS          آزادسازی اتصال بی‌کار (پیش‌فرض ۳۰ ثانیه) تا پس از اوج بار منابع Postgres آزاد شود.
 *  - DB_CONNECT_TIMEOUT_MS    حداکثر انتظار برای گرفتن اتصال از استخر (پیش‌فرض ۱۰ ثانیه).
 *  - DB_IDLE_TX_TIMEOUT_MS    تراکنشِ رهاشده (BEGIN بدون ادامه) توسط خود Postgres بسته می‌شود تا قفل‌ها (از جمله قفل‌های
 *                             مشورتی سهمیه) برای همیشه نمانند (پیش‌فرض ۵ دقیقه؛ ۰ = خاموش، برای PgBouncer در حالت transaction).
 *  - QUOTA_LOCK_TIMEOUT_MS    سقف انتظار برای قفل‌های ظرفیت (پیش‌فرض ۵ ثانیه؛ بازه‌ی ۰٫۵ تا ۳۰ ثانیه). بخش بحرانی میلی‌ثانیه‌ای است؛
 *                             انتظار بیش از چند ثانیه یعنی مشکل واقعی و بهتر است کاربر «سیستم شلوغ است» ببیند تا اتصال را بسوزاند.
 */
export interface PoolSettings {
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  /** رشته‌ی `options` پروتکل Postgres (یا undefined) */
  options: string | undefined;
  applicationName: string;
}

type Env = Record<string, string | undefined>;

function intIn(raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export const DEFAULT_POOL_MAX = 20;
export const DEFAULT_QUOTA_LOCK_TIMEOUT_MS = 5_000;

export function resolvePoolSettings(env: Env = process.env): PoolSettings {
  const idleTx = intIn(env.DB_IDLE_TX_TIMEOUT_MS, 300_000, 0, 3_600_000);
  return {
    max: intIn(env.DB_POOL_MAX, DEFAULT_POOL_MAX, 2, 200),
    idleTimeoutMillis: intIn(env.DB_POOL_IDLE_MS, 30_000, 1_000, 600_000),
    connectionTimeoutMillis: intIn(env.DB_CONNECT_TIMEOUT_MS, 10_000, 1_000, 120_000),
    options: idleTx > 0 ? `-c idle_in_transaction_session_timeout=${idleTx}` : undefined,
    applicationName: "emzagar",
  };
}

export function quotaLockTimeoutMs(env: Env = process.env): number {
  return intIn(env.QUOTA_LOCK_TIMEOUT_MS, DEFAULT_QUOTA_LOCK_TIMEOUT_MS, 500, 30_000);
}
