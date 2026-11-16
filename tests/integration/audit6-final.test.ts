/**
 * GLM Audit 6 — دسته‌ی نهایی: عملکرد (P-13…P-24)، پایداری (R-04…R-14)، حریم خصوصی (D-01…D-15)
 *
 * هر بخش یا باگِ واقعی را با آزمون رفتاری/اندازه‌گیری قفل می‌کند یا بی‌خطر بودن کد را ثابت می‌کند.
 * هیچ آزمون موجودی تغییر نکرده است.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, backgroundJobs, webhookEndpoints } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { CircuitOpenError, DeadlineError, backoffJitterBounds, breakerSnapshot, guarded, resetBreakers, retryTransient, withDeadline, withJitter } from "@/lib/resilience";
import { smtpErrorKind } from "@/lib/smtp-errors";
import { GUARD_NOTE, isValidNationalCode, luhnOk, newVault, protectText, restoreText } from "@/modules/ai/guard";
import { aiChat } from "@/modules/ai/client";
import { reserveAiQuota } from "@/modules/ai/quota";
import { PermanentJobError, RetryLaterError, backoffMs, enqueueJob, registerJobHandler, setJobsPaused } from "@/modules/jobs/queue";
import { retentionPolicy, runRetention, sealLegacySecrets } from "@/modules/privacy/retention";
import { SMS_PROVIDERS, sendSms, type SmsProvider } from "@/modules/sms";
import { uniq } from "../helpers";
import { newContract, setupWorkspace } from "../flows";

const q = async (text: string) => (await db.execute(sql.raw(text))).rows as Record<string, unknown>[];

afterEach(() => {
  delete process.env.RESILIENCE_FORCE;
  resetBreakers();
  setJobsPaused(false);
  vi.unstubAllGlobals();
});

let ws = 0;
let ownerId = 0;
beforeAll(async () => {
  const s = await setupWorkspace("فضای ممیزی ۶");
  ws = s.wsId;
  ownerId = s.owner.id;
});
afterAll(() => {
  vi.restoreAllMocks();
});

/* ═════════════════════════ R: پایداری ═════════════════════════ */
describe("R-04 — jitter: retryهای پس از قطعی هم‌زمان نمی‌شوند", () => {
  it("withJitter در [نصف، کل] می‌ماند و با rnd ثابت قطعی است", () => {
    expect(withJitter(1000, () => 0)).toBe(500);
    expect(withJitter(1000, () => 1)).toBe(1000);
    for (let i = 0; i < 200; i++) {
      const v = withJitter(10_000);
      expect(v).toBeGreaterThanOrEqual(5000);
      expect(v).toBeLessThanOrEqual(10_000);
    }
  });
  it("backoff صف: مقدار پایه‌ی نمایی حفظ شده و ۲۰۰ کارِ هم‌زمان‌شکست‌خورده در یک ثانیه‌ی واحد دوباره اجرا نمی‌شوند", () => {
    expect(backoffMs(1, () => 1)).toBe(30_000);
    expect(backoffMs(3, () => 1)).toBe(120_000);
    expect(backoffMs(30, () => 1)).toBe(3_600_000); // سقف ۱ ساعت
    const times = new Set(Array.from({ length: 200 }, () => Math.floor(backoffMs(2) / 1000)));
    expect(times.size).toBeGreaterThan(15); // قبلاً دقیقاً ۱ مقدار (۶۰ ثانیه) بود
    expect(backoffJitterBounds(2)).toEqual({ min: 30_000, max: 60_000 });
  });
});

