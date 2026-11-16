import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { rateLimitBuckets, users } from "@/db/schema";
import { eq, like } from "drizzle-orm";
import { hashPassword } from "@/lib/password";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { loginAction } from "@/modules/auth/actions";
import { LOGIN_ACCT_UNFAMILIAR_LIMIT, LOGIN_PAIR_LIMIT, normalizeEmailKey } from "@/modules/auth/throttle";
import { tryAcquireLock, releaseLock } from "@/lib/db-lock";
import { createWorkspace } from "@/modules/tenancy/service";
import { env, form, freshBrowser, run, setIp, uniq } from "../helpers";

const PASS = "Victim-Passw0rd9";
const BLOCKED = /تلاش‌های ناموفق زیاد/;
const login = (email: string, password: string) => run(() => loginAction({}, form({ email, password })));

async function makeUser(): Promise<string> {
  const email = `${uniq("v")}@example.com`;
  const [u] = await db.insert(users).values({ name: "قربانی", email, mobile: "09120000123", passwordHash: hashPassword(PASS), role: "user", emailVerifiedAt: new Date() }).returning();
  await createWorkspace(u.id, "قربانی");
  return email;
}

beforeAll(() => {
  // محیط آزمون: هیچ هدر پراکسی‌ای به‌جز X-Forwarded-For که هر آزمون با setIp می‌گذارد
});
beforeEach(() => freshBrowser());

describe("M-03: قفل‌کردن حساب دیگران (Account Lockout DoS)", () => {
  it("مهاجم با ۸+ تلاش فقط خودش را قفل می‌کند؛ صاحب حساب از IP دیگر وارد می‌شود", async () => {
    const email = await makeUser();
    setIp("10.77.0.1"); // مهاجم
    for (let i = 0; i < LOGIN_PAIR_LIMIT; i++) {
      const r = await login(email, `wrong-${i}`);
      expect(r.result?.error).toMatch(/اشتباه/);
    }
    const locked = await login(email, `wrong-x`);
    expect(locked.result?.error).toMatch(BLOCKED); // مهاجم قفل شد (حتی با رمز درست قفل می‌ماند)
    expect((await login(email, PASS)).result?.error).toMatch(BLOCKED);

    freshBrowser();
    setIp("10.77.0.2"); // صاحب حساب
    const ok = await login(email, PASS);
    expect(ok.redirect).toBeTruthy();
    expect(env.cookies.has("amz_session")).toBe(true);
  });

  it("کلید ایمیل نرمال‌سازی می‌شود (حروف بزرگ/فاصله/Unicode یک سطل‌اند) و مهاجم با تغییر حروف دور نمی‌زند", async () => {
    expect(normalizeEmailKey("  Victim@EXAMPLE.com ")).toBe("victim@example.com");
    expect(normalizeEmailKey("ｖｉｃｔｉｍ@example.com")).toBe("victim@example.com"); // NFKC (فول‌ویدث)
    const email = await makeUser();
    setIp("10.77.0.3");
    for (let i = 0; i < LOGIN_PAIR_LIMIT; i++) await login(i % 2 ? email.toUpperCase() : ` ${email} `, "bad");
    expect((await login(email, "bad")).result?.error).toMatch(BLOCKED);
  });

  it("حدس توزیع‌شده: پس از سقف تجمعی فقط IPهای «ناآشنا» مسدود می‌شوند؛ IP آشنای صاحب حساب همچنان وارد می‌شود", async () => {
    const email = await makeUser();
    setIp("10.77.1.1"); // IP آشنا: یک ورود موفق نشست (و IP) ثبت می‌کند
    expect((await login(email, PASS)).redirect).toBeTruthy();

    // مهاجم از IPهای مختلف، هرکدام یک‌بار (زیر سقف IP/ایمیل+IP) سقف تجمعی حساب را پر می‌کند
    for (let i = 0; i < LOGIN_ACCT_UNFAMILIAR_LIMIT + 2; i++) {
      freshBrowser();
      setIp(`10.77.2.${i + 1}`);
      await login(email, "guess");
    }
    freshBrowser();
    setIp("10.77.3.200"); // IP ناآشنا (حتی با رمز درست): مسدود
    expect((await login(email, PASS)).result?.error).toMatch(BLOCKED);

    freshBrowser();
    setIp("10.77.1.1"); // IP آشنای صاحب حساب: مجاز
    const ok = await login(email, PASS);
    expect(ok.redirect).toBeTruthy();
  });

  it("سقف هر IP مستقل است: IP مهاجم با ایمیل‌های مختلف سقف ۳۰تایی IP را می‌خورد", async () => {
    setIp("10.77.4.4");
    let blockedAt = 0;
    for (let i = 1; i <= 35; i++) {
      const r = await login(`nobody-${i}-${uniq()}@example.com`, "x");
      if (BLOCKED.test(r.result?.error ?? "")) {
        blockedAt = i;
        break;
      }
    }
    expect(blockedAt).toBe(31);
  });
});

