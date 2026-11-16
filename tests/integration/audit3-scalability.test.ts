/**
 * GLM Audit 3 — مقیاس‌پذیری و پایداری (P-04 · R-03 · D-04 · R-01 · R-02)
 *
 * هر بخش یا یک باگِ واقعی را قفل می‌کند (ردِ «قبل از اصلاح» و «بعد از اصلاح») یا
 * با آزمون ثابت می‌کند که ادعا نادرست (False Positive) بوده است (R-03).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, lockScope, poolStats, QuotaLockTimeoutError, withScopeMutex, withTransaction } from "@/db";
import { DEFAULT_POOL_MAX, quotaLockTimeoutMs, resolvePoolSettings } from "@/db/pool-config";
import { aiGenerations, backgroundJobs, notifications, payments, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { REDACTED_BODY, bodyTtlMinutes, outboxBody, retentionDays, storeOutboxBodies } from "@/lib/outbox-policy";
import { __resetShutdownForTests, isShuttingDown, runShutdown, shutdownGraceMs } from "@/lib/shutdown";
import { openAiReservationCount, reapStaleAiReservations, reserveAiQuota } from "@/modules/ai/quota";
import { usageToday } from "@/modules/ai/service";
import { AI_RESERVATION_TTL_MS } from "@/modules/ai/quota-status";
import { getSubscription, reconcilePendingPayments, startCheckout } from "@/modules/billing/service";
import { drainJobs, enqueueJob, registerJobHandler, setJobsMode } from "@/modules/jobs/queue";
import { sendMail } from "@/modules/mail";
import { purgeOutbox } from "@/modules/mail/retention";
import { sendSms } from "@/modules/sms";
import { createWorkspace } from "@/modules/tenancy/service";
import { GET as healthGet } from "@/app/api/health/route";
import { SimClient, startSimulator, type SimHandle } from "../../simulator";
import { uniq } from "../helpers";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let seq = 0;
async function newOwner(label: string) {
  const [u] = await db
    .insert(users)
    .values({ name: label, email: `${uniq("a3")}@example.com`, mobile: `0912${String(5000000 + ++seq * 17)}`, passwordHash: hashPassword("Audit3x12345"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  const ws = await createWorkspace(u.id, `فضای ${label}`);
  return { u, ws };
}
const envBackup: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in envBackup)) envBackup[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete envBackup[k];
  }
  __resetShutdownForTests();
  setJobsMode(undefined);
});

/* ═══════════════════════ P-04 — استخر اتصال و قفل مشورتی ═══════════════════════ */
describe("P-04 — استخر اتصال قابل‌تنظیم و قفل سهمیه‌ی بدون خفگی", () => {
  it("استخر دیگر روی ۱۰ هاردکد نیست: پیش‌فرض ۲۰، با DB_POOL_MAX قابل‌تنظیم و ورودی نامعتبر امن", () => {
    expect(resolvePoolSettings({}).max).toBe(DEFAULT_POOL_MAX);
    expect(DEFAULT_POOL_MAX).toBeGreaterThan(10);
    expect(resolvePoolSettings({ DB_POOL_MAX: "45" }).max).toBe(45);
    expect(resolvePoolSettings({ DB_POOL_MAX: "0" }).max).toBe(2); // کف: همیشه حداقل ۲ اتصال (یکی برای تراکنش، یکی برای بقیه)
    expect(resolvePoolSettings({ DB_POOL_MAX: "99999" }).max).toBe(200);
    expect(resolvePoolSettings({ DB_POOL_MAX: "abc" }).max).toBe(DEFAULT_POOL_MAX);
    expect(resolvePoolSettings({ DB_POOL_MAX: "  " }).max).toBe(DEFAULT_POOL_MAX);
    expect(resolvePoolSettings({}).options).toContain("idle_in_transaction_session_timeout=300000");
    expect(resolvePoolSettings({ DB_IDLE_TX_TIMEOUT_MS: "0" }).options).toBeUndefined(); // سازگار با PgBouncer
    expect(resolvePoolSettings({}).connectionTimeoutMillis).toBe(10_000);
  });

  it("استخر واقعی با تنظیمات تازه ساخته شده و تراکنشِ رهاشده توسط Postgres بسته می‌شود", async () => {
    expect(poolStats().max).toBe(DEFAULT_POOL_MAX);
    const r = await db.execute(sql`select current_setting('idle_in_transaction_session_timeout') as v, current_setting('application_name') as app`);
    const row = r.rows[0] as { v: string; app: string };
    expect(row.v).toBe("5min");
    expect(row.app).toBe("emzagar");
  });

  it("سقف انتظار قفل ۲۰ ثانیه نیست: پیش‌فرض ۵ ثانیه و قابل‌تنظیم", () => {
    expect(quotaLockTimeoutMs({})).toBe(5_000);
    expect(quotaLockTimeoutMs({ QUOTA_LOCK_TIMEOUT_MS: "1500" })).toBe(1_500);
    expect(quotaLockTimeoutMs({ QUOTA_LOCK_TIMEOUT_MS: "1" })).toBe(500);
    expect(quotaLockTimeoutMs({ QUOTA_LOCK_TIMEOUT_MS: "999999" })).toBe(30_000);
  });

  it("قفل مشورتیِ گیرکرده طبق تنظیم زود رها می‌شود (QuotaLockTimeoutError) و اتصال را بی‌پایان نگه نمی‌دارد", async () => {
    setEnv("QUOTA_LOCK_TIMEOUT_MS", "600");
    const key = 910_000 + seq++;
    let holderLocked!: () => void;
    const locked = new Promise<void>((r) => (holderLocked = r));
    const holder = withTransaction(async () => {
      await lockScope("a3-test", key);
      holderLocked();
      await sleep(2500);
    });
    await locked;
    const t0 = Date.now();
    await expect(withTransaction(async () => lockScope("a3-test", key))).rejects.toBeInstanceOf(QuotaLockTimeoutError);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(2000);
    await holder;
    // پس از آزاد شدن، همان قفل بی‌مشکل گرفته می‌شود
    await withTransaction(async () => lockScope("a3-test", key));
  });

  it("صف درون‌پروسه‌ای: FIFO، ناسازگاری با timeout، و نفر بعدی پشت نفرِ timeout‌شده گیر نمی‌کند", async () => {
    setEnv("QUOTA_LOCK_TIMEOUT_MS", "500");
    const order: string[] = [];
    const a = withScopeMutex("m", 1, async () => {
      order.push("a-start");
      await sleep(900);
      order.push("a-end");
    });
    await sleep(20);
    // b بیش از ۵۰۰ms منتظر می‌ماند ⇒ timeout و هرگز اجرا نمی‌شود
    await expect(withScopeMutex("m", 1, async () => order.push("b-ran"))).rejects.toBeInstanceOf(QuotaLockTimeoutError);
    // c بعد از b شروع می‌شود و باید پس از پایان a (نه پشت b) اجرا شود
    const c = withScopeMutex("m", 1, async () => order.push("c-ran"));
    await Promise.all([a, c]);
    expect(order).toEqual(["a-start", "a-end", "c-ran"]);
    // کلید دیگر مستقل است
    let other = false;
    await withScopeMutex("m", 2, async () => void (other = true));
    expect(other).toBe(true);
  });

  /** بیشینه‌ی تعداد اتصال‌هایی که هم‌زمان «پشت قفل مشورتی خوابیده‌اند» (از دید خودِ Postgres، با یک اتصال مستقل) */
  async function maxLockWaiters(work: () => Promise<unknown>): Promise<number> {
    const monitor = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let max = 0;
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const r = await monitor.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
        max = Math.max(max, r.rows[0].n as number);
        await sleep(2);
      }
    })();
    try {
      await work();
    } finally {
      stop = true;
      await loop;
      await monitor.end();
    }
    return max;
  }

  it("قبل از اصلاح: ۴۰ درخواست هم‌زمان پشت یک قفل مشورتی، دهها اتصال استخر را می‌خوابانَد (اثبات واقعی‌بودن ادعا)", async () => {
    const key = 920_000 + seq++;
    const waiters = await maxLockWaiters(() =>
      Promise.all(
        Array.from({ length: 40 }, () =>
          withTransaction(async () => {
            await lockScope("a3-burst", key);
            await sleep(20);
          }).catch(() => undefined),
        ),
      ),
    );
    expect(waiters).toBeGreaterThanOrEqual(8); // بخش بزرگی از استخر ۲۰تایی پشت قفل
  });

  it("بعد از اصلاح: هجوم ۶۰ درخواست AI برای یک فضای کاری ⇒ سقف دقیق، هیچ اتصالی پشت قفل نمی‌خوابد و بقیه‌ی سایت سریع پاسخ می‌دهد", async () => {
    const { u, ws } = await newOwner("burst");
    let probeMs = 0;
    const probe = (async () => {
      await sleep(5);
      const t0 = Date.now();
      await db.execute(sql`select 1`);
      probeMs = Date.now() - t0;
    })();
    let rs: Awaited<ReturnType<typeof reserveAiQuota>>[] = [];
    const waiters = await maxLockWaiters(async () => {
      rs = await Promise.all(Array.from({ length: 60 }, () => reserveAiQuota({ workspaceId: ws, userId: u.id, kind: "contract", prompt: "p", model: "m" })));
    });
    await probe;
    expect(rs.filter((r) => r.ok)).toHaveLength(8); // سقف طرح رایگان: دقیقاً ۸ (صحت قفل حفظ شده)
    expect(rs.every((r) => r.ok || r.limit === 8)).toBe(true);
    expect(waiters).toBeLessThanOrEqual(1); // صف در حافظه است، نه روی اتصال‌های دیتابیس
    expect(probeMs).toBeLessThan(1500);
    expect(poolStats().waiting).toBe(0);
  });
});