describe("R-05 — خطای دائمی صف را نمی‌سوزاند؛ خطای «بعداً» تلاش مصرف نمی‌کند", () => {
  it("PermanentJobError در اولین تلاش dead می‌شود (نه ۸ تلاش بی‌حاصل)", async () => {
    let calls = 0;
    const dead: string[] = [];
    registerJobHandler("a6.perm", { run: async () => { calls++; throw new PermanentJobError("گیرنده رد شد"); }, onDead: async (_p, e) => void dead.push(e) });
    await enqueueJob("a6.perm", { x: 1 }, { dedupeKey: uniq("perm"), maxAttempts: 8 });
    const [j] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a6.perm"));
    expect(calls).toBe(1);
    expect(j.status).toBe("dead");
    expect(j.attempts).toBe(1);
    expect(dead).toEqual(["گیرنده رد شد"]);
  });
  it("خطای عادی هنوز retry می‌شود (رفتار قبلی)", async () => {
    registerJobHandler("a6.plain", { run: async () => { throw new Error("شبکه"); } });
    await enqueueJob("a6.plain", {}, { dedupeKey: uniq("plain"), maxAttempts: 5 });
    const [j] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a6.plain"));
    expect(j.status).toBe("pending");
    expect(j.attempts).toBe(1);
    expect(j.runAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
  });
  it("RetryLaterError (و CircuitOpenError) تلاش را برمی‌گرداند و کار به آینده موکول می‌شود؛ حتی در آخرین تلاش dead نمی‌شود", async () => {
    registerJobHandler("a6.later", { run: async () => { throw new RetryLaterError("پنل پایین است", 60_000); } });
    await enqueueJob("a6.later", {}, { dedupeKey: uniq("later"), maxAttempts: 1 });
    const [j] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a6.later"));
    expect(j.status).toBe("pending");
    expect(j.attempts).toBe(0); // تلاش مصرف نشد
    expect(j.runAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    registerJobHandler("a6.circuit", { run: async () => { throw new CircuitOpenError("sms:x", 45_000); } });
    await enqueueJob("a6.circuit", {}, { dedupeKey: uniq("circ"), maxAttempts: 1 });
    const [c] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a6.circuit"));
    expect(c.status).toBe("pending");
    expect(c.attempts).toBe(0);
  });
  it("کارِ بیش از ۶ ساعت‌مانده دیگر از «بعداً» بهره نمی‌برد (صف بی‌انتها نمی‌ماند)", async () => {
    registerJobHandler("a6.old", { run: async () => { throw new RetryLaterError("هنوز پایین", 60_000); } });
    setJobsPaused(true);
    await enqueueJob("a6.old", {}, { dedupeKey: uniq("old"), maxAttempts: 1 });
    await db.execute(sql`update background_jobs set created_at = now() - interval '7 hours' where type = 'a6.old'`);
    setJobsPaused(false);
    const { drainJobs } = await import("@/modules/jobs/queue");
    await drainJobs();
    const [j] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.type, "a6.old"));
    expect(j.status).toBe("dead");
  });
});

