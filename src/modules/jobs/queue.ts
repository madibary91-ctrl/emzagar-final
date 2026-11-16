import { sql } from "drizzle-orm";
import { afterCommit, db } from "@/db";
import { backgroundJobs } from "@/db/schema";
import { isShuttingDown, onShutdown, waitUntil } from "@/lib/shutdown";
import { envInt } from "@/lib/semaphore";
import { CircuitOpenError, withJitter } from "@/lib/resilience";

/**
 * صف کارهای پس‌زمینه‌ی ماندگار (PERF-03).
 *
 * - `enqueueJob` داخل تراکنش جاری درج می‌شود (الگوی Outbox): اگر تراکنش برگردد، کار هم نیست؛ اگر commit شود، کار حتماً اجرا می‌شود.
 * - پس از commit، پردازشگر «بیرون از مسیر پاسخ» بیدار می‌شود (`setImmediate`)؛ درخواست کاربر منتظر PDF/SMTP نمی‌ماند.
 * - برداشتن کار با `FOR UPDATE SKIP LOCKED` و اجاره (lease) انجام می‌شود؛ چند پردازه امن‌اند و کارِ رهاشده بازیابی می‌شود.
 * - شکست = تلاش دوباره با backoff نمایی (۳۰ثانیه … ۱ ساعت) تا `maxAttempts`، سپس وضعیت `dead` و hook ‌ی `onDead`.
 * - R-01: `dedupeKey` فقط «کارِ زنده یا تازه‌تمام‌شده» را یکتا می‌کند. کارِ `dead` کلید را قفل نمی‌کند: درج دوباره با همان کلید
 *   همان ردیف را «احیا» می‌کند (attempts=0، pending) تا نسخه‌ی نهایی/ایمیل برای همیشه گم نشود. کارهای `dead` پس از ۳۰ روز پاک می‌شوند.
 * - R-02: هنگام SIGTERM پردازشگر کار تازه برنمی‌دارد، تا مهلت منتظر کارهای در جریان می‌ماند و اجاره‌ی باقی‌مانده را آزاد می‌کند
 *   (بدون مصرف تلاش) تا پس از دیپلوی فوراً دوباره برداشته شوند، نه ۵ دقیقه بعد.
 * - P-06: پردازشگر «سریالی» نیست. در background تا `JOBS_CONCURRENCY` (پیش‌فرض ۴) کار هم‌زمان در هر پروسه اجرا می‌شود؛ یک SMTP کند یا
 *   وب‌هوک معلق دیگر کارهای کوتاه (اعلان، ارسال پیام‌رسان) و PDF نهایی را پشت خود نگه نمی‌دارد (head-of-line blocking). کارهای سنگین
 *   سقف نوعی دارند (`contract.finalize` ≤ ۲ هم‌زمان؛ رندر PDF هم سمافور جدا دارد) تا هم‌زمانی CPU/حافظه را نترکاند.
 *   بین چند پروسه از قبل با `FOR UPDATE SKIP LOCKED` امن بود؛ پس توان کل = پروسه‌ها × JOBS_CONCURRENCY.
 * - حالت `inline` (پیش‌فرض فقط در NODE_ENV=test): همان handlerها پس از commit «همگام» اجرا می‌شوند تا آزمون‌های
 *   موجود بدون انتظار/poll نتیجه را ببینند. در production همیشه `background` است.
 */
export type JobPayload = Record<string, unknown>;
export interface JobContext {
  attempt: number;
  maxAttempts: number;
  last: boolean;
}
export interface JobHandlerDef {
  run: (payload: JobPayload, ctx: JobContext) => Promise<void>;
  /** پس از آخرین شکست (وضعیت dead) */
  onDead?: (payload: JobPayload, error: string) => Promise<void>;
}