/* ═══════════════════════ R-03 — «پول گم می‌شود» (ادعای نادرست) ═══════════════════════ */
describe("R-03 — شکاف بین پرداخت موفق و علامت verify_pending (False Positive: پول گم نمی‌شود)", () => {
  let sim: SimHandle;
  let c: SimClient;
  let userId = 0;
  const origin = "http://localhost:3000";
  const saved: Record<string, string | undefined> = {};
  const authorityOf = (url: string) => new URL(url).searchParams.get("Authority") ?? url.split("/").pop()!;

  beforeAll(async () => {
    sim = await startSimulator({ port: 0, quiet: true, startPay: "auto" });
    c = new SimClient(sim.url);
    for (const k of ["EXTERNAL_SIM_URL", "EXTERNAL_TIMEOUT_SCALE", "ZARINPAL_MERCHANT_ID"]) saved[k] = process.env[k];
    process.env.EXTERNAL_SIM_URL = sim.url;
    process.env.EXTERNAL_TIMEOUT_SCALE = "0.02";
    delete process.env.ZARINPAL_MERCHANT_ID;
    userId = (await newOwner("pay")).u.id;
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await sim.close();
  });

  it("سرور بین «درگاه پرداخت را گرفت» و هر نوشتنی در دیتابیس مُرد (هیچ علامتی ننوشته): بازبینی خودکار پول را اعمال می‌کند", async () => {
    await c.reset();
    await c.settings({ startPay: "auto" });
    const ws = await createWorkspace(userId, `فضای شکاف ${uniq("g")}`);
    // کاربر در درگاه پرداخت کرد ولی بازگشت به سایت هرگز به ما نرسید (سرور پایین بود) ⇒ در دیتابیس ما هیچ اثری از «verify» نیست
    await c.scenario("zarinpal", "callback_dropped");
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    expect((await fetch(url, { redirect: "manual" })).status).toBe(200);
    const authority = authorityOf(url);
    expect((await c.payment(authority)).status).toBe("paid"); // پول از حساب مشتری کم شد

    let [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.status).toBe("pending");
    expect(row.error ?? "").not.toContain("verify_pending"); // دقیقاً «شکافِ» ادعا: علامت نوشته نشده
    expect((await getSubscription(ws)).planId).toBe("free");

    // کمتر از ۱۰ دقیقه: کاربر ممکن است هنوز در صفحه‌ی درگاه باشد ⇒ دست‌نخورده
    await reconcilePendingPayments();
    [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.status).toBe("pending");

    // زمان‌بند (هر ۱۰ دقیقه و ۴۵ ثانیه پس از بالا آمدن) بعد از ۱۰ دقیقه تراکنش بی‌علامت را با درگاه تطبیق می‌دهد
    await db.update(payments).set({ createdAt: new Date(Date.now() - 15 * 60_000) }).where(eq(payments.id, row.id));
    const rec = await reconcilePendingPayments();
    expect(rec.paid).toBeGreaterThanOrEqual(1);
    [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.status).toBe("paid");
    expect(row.fulfilledAt).not.toBeNull();
    expect((await getSubscription(ws)).planId).toBe("pro"); // خدمت ارائه شد

    // اجرای دوباره تمدید دوباره نمی‌کند (idempotent)
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    await reconcilePendingPayments();
    expect((await getSubscription(ws)).periodEnd!.getTime()).toBe(end);
  });

  it("همین بازبینی تا افق ۴۸ ساعت کار می‌کند و تراکنش پرداخت‌نشده را ناموفق می‌بندد (نه برای همیشه معلق)", async () => {
    await c.reset();
    await c.settings({ startPay: "auto" });
    const ws = await createWorkspace(userId, `فضای رها ${uniq("g")}`);
    await c.scenario("zarinpal", "callback_dropped");
    // این بار کاربر در درگاه پرداخت «نکرد»
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    const authority = authorityOf(url);
    await db.update(payments).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(payments.authority, authority));
    await reconcilePendingPayments();
    const [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.status).toBe("failed");
    expect((await getSubscription(ws)).planId).toBe("free");
  });
});