describe("R-06 — قطع‌کننده‌ی مدار + retry محدود + مهلت سخت", () => {
  it("پس از ۳ شکست پیاپی باز می‌شود، تماس‌ها فوراً (بدون اجرای fn) رد می‌شوند، نیمه‌باز یک کاوشگر می‌گذراند و موفقیت می‌بندد", async () => {
    process.env.RESILIENCE_FORCE = "1";
    let t = 1_000_000;
    const now = () => t;
    let calls = 0;
    const boom = async () => { calls++; throw new Error("down"); };
    for (let i = 0; i < 3; i++) await expect(guarded("k1", boom, { threshold: 3, openMs: 10_000, now })).rejects.toThrow("down");
    expect(calls).toBe(3);
    await expect(guarded("k1", boom, { threshold: 3, openMs: 10_000, now })).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(3); // fn اجرا نشد
    t += 10_001; // نیمه‌باز
    const probe = guarded("k1", async () => { await new Promise((r) => setTimeout(r, 20)); return "ok"; }, { threshold: 3, openMs: 10_000, now });
    await expect(guarded("k1", boom, { threshold: 3, openMs: 10_000, now })).rejects.toBeInstanceOf(CircuitOpenError); // فقط یک کاوشگر
    expect(await probe).toBe("ok");
    expect(await guarded("k1", async () => "again", { now })).toBe("again");
    expect(breakerSnapshot("k1").open).toBe(false);
  });
  it("شکست کاوشگر مدار را دوباره (با مدت دوبرابر) باز می‌کند", async () => {
    process.env.RESILIENCE_FORCE = "1";
    let t = 5_000_000;
    const now = () => t;
    const boom = async () => { throw new Error("down"); };
    for (let i = 0; i < 2; i++) await expect(guarded("k2", boom, { threshold: 2, openMs: 1000, now })).rejects.toThrow();
    t += 1001;
    await expect(guarded("k2", boom, { threshold: 2, openMs: 1000, now })).rejects.toThrow("down");
    t += 1500; // مدت اول (۱ ثانیه) گذشته ولی مدت جدید ۲ ثانیه است
    await expect(guarded("k2", boom, { threshold: 2, openMs: 1000, now })).rejects.toBeInstanceOf(CircuitOpenError);
  });
  it("خطای غیرگذرا (isFailure=false) مدار را باز نمی‌کند", async () => {
    process.env.RESILIENCE_FORCE = "1";
    for (let i = 0; i < 10; i++) await expect(guarded("k3", async () => { throw new Error("550 user unknown"); }, { threshold: 2, isFailure: () => false })).rejects.toThrow("550");
    expect(breakerSnapshot("k3").open).toBe(false);
  });
  it("در آزمون‌ها (بدون RESILIENCE_FORCE) خاموش است تا شمارش تماس‌های آزمون‌های موجود تغییر نکند", async () => {
    let calls = 0;
    for (let i = 0; i < 20; i++) await expect(guarded("k4", async () => { calls++; throw new Error("x"); }, { threshold: 1 })).rejects.toThrow("x");
    expect(calls).toBe(20);
  });
  it("retryTransient: فقط خطای گذرا، با فاصله‌ی jitter؛ خطای دائمی فوراً پرتاب می‌شود", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    let n = 0;
    const r = await retryTransient(async () => { if (++n < 3) throw new Error("transient"); return "done"; }, { retries: 3, baseMs: 400, sleep });
    expect(r).toBe("done");
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(200);
    expect(sleeps[0]).toBeLessThanOrEqual(400);
    expect(sleeps[1]).toBeLessThanOrEqual(800);
    let m = 0;
    await expect(retryTransient(async () => { m++; throw new Error("permanent"); }, { retries: 3, isTransient: () => false, sleep })).rejects.toThrow("permanent");
    expect(m).toBe(1);
  });
  it("withDeadline: عملیات کندتر از مهلت قطع می‌شود", async () => {
    await expect(withDeadline("تست", 30, () => new Promise((r) => setTimeout(r, 500)))).rejects.toBeInstanceOf(DeadlineError);
    expect(await withDeadline("تست", 500, async () => 7)).toBe(7);
  });
});

describe("R-07 — پیامک: خرابی گذرا ≠ پاسخ منطقی پنل", () => {
  const calls: string[] = [];
  const fake: SmsProvider = { id: "a6fake", label: "جعلی", send: async (m) => { calls.push(m.to); if (m.to === "09120000001") return { ok: false, error: "شماره نامعتبر" }; throw new Error("ECONNRESET"); } };
  beforeAll(async () => {
    SMS_PROVIDERS.push(fake);
    await q(`insert into workspace_settings (workspace_id, key, value) values (${ws}, 'sms_provider', 'a6fake') on conflict (workspace_id, key) do update set value = excluded.value`);
  });
  afterAll(() => {
    SMS_PROVIDERS.splice(SMS_PROVIDERS.indexOf(fake), 1);
  });
  it("ok:false (شماره نامعتبر) مدار را باز نمی‌کند و transient نیست", async () => {
    process.env.RESILIENCE_FORCE = "1";
    calls.length = 0;
    for (let i = 0; i < 8; i++) {
      const r = await sendSms({ to: "09120000001", text: "x" }, null, ws);
      expect(r.ok).toBe(false);
      expect(r.transient).toBeUndefined();
    }
    expect(calls).toHaveLength(8);
  });
  it("قطع شبکه: یک retry، سپس پس از ۵ شکست مدار باز و تماس‌ها بدون رسیدن به پنل رد می‌شوند", async () => {
    process.env.RESILIENCE_FORCE = "1";
    calls.length = 0;
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await sendSms({ to: "09120000002", text: "x" }, null, ws));
    expect(out.every((r) => !r.ok && r.transient)).toBe(true);
    expect(calls.length).toBe(10); // هر ارسال = ۱ تلاش + ۱ retry
    const before = calls.length;
    const blocked = await sendSms({ to: "09120000002", text: "x" }, null, ws);
    expect(blocked.ok).toBe(false);
    expect(blocked.transient).toBe(true);
    expect(blocked.error).toContain("موقتاً");
    expect(calls.length).toBe(before); // پنل صدا زده نشد
  });
});