type Holder = typeof globalThis & {
  __emzJobsMode?: "inline" | "background";
  __emzJobsPaused?: boolean;
  __emzJobsChain?: Promise<void>;
  __emzJobsTimer?: ReturnType<typeof setInterval>;
  __emzJobsRunning?: Set<number>;
  __emzJobsByType?: Map<string, number>;
  __emzJobsLive?: number;
  __emzJobsWake?: number;
  __emzJobsWorkers?: Set<Promise<void>>;
  __emzJobsClaim?: Promise<unknown>;
  __emzJobsPurgeAt?: number;
};
const g = globalThis as Holder;

const handlers = new Map<string, JobHandlerDef>();
export function registerJobHandler(type: string, def: JobHandlerDef): void {
  handlers.set(type, def);
}

/** برای آزمون‌ها و عیب‌یابی */
export function setJobsMode(mode: "inline" | "background" | undefined): void {
  g.__emzJobsMode = mode;
}
/** توقف موقت برداشتن کار (نگهداری/آزمون): کارها در صف می‌مانند و از بین نمی‌روند */
export function setJobsPaused(paused: boolean): void {
  g.__emzJobsPaused = paused;
}
export function jobsMode(): "inline" | "background" {
  if (g.__emzJobsMode) return g.__emzJobsMode;
  const env = process.env.JOBS_MODE;
  if (env === "inline" || env === "background") return env;
  return process.env.NODE_ENV === "test" ? "inline" : "background";
}

const LEASE_MS = 5 * 60_000;

/** سقف هم‌زمانی کل در هر پروسه (حالت inline = ۱ تا رفتار آزمون‌ها همگام و قطعی بماند) */
export function jobsConcurrency(): number {
  return jobsMode() === "inline" ? 1 : envInt("JOBS_CONCURRENCY", 4, 1, 32);
}
/** سقف هم‌زمانی هر نوع کار (نوع‌های سنگین)؛ نوع‌های بدون سقف فقط تابع سقف کل‌اند */
export function jobTypeLimit(type: string): number {
  if (type === "contract.finalize") return Math.min(envInt("JOBS_FINALIZE_CONCURRENCY", 2, 1, 16), jobsConcurrency());
  return Number.POSITIVE_INFINITY;
}
const LIMITED_TYPES = ["contract.finalize"];
const byType = (): Map<string, number> => (g.__emzJobsByType ??= new Map<string, number>());
/**
 * R-0x: backoff نمایی «با jitter». بدون jitter، همه‌ی کارهای شکست‌خورده در یک قطعی (SMTP/پنل پیامک) دقیقاً در یک لحظه دوباره
 * اجرا می‌شدند و سرویسِ تازه‌برخاسته را زیر موج هم‌زمان می‌بردند. محدوده‌ی نهایی: [نیمی از مقدار، کل مقدار].
 */
export const backoffMs = (attempt: number, rnd: () => number = Math.random) => withJitter(Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000), rnd);

/** خطای «دائمی»: تلاش دوباره بی‌فایده است (شماره/ایمیل نامعتبر، گیرنده‌ی ردشده) ⇒ کار فوراً dead می‌شود و تلاش‌ها نمی‌سوزند */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
/**
 * خطای «بعداً»: سرویس بیرونی موقتاً خراب است (قطع‌کننده‌ی مدار باز است یا Retry-After داده). کار بدون مصرف تلاش به `delayMs` دیگر موکول می‌شود
 * (تا ۶ ساعت از ساخت کار؛ پس از آن مثل خطای عادی تلاش می‌سوزد تا کارِ بی‌انتها در صف نماند).
 */
export class RetryLaterError extends Error {
  constructor(message: string, public readonly delayMs: number) {
    super(message);
    this.name = "RetryLaterError";
  }
}
const REFUND_WINDOW_MS = 6 * 3600_000;

