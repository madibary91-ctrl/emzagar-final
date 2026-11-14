import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes } from "@/db/schema";
import { createOtp, secondsUntilResend, verifyOtp } from "@/modules/signing/otp";

const ids = () => ({ contractId: 1, signerId: Math.floor(Math.random() * 1e9), userId: 1 });

describe("OTP امضا", () => {
  it("کد ۵ رقمی درست پذیرفته و فقط یک‌بار مصرف می‌شود", async () => {
    const p = ids();
    const code = await createOtp(p);
    expect(code).toMatch(/^\d{5}$/);
    expect((await verifyOtp(p.signerId, code)).ok).toBe(true);
    expect((await verifyOtp(p.signerId, code)).ok).toBe(false);
  });
  it("کد نادرست رد می‌شود و کد درست بعدش هنوز معتبر است", async () => {
    const p = ids();
    const code = await createOtp(p);
    const wrong = code === "10000" ? "10001" : "10000";
    expect((await verifyOtp(p.signerId, wrong)).ok).toBe(false);
    expect((await verifyOtp(p.signerId, code)).ok).toBe(true);
  });
  it("پس از ۵ تلاش اشتباه حتی کد درست رد می‌شود (حمله‌ی brute-force)", async () => {
    const p = ids();
    const code = await createOtp(p);
    const wrong = code === "10000" ? "10001" : "10000";
    for (let i = 0; i < 5; i++) await verifyOtp(p.signerId, wrong);
    const r = await verifyOtp(p.signerId, code);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/تلاش/);
  });
  it("تلاش‌های موازی از سقف ۵ تلاش عبور نمی‌کنند", async () => {
    const p = ids();
    const code = await createOtp(p);
    const wrong = code === "10000" ? "10001" : "10000";
    await Promise.all(Array.from({ length: 12 }, () => verifyOtp(p.signerId, wrong)));
    const [row] = await db.select().from(otpCodes).where(eq(otpCodes.signerId, p.signerId));
    expect(row.attempts).toBeLessThanOrEqual(5);
  });
  it("سقف تجمعی ۲۴ ساعته: با درخواست پیاپی کد تازه هم نمی‌توان بی‌نهایت حدس زد", async () => {
    const p = ids();
    let last = "";
    // ۴ کدِ پیاپی × ۵ حدس نادرست = ۲۰ حدس (سقف روزانه)
    for (let round = 0; round < 4; round++) {
      last = await createOtp(p);
      const wrong = last === "10000" ? "10001" : "10000";
      for (let i = 0; i < 5; i++) await verifyOtp(p.signerId, wrong);
    }
    // کدِ تازه‌ی پنجم حتی با مقدار درست پذیرفته نمی‌شود
    const fresh = await createOtp(p);
    const r = await verifyOtp(p.signerId, fresh);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/۲۴ ساعت/);
    void last;
  });
  it("کد منقضی‌شده رد می‌شود", async () => {
    const p = ids();
    const code = await createOtp(p);
    await db.update(otpCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(otpCodes.signerId, p.signerId));
    expect((await verifyOtp(p.signerId, code)).error).toMatch(/منقضی/);
  });
  it("کد امضاکننده‌ی دیگر معتبر نیست", async () => {
    const a = ids();
    const b = ids();
    const code = await createOtp(a);
    const codeB = await createOtp(b);
    // کد A روی B معتبر نیست (هش به شناسه‌ی امضاکننده وابسته است)؛ مگر برخورد تصادفی ۱ در ۹۰هزار
    expect((await verifyOtp(b.signerId, code)).ok).toBe(code === codeB);
  });
  it("فاصله‌ی ارسال مجدد اعمال می‌شود", async () => {
    const p = ids();
    expect(await secondsUntilResend(p.signerId)).toBe(0);
    await createOtp(p);
    expect(await secondsUntilResend(p.signerId)).toBeGreaterThan(100);
  });
});
