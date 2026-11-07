import { sql } from "drizzle-orm";
import { afterCommit, db } from "@/db";
import { backgroundJobs } from "@/db/schema";

/**
 * صف کارهای پس‌زمینه‌ی ماندگار (PERF-03).
 *
 * - `enqueueJob` داخل تراکنش جاری درج می‌شود (الگوی Outbox): اگر تراکنش برگردد، کار هم نیست؛ اگر commit شود، کار حتماً اجرا می‌شود.
 * - پس از commit، پردازشگر «بیرون از مسیر پاسخ» بیدار می‌شود (`setImmediate`)؛ درخواست کاربر منتظر PDF/SMTP نمی‌ماند.
 * - برداشتن کار با `FOR UPDATE SKIP LOCKED` و اجاره (lease) انجام می‌شود؛ چند پردازه امن‌اند و کارِ رهاشده بازیابی می‌شود.
 * - شکست = تلاش دوباره با backoff نمایی (۳۰ثانیه … ۱ ساعت) تا `maxAttempts`، سپس وضعیت `dead` و hook ‌ی `onDead`.
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
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 3_600_000);

export async function enqueueJob(
  type: string,
  payload: JobPayload,
  opts: { dedupeKey?: string; delayMs?: number; maxAttempts?: number; /** false = فقط درج (پردازشگر خودش ادامه می‌دهد) */ kick?: boolean } = {},
): Promise<void> {
  await db
    .insert(backgroundJobs)
    .values({
      type,
      payload: JSON.stringify(payload),
      dedupeKey: opts.dedupeKey ?? null,
      runAt: new Date(Date.now() + (opts.delayMs ?? 0)),
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
    })
    .onConflictDoNothing();
  if (opts.kick !== false) await afterCommit(kickJobs);
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
}

async function claimNext(): Promise<Claimed | null> {
  const res = await db.execute(sql`
    update background_jobs set status = 'running', attempts = attempts + 1, locked_until = now() + ${`${LEASE_MS} milliseconds`}::interval
    where id = (
      select id from background_jobs
      where (status = 'pending' and run_at <= now()) or (status = 'running' and locked_until < now())
      order by run_at, id
      for update skip locked
      limit 1
    )
    returning id, type, payload, attempts, max_attempts`);
  return (res.rows[0] as unknown as Claimed | undefined) ?? null;
}

async function runClaimed(job: Claimed): Promise<void> {
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
    if (last || !def) {
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

async function loop(): Promise<void> {
  await ensureHandlers();
  for (let i = 0; !g.__emzJobsPaused && i < 1000; i++) {
    const job = await claimNext();
    if (!job) return;
    await runClaimed(job);
  }
}

/**
 * پردازش همه‌ی کارهای سررسیده‌شده. در هر پردازه «سریالی» اجرا می‌شود: هیچ‌گاه چند PDF هم‌زمان ساخته نمی‌شود
 * و فراخوان‌کننده تا پایان کارهای پیش از خودش منتظر می‌ماند.
 */
export function drainJobs(): Promise<void> {
  const prev = g.__emzJobsChain ?? Promise.resolve();
  const next = prev.then(loop, loop).catch((e) => console.error("[jobs:drain]", e));
  g.__emzJobsChain = next;
  return next;
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
    void db.execute(sql`delete from background_jobs where status = 'done' and finished_at < now() - interval '7 days'`).catch(() => undefined);
  }, 15_000);
  g.__emzJobsTimer.unref?.();
  void drainJobs();
}

export async function jobStats(): Promise<Record<string, number>> {
  const res = await db.execute(sql`select status, count(*)::int as n from background_jobs group by status`);
  const out: Record<string, number> = { pending: 0, running: 0, done: 0, dead: 0 };
  for (const r of res.rows as { status: string; n: number }[]) out[r.status] = r.n;
  return out;
}