export async function enqueueJob(
  type: string,
  payload: JobPayload,
  opts: { dedupeKey?: string; delayMs?: number; maxAttempts?: number; /** false = فقط درج (پردازشگر خودش ادامه می‌دهد) */ kick?: boolean } = {},
): Promise<void> {
  const runAt = new Date(Date.now() + (opts.delayMs ?? 0));
  const body = JSON.stringify(payload);
  await db
    .insert(backgroundJobs)
    .values({
      type,
      payload: body,
      dedupeKey: opts.dedupeKey ?? null,
      runAt,
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    // R-01: تعارض با کارِ pending/running/done = تکراری (نادیده)؛ تعارض با کارِ dead = احیا (فقط همان ردیف، اتمی)
    .onConflictDoUpdate({
      target: backgroundJobs.dedupeKey,
      set: {
        type,
        payload: body,
        status: "pending",
        attempts: 0,
        runAt,
        lockedUntil: null,
        finishedAt: null,
        ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
      },
      setWhere: sql`${backgroundJobs.status} = 'dead'`,
    });
  if (opts.kick !== false) await afterCommit(kickJobs);
}

/**
 * درج دسته‌ای کارها با «یک» INSERT (P-08). معنا برای هر ردیف دقیقاً مثل enqueueJob است (تکراری = نادیده، dead = احیا)،
 * با یک kick پس از commit به‌جای N بار. کلیدهای تکراریِ داخل همان دسته (که PostgreSQL در یک INSERT رد می‌کند) پیش از درج یکی می‌شوند.
 */
export async function enqueueJobs(items: { type: string; payload: JobPayload; dedupeKey?: string; delayMs?: number; maxAttempts?: number }[], opts: { kick?: boolean } = {}): Promise<number> {
  if (items.length === 0) return 0;
  const seen = new Set<string>();
  const rows = items.filter((it) => {
    if (!it.dedupeKey) return true;
    if (seen.has(it.dedupeKey)) return false;
    seen.add(it.dedupeKey);
    return true;
  });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await db
      .insert(backgroundJobs)
      .values(
        part.map((it) => ({
          type: it.type,
          payload: JSON.stringify(it.payload),
          dedupeKey: it.dedupeKey ?? null,
          runAt: new Date(Date.now() + (it.delayMs ?? 0)),
          ...(it.maxAttempts ? { maxAttempts: it.maxAttempts } : {}),
        })),
      )
      .onConflictDoUpdate({
        target: backgroundJobs.dedupeKey,
        set: {
          type: sql`excluded.type`,
          payload: sql`excluded.payload`,
          status: "pending",
          attempts: 0,
          runAt: sql`excluded.run_at`,
          lockedUntil: null,
          finishedAt: null,
          ...(part.some((it) => it.maxAttempts) ? { maxAttempts: sql`excluded.max_attempts` } : {}),
        },
        setWhere: sql`${backgroundJobs.status} = 'dead'`,
      });
  }
  if (opts.kick !== false) await afterCommit(kickJobs);
  return rows.length;
}

/** پس از commit: در حالت inline منتظر اتمام؛ در background بیدار کردن پردازشگر بدون انتظار */
export async function kickJobs(): Promise<void> {
  if (jobsMode() === "inline") {
    await drainJobs();
    return;
  }
  startJobWorker();
  setImmediate(() => void drainJobs().catch((e) => console.error("[jobs:kick]", e)));
}

interface Claimed {
  id: number;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
  created_at?: Date | string | null;
}

async function claimNext(exclude: string[] = []): Promise<Claimed | null> {
  const notIn = exclude.length ? sql` and type not in (${sql.join(exclude.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db.execute(sql`
    update background_jobs set status = 'running', attempts = attempts + 1, locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval
    where id = (
      select id from background_jobs
      where ((status = 'pending' and run_at <= now()) or (status = 'running' and locked_until < now()))${notIn}
      order by run_at, id
      for update skip locked
      limit 1
    )
    returning id, type, payload, attempts, max_attempts, created_at`);
  return (res.rows[0] as unknown as Claimed | undefined) ?? null;
}

const runningIds = (): Set<number> => (g.__emzJobsRunning ??= new Set<number>());

/**
 * برداشتن کار با رعایت سقف نوعی. برداشت‌ها در همین پروسه پشت‌سرهم (mutex) انجام می‌شوند تا شمارنده‌ی «در حال اجرا»ی کارِ قبلی
 * پیش از محاسبه‌ی فهرست «نوع‌های پر» ثبت شده باشد (وگرنه چند کارگر هم‌زمان می‌توانستند سقف را رد کنند). هزینه: یک UPDATE میلی‌ثانیه‌ای.
 */
function claimExclusive(): Promise<Claimed | null> {
  const run = (async () => {
    await Promise.resolve(g.__emzJobsClaim).catch(() => undefined);
  })().then(async () => {
    const full = LIMITED_TYPES.filter((t) => (byType().get(t) ?? 0) >= jobTypeLimit(t));
    const job = await claimNext(full);
    if (job) {
      byType().set(job.type, (byType().get(job.type) ?? 0) + 1);
      runningIds().add(job.id);
    }
    return job;
  });
  g.__emzJobsClaim = run.catch(() => undefined);
  return run;
}

async function runClaimed(job: Claimed): Promise<void> {
  try {
    await runClaimedInner(job);
  } finally {
    runningIds().delete(job.id);
    const n = (byType().get(job.type) ?? 1) - 1;
    if (n <= 0) byType().delete(job.type);
    else byType().set(job.type, n);
  }
}

async function runClaimedInner(job: Claimed): Promise<void> {
  const def = handlers.get(job.type);
  let payload: JobPayload = {};
  try {
    payload = JSON.parse(job.payload) as JobPayload;
  } catch {
    /* payload خراب: handler خودش خطا می‌دهد */
  }
  const last = job.attempts >= job.max_attempts;
  try {
    if (!def) throw new Error(`handler ثبت‌نشده: ${job.type}`);
    await def.run(payload, { attempt: job.attempts, maxAttempts: job.max_attempts, last });
    await db.execute(sql`update background_jobs set status = 'done', finished_at = now(), locked_until = null, last_error = null where id = ${job.id}`);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    const later = e instanceof RetryLaterError ? e : e instanceof CircuitOpenError ? new RetryLaterError(e.message, e.retryAfterMs) : null;
    const ageMs = job.created_at ? Date.now() - new Date(job.created_at).getTime() : Number.POSITIVE_INFINITY;
    if (later && def && ageMs < REFUND_WINDOW_MS) {
      // سرویس بیرونی خراب است نه کار: بدون مصرف تلاش، با jitter به بعد موکول می‌شود
      const at = new Date(Date.now() + withJitter(Math.min(Math.max(later.delayMs, 5_000), 10 * 60_000)));
      await db.execute(sql`update background_jobs set status = 'pending', attempts = greatest(attempts - 1, 0), run_at = ${at}, locked_until = null, last_error = ${msg} where id = ${job.id}`);
      console.warn(`[jobs:defer] ${job.type}#${job.id}: ${msg}`);
      return;
    }
    if (last || !def || e instanceof PermanentJobError) {
      await db.execute(sql`update background_jobs set status = 'dead', finished_at = now(), locked_until = null, last_error = ${msg} where id = ${job.id}`);
      console.error(`[jobs:dead] ${job.type}#${job.id}: ${msg}`);
      try {
        await def?.onDead?.(payload, msg);
      } catch (e2) {
        console.error("[jobs:onDead]", e2);
      }
    } else {
      const at = new Date(Date.now() + backoffMs(job.attempts));
      await db.execute(sql`update background_jobs set status = 'pending', run_at = ${at}, locked_until = null, last_error = ${msg} where id = ${job.id}`);
      console.warn(`[jobs:retry] ${job.type}#${job.id} (تلاش ${job.attempts}/${job.max_attempts}): ${msg}`);
    }
  }
}