/* ═══════════════════════ D-04 — نشت متن ایمیل/پیامک ═══════════════════════ */
describe("D-04 — متن ایمیل و پیامک (OTP، توکن) دائمی و متن‌ساده نیست", () => {
  const SECRET = "کد-تأیید-۴۸۲۹۱۷-توکن-abcDEF123";

  it("سیاست: production ⇒ هرگز؛ توسعه/آزمون ⇒ با TTL؛ و پرچم صریح همه‌چیز را بازنویسی می‌کند", () => {
    expect(storeOutboxBodies({ NODE_ENV: "production" })).toBe(false);
    expect(storeOutboxBodies({ NODE_ENV: "development" })).toBe(true);
    expect(storeOutboxBodies({ NODE_ENV: "production", OUTBOX_STORE_BODY: "1" })).toBe(true);
    expect(storeOutboxBodies({ NODE_ENV: "development", OUTBOX_STORE_BODY: "0" })).toBe(false);
    expect(outboxBody(SECRET, { NODE_ENV: "production" })).toBe(REDACTED_BODY);
    expect(outboxBody(SECRET, { NODE_ENV: "production" })).not.toContain("482917");
    expect(outboxBody(SECRET, { NODE_ENV: "test" })).toBe(SECRET);
    expect(bodyTtlMinutes({ NODE_ENV: "production" })).toBe(0); // متن قدیمیِ نسخه‌های قبل فوراً پاک می‌شود
    expect(bodyTtlMinutes({ NODE_ENV: "test" })).toBe(60);
    expect(bodyTtlMinutes({ NODE_ENV: "test", OUTBOX_BODY_TTL_MINUTES: "5" })).toBe(5);
    expect(retentionDays({})).toBe(180);
    expect(retentionDays({ OUTBOX_RETENTION_DAYS: "1" })).toBe(7);
  });

  it("رفتار آزمون/توسعه‌ی موجود حفظ شده (آزمون‌های دیگر کد را از همین‌جا می‌خوانند)", async () => {
    const to = `${uniq("keep")}@example.com`;
    await sendMail({ to, subject: "کد شما", html: `<p>${SECRET}</p>`, workspaceId: 0 });
    const [row] = await db.select().from(notifications).where(eq(notifications.recipient, to));
    expect(row.body).toContain(SECRET);
  });

  it("production: ایمیل و پیامکِ حالت آزمایشی فقط فراداده ثبت می‌کنند، نه متن", async () => {
    setEnv("OUTBOX_STORE_BODY", "0"); // معادل NODE_ENV=production
    const to = `${uniq("redact")}@example.com`;
    const m = await sendMail({ to, subject: "بازیابی رمز", html: `<a href="https://x/reset?token=${SECRET}">لینک</a>`, workspaceId: 0 });
    expect(m.status).toBe("logged");
    const [mail] = await db.select().from(notifications).where(eq(notifications.recipient, to));
    expect(mail.body).toBe(REDACTED_BODY);
    expect(mail.subject).toBe("بازیابی رمز"); // فراداده‌ی عیب‌یابی سر جایش
    expect(mail.status).toBe("logged");

    const mobile = "09123456789";
    const before = (await db.select().from(notifications).where(and(eq(notifications.recipient, mobile), eq(notifications.channel, "sms")))).length;
    await sendSms({ to: mobile, text: `کد تأیید امضا: ${SECRET}` }, null, 0);
    const smsRows = await db.select().from(notifications).where(and(eq(notifications.recipient, mobile), eq(notifications.channel, "sms")));
    expect(smsRows.length).toBe(before + 1);
    expect(smsRows.every((r) => !r.body.includes("482917"))).toBe(true);
    expect(smsRows[smsRows.length - 1].body).toBe(REDACTED_BODY);
  });

  it("purgeOutbox: متن قدیمی پاک، تازه‌ها (در حالت توسعه) دست‌نخورده، فراداده‌ی بسیار قدیمی حذف", async () => {
    const mk = (age: number, tag: string) =>
      db.insert(notifications).values({ channel: "email", recipient: `${tag}@purge.test`, subject: tag, body: SECRET, status: "sent", createdAt: new Date(Date.now() - age) }).returning();
    const [fresh] = await mk(5 * 60_000, "fresh");
    const [old] = await mk(3 * 3600_000, "old");
    const [ancient] = await mk(200 * 86400_000, "ancient");
    const r1 = await purgeOutbox();
    expect(r1.scrubbed).toBeGreaterThanOrEqual(1);
    expect(r1.deleted).toBeGreaterThanOrEqual(1);
    const get = async (id: number) => (await db.select().from(notifications).where(eq(notifications.id, id)))[0];
    expect((await get(fresh.id)).body).toBe(SECRET); // هنوز در TTL (فقط توسعه/آزمون)
    expect((await get(old.id)).body).toBe(REDACTED_BODY);
    expect((await get(old.id)).recipient).toBe("old@purge.test"); // فراداده می‌ماند
    expect(await get(ancient.id)).toBeUndefined();

    // production: هر متنِ به‌جامانده از نسخه‌های قبلی همان لحظه پاک می‌شود
    setEnv("OUTBOX_STORE_BODY", "0");
    await purgeOutbox();
    expect((await get(fresh.id)).body).toBe(REDACTED_BODY);
    // idempotent
    expect((await purgeOutbox()).scrubbed).toBe(0);
  });
});