describe("R-08 — طبقه‌بندی خطای SMTP", () => {
  it("۵xx دائمی؛ ۴xx/شبکه/احراز/ناشناخته گذرا", () => {
    expect(smtpErrorKind({ responseCode: 550 })).toBe("permanent");
    expect(smtpErrorKind({ responseCode: 553 })).toBe("permanent");
    expect(smtpErrorKind({ responseCode: 554 })).toBe("permanent");
    expect(smtpErrorKind({ responseCode: 451 })).toBe("transient");
    expect(smtpErrorKind({ responseCode: 421 })).toBe("transient");
    expect(smtpErrorKind({ responseCode: 535 })).toBe("transient");
    expect(smtpErrorKind({ responseCode: 552 })).toBe("transient");
    expect(smtpErrorKind({ code: "ETIMEDOUT", message: "timeout" })).toBe("transient");
    expect(smtpErrorKind({ code: "EENVELOPE", message: "No recipients defined" })).toBe("permanent");
    expect(smtpErrorKind(new Error("???"))).toBe("transient");
    expect(smtpErrorKind(null)).toBe("transient");
  });
});

/* ═════════════════════════ D: حریم خصوصی ═════════════════════════ */
describe("D-01 — رازهای وب‌هوک در حالت سکون رمزنگاری می‌شوند", () => {
  it("نوشتن با drizzle ⇒ در دیتابیس enc:v1؛ خواندن با drizzle ⇒ متن ساده", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "ربات", provider: "telegram", target: "12345", secret: "123456:ABC-DEF-bot-token" }).returning();
    expect(ep.secret).toBe("123456:ABC-DEF-bot-token");
    const raw = await q(`select secret from webhook_endpoints where id = ${ep.id}`);
    const stored = String(raw[0].secret);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    expect(stored).not.toContain("ABC-DEF");
    expect(decryptSecret(stored)).toBe("123456:ABC-DEF-bot-token");
    const [again] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, ep.id));
    expect(again.secret).toBe("123456:ABC-DEF-bot-token");
  });
  it("update: دوباره‌نویسیِ مقدار خوانده‌شده دوبار رمز نمی‌شود؛ مقدار خالی خالی می‌ماند", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "عمومی", provider: "generic", target: "https://example.com/h", secret: "" }).returning();
    expect(String((await q(`select secret from webhook_endpoints where id = ${ep.id}`))[0].secret)).toBe("");
    await db.update(webhookEndpoints).set({ secret: "hmac-key-1" }).where(eq(webhookEndpoints.id, ep.id));
    const [r] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, ep.id));
    await db.update(webhookEndpoints).set({ secret: r.secret, name: "عمومی۲" }).where(eq(webhookEndpoints.id, ep.id));
    const stored = String((await q(`select secret from webhook_endpoints where id = ${ep.id}`))[0].secret);
    expect(decryptSecret(stored)).toBe("hmac-key-1");
  });
  it("رازِ متن‌سادهٔ قدیمی خوانده می‌شود و sealLegacySecrets آن را idempotent رمز می‌کند", async () => {
    const ins = await q(`insert into webhook_endpoints (workspace_id, name, provider, target, secret) values (${ws}, 'قدیمی', 'generic', 'https://example.com/old', 'legacy-plain-secret') returning id`);
    const id = Number(ins[0].id);
    const [before] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    expect(before.secret).toBe("legacy-plain-secret");
    expect(await sealLegacySecrets()).toBeGreaterThanOrEqual(1);
    const stored = String((await q(`select secret from webhook_endpoints where id = ${id}`))[0].secret);
    expect(stored.startsWith("enc:v1:")).toBe(true);
    const [after] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    expect(after.secret).toBe("legacy-plain-secret");
    expect(await sealLegacySecrets()).toBe(0);
  });
});