/** حلقه‌ی یک کارگر: تا خالی‌شدن صف (یا توقف/خاموشی) کار برمی‌دارد و اجرا می‌کند */
async function workerLoop(pooled: boolean): Promise<void> {
  try {
    await ensureHandlers();
    await workerBody();
  } finally {
    // هم‌زمان (synchronous) با خروج، شمارنده کم می‌شود تا kickِ همزمان با خروج، کارگر جایگزین را بسازد
    if (pooled) g.__emzJobsLive = Math.max((g.__emzJobsLive ?? 1) - 1, 0);
  }
}
async function workerBody(): Promise<void> {
  for (let i = 0; !g.__emzJobsPaused && !isShuttingDown() && i < 1000; i++) {
    // اگر حین برداشتنِ «خالی»، کارِ تازه‌ای کوبیده شده (kick)، یک بار دیگر می‌پرسیم؛ کارِ تازه نباید تا تیک ۱۵ثانیه‌ای بماند
    const epoch = g.__emzJobsWake ?? 0;
    const job = await claimExclusive();
    if (!job) {
      if ((g.__emzJobsWake ?? 0) !== epoch) continue;
      return;
    }
    await runClaimed(job);
  }
}

const workers = (): Set<Promise<void>> => (g.__emzJobsWorkers ??= new Set<Promise<void>>());