/* ═══════════════════════ R-01 — قفل ابدی dedupeKey ═══════════════════════ */
describe("R-01 — کارِ dead کلید dedupe را برای همیشه قفل نمی‌کند", () => {
  const handledPayloads: string[] = [];
  let mode: "fail" | "ok" = "fail";
  beforeAll(() => {
    registerJobHandler("a3.job", {
      async run(p) {
        if (mode === "fail") throw new Error("ارسال ناموفق");
        handledPayloads.push(String(p.v));
      },
    });
  });
  const rowsOf = (key: string) => db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, key));

  it("کار مرده با همان کلید دوباره درج شود ⇒ همان ردیف احیا و واقعاً اجرا می‌شود (نه نادیده‌گرفته)", async () => {
    setJobsMode("inline");
    const key = uniq("finalize:");
    mode = "fail";
    await enqueueJob("a3.job", { v: "old" }, { dedupeKey: key, maxAttempts: 1 });
    let [row] = await rowsOf(key);
    expect(row.status).toBe("dead");
    expect(row.attempts).toBe(1);

    mode = "ok"; // مشکل (مثلاً SMTP) برطرف شد؛ نسخه‌ی نهایی دوباره صادر می‌شود
    await enqueueJob("a3.job", { v: "new" }, { dedupeKey: key });
    const all = await rowsOf(key);
    expect(all).toHaveLength(1); // یک ردیف؛ تکثیر نشد
    row = all[0];
    expect(row.status).toBe("done");
    expect(handledPayloads).toContain("new");
    expect(row.lastError).toBeNull();
  });

  it("کار done/pending/running با همان کلید همچنان ایدمپوتنت است (ایمیل دوبار نمی‌رود)", async () => {
    setJobsMode("background");
    for (const status of ["done", "pending", "running"] as const) {
      const key = uniq(`idem-${status}:`);
      await db.insert(backgroundJobs).values({ type: "a3.job", payload: JSON.stringify({ v: "first" }), dedupeKey: key, status, runAt: new Date(Date.now() + 3600_000), lockedUntil: new Date(Date.now() + 3600_000) });
      await enqueueJob("a3.job", { v: "second" }, { dedupeKey: key, kick: false });
      const all = await rowsOf(key);
      expect(all, status).toHaveLength(1);
      expect(all[0].status, status).toBe(status);
      expect(JSON.parse(all[0].payload).v, status).toBe("first");
    }
  });

  it("کارهای بدون کلید و کلیدهای متفاوت مستقل‌اند", async () => {
    setJobsMode("background");
    const before = (await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a3.nokey"))).length;
    await enqueueJob("a3.nokey", {}, { kick: false });
    await enqueueJob("a3.nokey", {}, { kick: false });
    expect((await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a3.nokey"))).length).toBe(before + 2);
  });

  it("کارِ dead قدیمیِ پیش از اصلاح (دیتای واقعی نصب‌های موجود) هم با درج بعدی احیا می‌شود", async () => {
    setJobsMode("background");
    const key = uniq("legacy-dead:");
    await db.insert(backgroundJobs).values({ type: "a3.job", payload: "{}", dedupeKey: key, status: "dead", attempts: 6, finishedAt: new Date(Date.now() - 86400_000), lastError: "x" });
    await enqueueJob("a3.job", { v: "again" }, { dedupeKey: key, kick: false, delayMs: 0 });
    const [row] = await rowsOf(key);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.finishedAt).toBeNull();
    expect(JSON.parse(row.payload).v).toBe("again");
  });
});