describe("D-02 — نگهداری OTP: هش کد پاک می‌شود ولی سقف تلاشِ «کل عمر» ضعیف نمی‌شود", () => {
  it("سیاست پیش‌فرض و قابل‌تنظیم", () => {
    const p = retentionPolicy();
    expect(p.otpCodeHours).toBe(24);
    expect(p.otpAttemptDays).toBe(365);
    process.env.OTP_RETENTION_HOURS = "2";
    expect(retentionPolicy().otpCodeHours).toBe(2);
    process.env.OTP_RETENTION_HOURS = "-5";
    expect(retentionPolicy().otpCodeHours).toBe(24);
    delete process.env.OTP_RETENTION_HOURS;
  });
  it("قدیمیِ بی‌تلاش حذف؛ قدیمیِ دارای تلاش: هش پاک ولی attempts می‌ماند؛ خیلی قدیمی حذف؛ تازه دست‌نخورده", async () => {
    const mk = async (ageH: number, attempts: number) => {
      const r = await q(`insert into otp_codes (contract_id, signer_id, user_id, code_hash, attempts, expires_at, created_at) values (1, 777001, 1, 'deadbeef', ${attempts}, now(), now() - interval '${ageH} hours') returning id`);
      return Number(r[0].id);
    };
    const oldClean = await mk(30, 0);
    const oldTried = await mk(30, 3);
    const ancient = await mk(24 * 400, 4);
    const fresh = await mk(1, 2);
    const rep = await runRetention();
    expect(rep.errors).toEqual([]);
    const rows = Object.fromEntries((await q(`select id, attempts, code_hash from otp_codes where signer_id = 777001`)).map((r) => [Number(r.id), r]));
    expect(rows[oldClean]).toBeUndefined();
    expect(rows[oldTried]).toBeDefined();
    expect(rows[oldTried].code_hash).toBe("");
    expect(Number(rows[oldTried].attempts)).toBe(3);
    expect(rows[ancient]).toBeUndefined();
    expect(rows[fresh].code_hash).toBe("deadbeef");
    const [sum] = await q(`select sum(attempts)::int as s from otp_codes where signer_id = 777001`);
    expect(Number(sum.s)).toBe(5); // 3 + 2 (سقف عمر همچنان می‌بیند)
  });
  it("تأیید موبایل و رمز بازیابی/توکن اتصال منقضی قدیمی حذف می‌شوند؛ تازه‌ها نه", async () => {
    await q(`insert into mobile_verifications (purpose, scope, mobile, code_hash, expires_at, created_at) values ('quick','a6','09120000000','h', now(), now() - interval '9 days'), ('quick','a6','09120000001','h', now(), now())`);
    await q(`insert into connect_tokens (purpose, token_hash, expires_at) values ('a6', 'a6-old', now() - interval '9 days'), ('a6', 'a6-new', now() + interval '1 day')`);
    await runRetention();
    expect(Number((await q(`select count(*)::int as n from mobile_verifications where scope = 'a6'`))[0].n)).toBe(1);
    expect(Number((await q(`select count(*)::int as n from connect_tokens where purpose = 'a6'`))[0].n)).toBe(1);
  });
});