/**
 * پردازش همه‌ی کارهای سررسیده‌شده.
 * - background: تا `jobsConcurrency()` کارگر هم‌زمان (هرکدام کار بعدی را مستقل برمی‌دارد)؛ فراخوان تا خالی‌شدن صف منتظر می‌ماند.
 * - inline (آزمون): همان رفتار قدیمی؛ «سریالی» و فراخوان‌کننده تا پایان کارهای پیش از خودش منتظر می‌ماند.
 */
export function drainJobs(): Promise<void> {
  if (jobsMode() === "inline") {
    const prev = g.__emzJobsChain ?? Promise.resolve();
    const next = prev.then(() => workerLoop(false), () => workerLoop(false)).catch((e) => console.error("[jobs:drain]", e));
    g.__emzJobsChain = next;
    return next;
  }
  g.__emzJobsWake = (g.__emzJobsWake ?? 0) + 1;
  while ((g.__emzJobsLive ?? 0) < jobsConcurrency() && !g.__emzJobsPaused && !isShuttingDown()) {
    g.__emzJobsLive = (g.__emzJobsLive ?? 0) + 1;
    const p: Promise<void> = workerLoop(true)
      .catch((e) => console.error("[jobs:worker]", e))
      .finally(() => void workers().delete(p));
    workers().add(p);
  }
  return Promise.all([...workers()]).then(() => undefined);
}

/** برای آزمون/عیب‌یابی: وضعیت لحظه‌ای کارگرها */
export function jobWorkerStats(): { live: number; running: number; byType: Record<string, number>; concurrency: number } {
  return { live: g.__emzJobsLive ?? 0, running: runningIds().size, byType: Object.fromEntries(byType()), concurrency: jobsConcurrency() };
}

let handlersLoaded: Promise<unknown> | null = null;
async function ensureHandlers(): Promise<void> {
  // وارد کردن تنبل: handlerها ماژول‌های سنگین (PDF/ایمیل) را می‌کشند و نباید چرخه‌ی import بسازند
  handlersLoaded ??= import("./handlers");
  await handlersLoaded;
}

/** پردازشگر دوره‌ای (هر ۱۵ ثانیه): کارهای retry، کارهای مانده از ری‌استارت و پاکسازی کارهای تمام‌شده */
export function startJobWorker(): void {
  if (g.__emzJobsTimer || jobsMode() === "inline") return;
  g.__emzJobsTimer = setInterval(() => {
    void drainJobs();
    // R-01: پاک‌سازی کارهای تمام‌شده/مرده؛ دسته‌ای و حداکثر هر ۱۰ دقیقه (نه DELETE کامل هر ۱۵ ثانیه)
    if (Date.now() - (g.__emzJobsPurgeAt ?? 0) >= PURGE_EVERY_MS) {
      g.__emzJobsPurgeAt = Date.now();
      void purgeFinishedJobs().catch((e) => console.error("[jobs:purge]", e instanceof Error ? e.message : e));
    }
  }, 15_000);
  g.__emzJobsTimer.unref?.();
  void drainJobs();
}

