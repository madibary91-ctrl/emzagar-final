/**
 * کش درون‌پروسه‌ای کوچک با سه ویژگی که برای «داده‌ی داغ و کم‌تغییر» لازم است:
 *
 *  ۱) TTL کوتاه: در استقرار چندنمونه‌ای هر پروسه حداکثر `ttl` میلی‌ثانیه داده‌ی کهنه می‌بیند (نوشتن در همان پروسه فوراً دیده می‌شود).
 *  ۲) Single-flight: ده‌ها درخواست هم‌زمانِ یک کلید فقط یک کوئری دیتابیس می‌سازند (ضد «هجوم کش»).
 *  ۳) نسل (generation): اگر بین شروع بارگذاری و پایان آن `invalidate` صدا زده شود، نتیجه‌ی کهنه‌ی در حال بارگذاری در کش نمی‌نشیند
 *     (شرط رقابتی «خواندن قدیمی ← نوشتن جدید ← ذخیره‌ی قدیمی در کش» ممکن نیست).
 *
 * در `NODE_ENV=test` پیش‌فرض خاموش است (TTL=۰): آزمون‌های موجود داده را مستقیم در دیتابیس دست می‌زنند و باید همیشه تازه‌ترین مقدار را ببینند.
 * آزمون‌های اختصاصی کش با `setCacheTtlOverride` آن را روشن می‌کنند.
 */
type Holder = typeof globalThis & { __emzCacheTtlOverride?: number | null; __emzCaches?: Set<TtlCache<unknown, unknown>> };
const g = globalThis as Holder;

/** فقط برای آزمون: null = رفتار پیش‌فرض */
export function setCacheTtlOverride(ms: number | null): void {
  g.__emzCacheTtlOverride = ms;
  clearAllCaches();
}

function envTtl(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.trunc(n), 3_600_000) : def;
}

/** TTL مؤثر یک کش: override آزمون ← env ← پیش‌فرض (در test = ۰) */
export function effectiveTtl(envName: string, def: number): number {
  if (g.__emzCacheTtlOverride != null) return g.__emzCacheTtlOverride;
  if (process.env.NODE_ENV === "test" && process.env[envName] === undefined) return 0;
  return envTtl(envName, def);
}

interface Entry<V> {
  value: V;
  at: number;
}

export class TtlCache<K, V> {
  private map = new Map<K, Entry<V>>();
  private inflight = new Map<K, Promise<V>>();
  private gen = 0;
  hits = 0;
  loads = 0;

  constructor(
    private readonly envName: string,
    private readonly defaultTtlMs: number,
    private readonly maxEntries = 1000,
  ) {
    (g.__emzCaches ??= new Set()).add(this as TtlCache<unknown, unknown>);
  }

  private ttl(): number {
    return effectiveTtl(this.envName, this.defaultTtlMs);
  }

  async get(key: K, load: () => Promise<V>): Promise<V> {
    const ttl = this.ttl();
    if (ttl <= 0) return load();
    const now = Date.now();
    const e = this.map.get(key);
    if (e && now - e.at < ttl) {
      this.hits++;
      return e.value;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const gen = this.gen;
    this.loads++;
    const p: Promise<V> = load()
      .then((v) => {
        if (gen === this.gen) this.put(key, v);
        return v;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  private put(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, at: Date.now() });
    // سقف اندازه (LRU ساده بر پایه‌ی ترتیب درج): قدیمی‌ترین‌ها حذف می‌شوند
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** key خاص یا (بدون آرگومان) همه؛ بارگذاری‌های در جریان هم بی‌اعتبار می‌شوند */
  invalidate(key?: K): void {
    this.gen++;
    this.inflight.clear();
    if (key === undefined) this.map.clear();
    else this.map.delete(key);
  }

  /** مقدار تازه‌ی موجود در کش بدون بارگذاری (برای batch) */
  peek(key: K): V | undefined {
    const ttl = this.ttl();
    if (ttl <= 0) return undefined;
    const e = this.map.get(key);
    return e && Date.now() - e.at < ttl ? e.value : undefined;
  }

  /** ذخیره‌ی مقدار بارگذاری‌شده‌ی بیرونی (batch)؛ اگر در این فاصله invalidate شده باشد (gen) نادیده گرفته می‌شود */
  store(key: K, value: V, genAtStart: number): void {
    if (this.ttl() > 0 && genAtStart === this.gen) this.put(key, value);
  }

  generation(): number {
    return this.gen;
  }

  get size(): number {
    return this.map.size;
  }
}

export function clearAllCaches(): void {
  for (const c of g.__emzCaches ?? []) c.invalidate();
}