describe("D-03 — لاگ ممیزی: حذف رویداد بی‌قرارداد قدیمی، ناشناس‌سازی IP/UA کم‌ارزش‌ها، ادله دست‌نخورده", () => {
  it("سیاست کامل روی ردیف‌های قدیمی و تازه", async () => {
    const { id: contractId } = { id: await newContract(ws, ownerId).then((c) => (typeof c === "number" ? c : (c as unknown as { id: number }).id)) };
    const ins = async (action: string, ageDays: number, o: { contract?: boolean; ip?: string; ua?: string } = {}) => {
      const [r] = await db.insert(auditLogs).values({ workspaceId: ws, action, contractId: o.contract ? contractId : null, detail: "a6", ip: o.ip ?? "203.0.113.77", userAgent: o.ua ?? "Mozilla/5.0 (Test)" }).returning({ id: auditLogs.id });
      await db.execute(sql`update audit_logs set created_at = now() - (${ageDays}::int * interval '1 day') where id = ${r.id}`);
      return r.id;
    };
    const loginOld = await ins("auth.login", 400);
    const loginNew = await ins("auth.login", 10);
    const viewedOld = await ins("contract.viewed", 400, { contract: true });
    const viewedV6 = await ins("link.opened", 400, { contract: true, ip: "2001:db8:abcd:1234::1" });
    const signedOld = await ins("contract.signed", 400, { contract: true });
    const viewedNew = await ins("contract.viewed", 10, { contract: true });
    const system = await ins("cron.run", 10, { ip: "system", ua: "system" });

    const rep = await runRetention();
    expect(rep.errors).toEqual([]);
    expect(rep.auditDeleted).toBeGreaterThanOrEqual(1);
    const rows = Object.fromEntries((await db.select().from(auditLogs).where(eq(auditLogs.detail, "a6"))).map((r) => [r.id, r]));
    expect(rows[loginOld]).toBeUndefined();
    expect(rows[loginNew]).toBeDefined();
    expect(rows[loginNew].ip).toBe("203.0.113.77");
    expect(rows[viewedOld].ip).toBe("203.0.113.0");
    expect(rows[viewedOld].userAgent).toBe("");
    expect(rows[viewedV6].ip).toBe("2001:db8:abcd::");
    expect(rows[signedOld].ip).toBe("203.0.113.77"); // ادله‌ی امضا دست‌نخورده
    expect(rows[signedOld].userAgent).toBe("Mozilla/5.0 (Test)");
    expect(rows[viewedNew].ip).toBe("203.0.113.77");
    expect(rows[system].ip).toBe("system");
    const again = await runRetention();
    expect(again.auditAnonymized).toBe(0); // idempotent
  });
});

describe("D-04 — سابقه‌ی وب‌هوک و پرامپت AI", () => {
  it("تحویل‌های ok/dead قدیمی حذف؛ failed در صف و تازه‌ها می‌مانند", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "لاگ", provider: "generic", target: "https://example.com/l", secret: "" }).returning();
    await q(`insert into webhook_deliveries (endpoint_id, event, status, created_at) values
      (${ep.id}, 'a6', 'ok', now() - interval '40 days'), (${ep.id}, 'a6', 'dead', now() - interval '40 days'),
      (${ep.id}, 'a6', 'failed', now() - interval '40 days'), (${ep.id}, 'a6', 'ok', now())`);
    await runRetention();
    const left = await q(`select status from webhook_deliveries where endpoint_id = ${ep.id} order by status`);
    expect(left.map((r) => r.status)).toEqual(["failed", "ok"]);
  });
  it("متن دستور کاربر در جدول مصرف AI پس از مدت پاک می‌شود ولی ردیف مصرف (سهمیه) می‌ماند", async () => {
    await q(`insert into ai_generations (workspace_id, user_id, kind, prompt, status, created_at) values (${ws}, ${ownerId}, 'contract', 'متن قدیمی', 'ok', now() - interval '40 days'), (${ws}, ${ownerId}, 'contract', 'متن تازه', 'ok', now())`);
    await runRetention();
    const rows = await q(`select prompt from ai_generations where workspace_id = ${ws} and kind = 'contract' order by id desc limit 2`);
    expect(rows.map((r) => r.prompt).sort()).toEqual(["", "متن تازه"]);
  });
});