const PURGE_EVERY_MS = 10 * 60_000;
/**
 * R-01: پاک‌سازی ماندگار صف. کارِ `done` پس از `doneDays` (۷) و کارِ `dead` پس از `deadDays` (۳۰) حذف می‌شود.
 *  - مبنا «زمان پایان» است؛ ردیف‌های قدیمیِ بدون finished_at (مثلاً dead شده با نسخه‌های قدیمی‌تر) به‌جایش از created_at سنجیده می‌شوند
 *    (وگرنه `NULL < x` هرگز درست نمی‌شد و آن‌ها برای همیشه می‌ماندند و dedupeKey را اشغال می‌کردند).
 *  - دسته‌ای (`batch` ردیف در هر DELETE) تا جدول بزرگ قفل طولانی و WAL انفجاری نسازد؛ SKIP LOCKED با کارگرهای زنده تداخل ندارد.
 *  - کارِ pending/running هرگز پاک نمی‌شود.
 */
export async function purgeFinishedJobs(o: { doneDays?: number; deadDays?: number; batch?: number; maxBatches?: number } = {}): Promise<{ done: number; dead: number }> {
  const batch = Math.max(1, Math.min(10_000, o.batch ?? 1000));
  const maxBatches = Math.max(1, o.maxBatches ?? 50);
  const doneDays = o.doneDays ?? 7;
  const deadDays = o.deadDays ?? 30;
  const out = { done: 0, dead: 0 };
  for (const [status, days] of [["done", doneDays], ["dead", deadDays]] as const) {
    for (let i = 0; i < maxBatches; i++) {
      const res = await db.execute(sql`
        delete from background_jobs where id in (
          select id from background_jobs
           where status = ${status} and coalesce(finished_at, created_at) < now() - (${days}::double precision * interval '1 day')
           order by id limit ${batch} for update skip locked)
        returning id`);
      out[status] += res.rows.length;
      if (res.rows.length < batch) break;
    }
  }
  return out;
}

export async function jobStats(): Promise<Record<string, number>> {
  const res = await db.execute(sql`select status, count(*)::int as n from background_jobs group by status`);
  const out: Record<string, number> = { pending: 0, running: 0, done: 0, dead: 0 };
  for (const r of res.rows as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}

/**
 * R-02: خاموشی نرم صف. ۱) برداشتن کار تازه متوقف می‌شود (isShuttingDown در loop)، ۲) تا مهلت‌ِ «تخلیه» منتظر کارهای در جریان
 * می‌مانیم، ۳) اجاره‌ی کارهایی که هنوز تمام نشده‌اند آزاد می‌شود و تلاش مصرف‌شده‌شان برمی‌گردد.
 */
export async function releaseRunningJobs(): Promise<number> {
  const ids = [...runningIds()];
  if (ids.length === 0) return 0;
  const res = await db.execute(sql`
    update background_jobs
       set status = 'pending', attempts = greatest(attempts - 1, 0), locked_until = null, run_at = now(), last_error = 'interrupted: shutdown'
     where status = 'running' and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    returning id`);
  return res.rows.length;
}

onShutdown(
  "jobs",
  async (ctx) => {
    if (g.__emzJobsTimer) {
      clearInterval(g.__emzJobsTimer);
      g.__emzJobsTimer = undefined;
    }
    const drained = await waitUntil(() => runningIds().size === 0, ctx.drainDeadline);
    if (!drained) {
      const n = await releaseRunningJobs();
      console.warn(`[shutdown:jobs] ${n} کار نیمه‌تمام آزاد شد تا پس از ری‌استارت فوراً اجرا شود`);
    }
  },
  20,
);