/* ═══════════════════════ R-02 — خاموشی ناگهانی ═══════════════════════ */
describe("R-02 — SIGTERM: سهمیه‌ی AI و کارهای صف نمی‌سوزند", () => {
  it("رزروِ AI قدیمی‌تر از TTL (پروسه‌ی مُرده) شمرده نمی‌شود و توسط reaper به failed می‌رود؛ رزرو تازه سر جایش", async () => {
    const { u, ws } = await newOwner("ttl");
    const stale = await db.insert(aiGenerations).values({ workspaceId: ws, userId: u.id, status: "reserved", createdAt: new Date(Date.now() - AI_RESERVATION_TTL_MS - 60_000) }).returning();
    const fresh = await db.insert(aiGenerations).values({ workspaceId: ws, userId: u.id, status: "reserved" }).returning();
    expect((await usageToday(ws)).used).toBe(1); // فقط تازه
    expect(await reapStaleAiReservations()).toBeGreaterThanOrEqual(1);
    const get = async (id: number) => (await db.select().from(aiGenerations).where(eq(aiGenerations.id, id)))[0];
    expect((await get(stale[0].id)).status).toBe("failed");
    expect((await get(fresh[0].id)).status).toBe("reserved");
    expect((await usageToday(ws)).used).toBe(1);
  });

  it("خاموشی با تماس AI نیمه‌تمام: رزرو آزاد می‌شود و سهمیه‌ی مشتری برمی‌گردد", async () => {
    const { u, ws } = await newOwner("ai-shutdown");
    const r = await reserveAiQuota({ workspaceId: ws, userId: u.id, kind: "contract", prompt: "p", model: "m" });
    expect(r.ok).toBe(true);
    expect(openAiReservationCount()).toBeGreaterThanOrEqual(1);
    expect((await usageToday(ws)).used).toBe(1);

    const t0 = Date.now();
    await runShutdown("SIGTERM(test)", { graceMs: 1500 }); // تخلیه تا ۹۰۰ms منتظر می‌ماند، سپس آزاد می‌کند
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(Date.now() - t0).toBeLessThan(1500 + 500);
    expect((await usageToday(ws)).used).toBe(0); // سهمیه نسوخت
    const [row] = await db.select().from(aiGenerations).where(eq(aiGenerations.id, (r as { id: number }).id));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("shutdown");
    expect(openAiReservationCount()).toBe(0);
  });

  it("خاموشی با کار صف در حال اجرا: اجاره آزاد می‌شود، تلاش مصرف نمی‌شود و فوراً قابل برداشت است", async () => {
    setJobsMode("background");
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    registerJobHandler("a3.hang", { run: () => gate });
    const key = uniq("hang:");
    await enqueueJob("a3.hang", {}, { dedupeKey: key, kick: false });
    const draining = drainJobs(); // کار برداشته و «در حال اجرا» می‌شود
    await sleep(300);
    let [row] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, key));
    expect(row.status).toBe("running");
    expect(row.attempts).toBe(1);

    await runShutdown("SIGTERM(test)", { graceMs: 1000 });
    [row] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.dedupeKey, key));
    expect(row.status).toBe("pending"); // نه ۵ دقیقه «running»
    expect(row.attempts).toBe(0); // دیپلوی از سقف تلاش‌ها کم نکرد
    expect(row.lockedUntil).toBeNull();
    expect(row.runAt.getTime()).toBeLessThanOrEqual(Date.now());

    finish();
    await draining;
    await db.delete(backgroundJobs).where(eq(backgroundJobs.dedupeKey, key));
  });

  it("هنگام خاموشی: /api/health ← 503 (تخلیه از load balancer)، پس از پایان حالت عادی ← 200", async () => {
    expect((await healthGet()).status).toBe(200);
    await runShutdown("SIGTERM(test)", { graceMs: 1000 });
    expect(isShuttingDown()).toBe(true);
    const res = await healthGet();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { draining: boolean }).draining).toBe(true);
    __resetShutdownForTests();
    expect((await healthGet()).status).toBe(200);
  });

  it("مهلت خاموشی قابل‌تنظیم و محدود است", () => {
    expect(shutdownGraceMs({})).toBe(20_000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "5000" })).toBe(5_000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "5" })).toBe(1_000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "9999999" })).toBe(120_000);
    expect(shutdownGraceMs({ SHUTDOWN_GRACE_MS: "x" })).toBe(20_000);
  });

  /* ── سیگنال واقعی روی پروسه‌ی واقعی ── */
  const childFile = path.resolve(import.meta.dirname, "../fixtures/shutdown-child.ts");
  async function runChild(mode: string, env: Record<string, string> = {}) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "emz-sd-")), "marks.txt");
    fs.writeFileSync(out, "");
    const child = spawn(process.execPath, ["--import", "tsx", childFile, mode, out], { cwd: path.resolve(import.meta.dirname, "../.."), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), 20_000);
      child.stdout.on("data", (d) => {
        if (String(d).includes("ready")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", () => reject(new Error(`child exited early: ${stderr}`)));
    });
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    return { code, ms: Date.now() - t0, marks: fs.readFileSync(out, "utf8").split("\n").filter(Boolean), stderr };
  }

  it("SIGTERM واقعی + هندلر مثل Next (که فوراً exit(143) می‌زند): قلاب‌های ناهمگام ما پیش از خروج کامل می‌شوند", async () => {
    const r = await runChild("next-like");
    expect(r.code).toBe(143);
    expect(r.marks).toEqual(["slow-done", "late-done"]); // به ترتیب order
    expect(r.ms).toBeGreaterThanOrEqual(380); // exit به‌تعویق افتاد (وگرنه ~۱۰ms)
    expect(r.stderr).toContain("خاموشی نرم");
  }, 40_000);

  it("SIGTERM واقعی بدون هندلر دیگر: خودمان پس از قلاب‌ها با کد ۱۴۳ خارج می‌شویم (پروسه معلق نمی‌ماند)", async () => {
    const r = await runChild("sole");
    expect(r.code).toBe(143);
    expect(r.marks).toEqual(["slow-done", "late-done"]);
    expect(r.ms).toBeLessThan(4_000);
  }, 40_000);

  it("قلاب گیرکرده، خاموشی را بی‌پایان نگه نمی‌دارد: پس از مهلت قطع و قلاب‌های بعدی اجرا می‌شوند", async () => {
    const r = await runChild("stuck", { SHUTDOWN_GRACE_MS: "1200" });
    expect(r.code).toBe(143);
    expect(r.marks).not.toContain("slow-done");
    expect(r.marks.length).toBeLessThanOrEqual(1); // «late» فقط اگر از مهلت چیزی مانده بود
    expect(r.ms).toBeGreaterThanOrEqual(1_000);
    expect(r.ms).toBeLessThan(6_000);
  }, 40_000);
});