describe("D-06 — سپر حریم خصوصی هوش مصنوعی (نشانگرسازی برگشت‌پذیر)", () => {
  it("کد ملی با رقم کنترلی؛ مبلغ ۱۰ رقمی و عدد دلخواه پنهان نمی‌شود", () => {
    expect(isValidNationalCode("0013542419")).toBe(true);
    expect(isValidNationalCode("0013542418")).toBe(false);
    expect(isValidNationalCode("1111111111")).toBe(false);
    const v = newVault();
    const out = protectText("مبلغ 1500000000 ریال؛ کد ملی 0013542419", v);
    expect(out).toContain("1500000000");
    expect(out).not.toContain("0013542419");
    expect(out).toContain("[[NID_1]]");
  });
  it("کارت (Luhn)، موبایل فارسی/+98، ایمیل و شبا", () => {
    const withCheck = (p15: string) => {
      let sum = 0;
      for (let i = 0; i < 15; i++) {
        let d = Number(p15[14 - i]);
        if (i % 2 === 0) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
      }
      return p15 + String((10 - (sum % 10)) % 10);
    };
    const card = withCheck("603799189997101");
    expect(luhnOk(card)).toBe(true);
    expect(luhnOk(card.slice(0, 15) + String((Number(card[15]) + 1) % 10))).toBe(false);
    const spaced = `${card.slice(0, 4)}-${card.slice(4, 8)}-${card.slice(8, 12)}-${card.slice(12)}`;
    const v = newVault();
    const txt = `کارت ${spaced} موبایل ۰۹۱۲۳۴۵۶۷۸۹ و +989351234567 ایمیل ali@example.com شبا IR062960000000100324200001 سریال 1234567890123456`;
    const out = protectText(txt, v);
    for (const secret of [spaced, "۰۹۱۲۳۴۵۶۷۸۹", "989351234567", "ali@example.com", "IR062960000000100324200001"]) expect(out).not.toContain(secret);
    expect(out).toContain("1234567890123456"); // Luhn نامعتبر ⇒ سریال است نه کارت
    expect(v.n).toBe(5);
  });
  it("رفت‌وبرگشت: مقدار تکراری یک نشانگر؛ restore با براکت تکی/فاصله/حروف کوچک هم کار می‌کند؛ نشانگر ناشناخته دست‌نخورده", () => {
    const v = newVault();
    const out = protectText("تماس: 09123456789 یا 09123456789 یا 09351234567", v);
    expect(out).toBe("تماس: [[MOBILE_1]] یا [[MOBILE_1]] یا [[MOBILE_2]]");
    expect(restoreText("[[MOBILE_1]] / [ mobile_2 ] / [[MOBILE_9]]", v)).toBe("09123456789 / 09351234567 / [[MOBILE_9]]");
  });
  it("aiChat: سرویس بیرونی هرگز مقدار واقعی نمی‌بیند؛ خروجی با مقدار اصلی برمی‌گردد؛ بدون داده‌ی حساس شکل نتیجه عوض نمی‌شود", async () => {
    let sent = "";
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = String(init.body);
      const body = JSON.parse(sent) as { messages: { content: string }[] };
      const echoed = body.messages[1].content.match(/\[\[[A-Z]+_\d+\]\]/g)?.join(" و ") ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: `بازنویسی شد: ${echoed}` } }], usage: { total_tokens: 7 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const cfg = { key: "sk-test-123456", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", provider: "openai" };
    const r = await aiChat(cfg, { system: "دستیار", user: "طرف دوم: آقای الف، کد ملی 0013542419، موبایل 09123456789" });
    expect(sent).not.toContain("0013542419");
    expect(sent).not.toContain("09123456789");
    expect(sent).toContain(GUARD_NOTE.trim().slice(0, 20));
    expect(r.text).toContain("0013542419");
    expect(r.text).toContain("09123456789");
    expect(r.redactions).toBe(2);
    const plain = await aiChat(cfg, { system: "s", user: "سلام" });
    expect(plain).toEqual({ text: "بازنویسی شد:", tokens: 7 });
  });
  it("AI_REDACT=0 و redact:false فقط برای عیب‌یابی/متن‌های بی‌داده‌ی شخصی کار می‌کنند", async () => {
    let sent = "";
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const cfg = { key: "sk-test-123456", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", provider: "openai" };
    await aiChat(cfg, { system: "s", user: "09123456789", redact: false });
    expect(sent).toContain("09123456789");
    process.env.AI_REDACT = "0";
    await aiChat(cfg, { system: "s", user: "09123456789" });
    expect(sent).toContain("09123456789");
    delete process.env.AI_REDACT;
  });
  it("پرامپت ذخیره‌شده در جدول مصرف AI از داده‌ی حساس پاک است", async () => {
    const r = await reserveAiQuota({ workspaceId: ws, userId: ownerId, kind: "contract", prompt: "قرارداد برای 09123456789 و ali@example.com", model: "m" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const row = await q(`select prompt from ai_generations where id = ${r.id}`);
      expect(String(row[0].prompt)).not.toContain("09123456789");
      expect(String(row[0].prompt)).not.toContain("ali@example.com");
    }
  });
});

/* ═════════════════════════ P: عملکرد ═════════════════════════ */
describe("P-13…P-18 — ایندکس‌های زمانی: پاک‌سازی/فهرست بدون اسکن کامل", () => {
  const expected: [string, string][] = [
    ["audit_logs", "audit_ws_created_idx"], ["audit_logs", "audit_contract_created_idx"], ["audit_logs", "audit_created_idx"],
    ["notifications", "notifications_created_idx"], ["notifications", "notifications_ws_channel_idx"],
    ["user_notifications", "user_notifications_created_idx"],
    ["otp_codes", "otp_codes_signer_idx"], ["otp_codes", "otp_codes_created_idx"],
    ["mobile_verifications", "mobile_verifications_created_idx"],
    ["webhook_deliveries", "webhook_deliveries_endpoint_created_idx"], ["webhook_deliveries", "webhook_deliveries_created_idx"],
    ["ai_generations", "ai_gen_created_idx"],
  ];
  it("همه‌ی ایندکس‌های جدید در ساختار دیتابیس هستند", async () => {
    const rows = await q(`select indexname from pg_indexes where schemaname = 'public'`);
    const names = new Set(rows.map((r) => String(r.indexname)));
    for (const [, idx] of expected) expect(names.has(idx), idx).toBe(true);
  });
  it("هیچ Foreign Key بدون ایندکس پوششی نمانده (ادعای «FK بی‌ایندکس» نادرست/رفع‌شده بود)", async () => {
    const rows = await q(`select c.conrelid::regclass::text as t, a.attname as col from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`);
    expect(rows).toEqual([]);
  });
  it("پاک‌سازی outbox و «آخرین رویدادهای فضا» از ایندکس زمانی استفاده می‌کنند (EXPLAIN)", async () => {
    await q(`insert into notifications (workspace_id, channel, recipient, status, created_at) select ${ws}, 'sms', 'x', 'sent', now() - (g || ' minutes')::interval from generate_series(1, 3000) g`);
    await q(`analyze notifications`);
    await q(`set enable_seqscan = off`);
    const plan = (await q(`explain select id from notifications where created_at < now() - interval '1 day' limit 100`)).map((r) => Object.values(r)[0]).join("\n");
    await q(`reset enable_seqscan`);
    expect(plan).toContain("notifications_created_idx");
    await q(`delete from notifications where recipient = 'x' and channel = 'sms'`);
  });
});

describe("P-19 — ویجت گفتگو lazy است (باندل اولیه‌ی امضا/پرداخت/پنل)", () => {
  it("هیچ صفحه‌ای ChatWidget را مستقیم import نمی‌کند", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const files = ["src/app/sign/[token]/page.tsx", "src/app/pay/[code]/page.tsx", "src/app/pricing/page.tsx", "src/components/chat/PanelChatWidget.tsx"];
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(process.cwd(), f), "utf8");
      expect(src, f).toContain("LazyChatWidget");
      expect(src, f).not.toMatch(/from "(\.\/|@\/components\/chat\/)ChatWidget"/);
    }
    const lazy = fs.readFileSync(path.resolve(process.cwd(), "src/components/chat/LazyChatWidget.tsx"), "utf8");
    expect(lazy).toContain("ssr: false");
  });
});
