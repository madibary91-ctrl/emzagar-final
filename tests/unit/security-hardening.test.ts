import { afterEach, describe, expect, it } from "vitest";
import { trustedAppOrigin } from "@/lib/config";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";

describe("آدرس مورد اعتماد سایت (ضد Host Header Injection)", () => {
  const saved = process.env.APP_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  });

  it("APP_URL معتبر برگردانده می‌شود و اسلش پایانی حذف می‌شود", () => {
    process.env.APP_URL = "https://app.example.com/";
    expect(trustedAppOrigin()).toBe("https://app.example.com");
  });
  it("مقدار نامعتبر یا حاوی مسیر/نویسه‌ی مشکوک رد می‌شود", () => {
    for (const bad of ["javascript:alert(1)", "https://evil.com/<script>", "ftp://x.com", "https://a b.com", "//evil.com"]) {
      process.env.APP_URL = bad;
      expect(trustedAppOrigin()).toBe("");
    }
  });
});

describe("محدودکننده‌ی نرخ", () => {
  it("کلیدهای بسیار طولانی کوتاه می‌شوند ولی همچنان محدود می‌کنند", () => {
    const key = "forgot:" + "a".repeat(5000);
    resetRateLimit(key);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(false);
    // کلید طولانیِ دیگر با همان پیشوند ۲۰۰ نویسه‌ای، همان سطل است
    expect(rateLimit("forgot:" + "a".repeat(9000), 2, 60_000).ok).toBe(false);
    resetRateLimit(key);
  });
  it("حافظه محدود می‌ماند: ده‌ها هزار کلید یکتا خطا نمی‌دهد و محدودیت کار می‌کند", () => {
    for (let i = 0; i < 30_000; i++) rateLimit(`spray:${i}`, 5, 60_000);
    expect(rateLimit("spray:x", 1, 60_000).ok).toBe(true);
    expect(rateLimit("spray:x", 1, 60_000).ok).toBe(false);
  });
});