describe("M-04: محدودکننده‌ی پایدار (PostgreSQL)", () => {
  it("شمارنده با «ری‌استارت» (بارگذاری مجدد ماژول و پاک‌شدن حافظه) ریست نمی‌شود", async () => {
    const key = `m04:persist:${uniq()}`;
    for (let i = 0; i < 3; i++) expect((await rateLimitDb(key, 3, 60_000)).ok).toBe(true);
    expect((await rateLimitDb(key, 3, 60_000)).ok).toBe(false);
    vi.resetModules(); // حافظه‌ی پردازه‌ی جدید
    const fresh = await import("@/lib/rate-limit-db");
    const again = await fresh.rateLimitDb(key, 3, 60_000);
    expect(again.ok).toBe(false);
    expect(again.retryAfter).toBeGreaterThan(0);
  });

  it("شمارش اتمیک: ۵۰ درخواست هم‌زمان دقیقاً ۱۰ مجاز دارد", async () => {
    const key = `m04:atomic:${uniq()}`;
    const rs = await Promise.all(Array.from({ length: 50 }, () => rateLimitDb(key, 10, 60_000)));
    expect(rs.filter((r) => r.ok).length).toBe(10);
  });

  it("سرریز سطل‌ها سطل قربانی را بیرون نمی‌ریزد (حافظه: سطل‌های فعال حفظ؛ دیتابیس: بدون سقف تعداد)", async () => {
    // لایه‌ی حافظه
    const vKey = `m04:victim:${uniq()}`;
    rateLimit(vKey, 3, 60_000);
    rateLimit(vKey, 3, 60_000); // n=2 → «سطل فعال»
    for (let i = 0; i < 30_000; i++) rateLimit(`m04:spray:${i}`, 5, 60_000);
    expect(rateLimit(vKey, 3, 60_000).ok).toBe(true); // n=3
    expect(rateLimit(vKey, 3, 60_000).ok).toBe(false); // شمارنده صفر نشده بود
    // لایه‌ی دیتابیس
    const dKey = `m04:dbvictim:${uniq()}`;
    await rateLimitDb(dKey, 2, 60_000);
    await rateLimitDb(dKey, 2, 60_000);
    await Promise.all(Array.from({ length: 300 }, (_, i) => rateLimitDb(`m04:dbspray:${uniq()}:${i}`, 5, 60_000)));
    expect((await rateLimitDb(dKey, 2, 60_000)).ok).toBe(false);
  });

  it("کلیدهای بلند با پیشوند یکسان برخورد نمی‌کنند (SHA-256 کامل)", async () => {
    const prefix = `m04:long:${uniq()}:` + "x".repeat(300);
    expect((await rateLimitDb(prefix + "A", 1, 60_000)).ok).toBe(true);
    expect((await rateLimitDb(prefix + "A", 1, 60_000)).ok).toBe(false);
    expect((await rateLimitDb(prefix + "B", 1, 60_000)).ok).toBe(true); // سطل جدا
    const rows = await db.select().from(rateLimitBuckets).where(like(rateLimitBuckets.key, "%"));
    expect(rows.every((r) => /^[a-f0-9]{64}$/.test(r.key) || r.key.startsWith("lock:"))).toBe(true); // فقط هش، نه متن کلید
  });

  it("resetRateLimit همه‌جا را پاک می‌کند (حافظه + دیتابیس) و ترتیب «reset ← شمارش» رعایت می‌شود", async () => {
    const key = `m04:reset:${uniq()}`;
    await rateLimitDb(key, 1, 60_000);
    expect((await rateLimitDb(key, 1, 60_000)).ok).toBe(false);
    resetRateLimit(key); // هم‌زمان؛ بازنشانی دیتابیس در پس‌زمینه
    expect((await rateLimitDb(key, 1, 60_000)).ok).toBe(true);
  });

  it("پنجره‌ی منقضی‌شده دوباره از صفر شروع می‌شود (ساعت دیتابیس)", async () => {
    const key = `m04:expire:${uniq()}`;
    await rateLimitDb(key, 1, 60_000);
    expect((await rateLimitDb(key, 1, 60_000)).ok).toBe(false);
    await db.update(rateLimitBuckets).set({ resetAt: new Date(Date.now() - 5000) });
    expect((await rateLimitDb(key, 1, 60_000)).ok).toBe(true);
  });

  it("قفل توزیع‌شده‌ی اجاره‌ای: دومی رد، پس از آزادسازی یا انقضا اجازه می‌دهد", async () => {
    const name = `m04:lock:${uniq()}`;
    expect(await tryAcquireLock(name, 60_000)).toBe(true);
    expect(await tryAcquireLock(name, 60_000)).toBe(false);
    await releaseLock(name);
    expect(await tryAcquireLock(name, 60_000)).toBe(true);
    await db.update(rateLimitBuckets).set({ resetAt: new Date(Date.now() - 1000) }).where(like(rateLimitBuckets.key, "lock:%"));
    expect(await tryAcquireLock(name, 60_000)).toBe(true); // اجاره‌ی منقضی‌شده
    await releaseLock(name);
    void eq;
  });
});
