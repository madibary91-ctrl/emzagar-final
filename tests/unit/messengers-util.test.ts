import { describe, expect, it } from "vitest";
import { BOT_TOKEN_RE, chunkText, deepLink, headerSecretFor, inlineKeyboard, makeGuestLinkCode, maskMobile, normalizeMobile, parseGuestLinkCode, safeEqual, urlButtonSafe } from "@/modules/messengers/util";

describe("ربات پیام‌رسان — توابع خالص", () => {
  it("نرمال‌سازی موبایل در همه‌ی قالب‌های رایج", () => {
    for (const raw of ["+989121234567", "00989121234567", "9121234567", "09121234567", "۰۹۱۲۱۲۳۴۵۶۷", "+98 912 123 4567", "٠٩١٢١٢٣٤٥٦٧"]) expect(normalizeMobile(raw)).toBe("09121234567");
    for (const raw of ["", "12345", "+14155550123", "0212345678", null, undefined]) expect(normalizeMobile(raw)).toBe("");
    expect(maskMobile("09121234567")).toBe("0912***67");
  });

  it("قالب توکن ربات", () => {
    expect(BOT_TOKEN_RE.test("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(true);
    expect(BOT_TOKEN_RE.test("abc:123")).toBe(false);
    expect(BOT_TOKEN_RE.test("123456789:short")).toBe(false);
    expect(BOT_TOKEN_RE.test("123456789:AAH dqTcvCH1vGWJxfSeofSAs0K5PALDsaw")).toBe(false);
  });

  it("کد اتصال مهمان: امضاشده، کوتاه‌عمر و ضد دست‌کاری", () => {
    const now = Date.UTC(2026, 0, 1);
    const code = makeGuestLinkCode(4242, 60, now);
    expect(code.length).toBeLessThanOrEqual(64);
    expect(/^[A-Za-z0-9_-]+$/.test(code)).toBe(true);
    expect(parseGuestLinkCode(code, now + 30 * 60_000)).toBe(4242);
    expect(parseGuestLinkCode(code, now + 61 * 60_000)).toBeNull(); // منقضی
    // تغییر شناسه‌ی کاربر (تلاش برای اتصال به کاربر دیگر) رد می‌شود
    const tampered = "g" + (4243).toString(36) + code.slice(code.indexOf("_"));
    expect(parseGuestLinkCode(tampered, now)).toBeNull();
    expect(parseGuestLinkCode("gzzz_zzz_AAAAAAAAAAAAAA", now)).toBeNull();
    expect(parseGuestLinkCode("lsomething", now)).toBeNull();
  });

  it("لینک عمیق، راز هدر و مقایسه‌ی ایمن", () => {
    expect(deepLink("bale", "emz_bot", "abc")).toBe("https://ble.ir/emz_bot?start=abc");
    expect(deepLink("telegram", "emz_bot")).toBe("https://t.me/emz_bot");
    expect(headerSecretFor("a".repeat(48))).toHaveLength(48);
    expect(headerSecretFor("a".repeat(48))).not.toBe(headerSecretFor("b".repeat(48)));
    expect(safeEqual("x", "x")).toBe(true);
    expect(safeEqual("x", "xy")).toBe(false);
  });

  it("تکه‌کردن پیام بلند و صفحه‌کلید", () => {
    const long = Array.from({ length: 900 }, (_, i) => `خط شماره ${i}`).join("\n");
    const parts = chunkText(long, 3800);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 3800)).toBe(true);
    expect(parts.join("\n").replace(/\n/g, "")).toBe(long.replace(/\n/g, ""));
    const kb = inlineKeyboard([[{ text: "امضا", url: "https://example.com/s/1" }, { text: "", data: "x" }], [{ text: "وضعیت", data: "c:12" }], []]);
    expect(kb?.inline_keyboard).toEqual([[{ text: "امضا", url: "https://example.com/s/1" }], [{ text: "وضعیت", callback_data: "c:12" }]]);
    expect(inlineKeyboard([[]])).toBeUndefined();
    expect(urlButtonSafe("https://emz.example.ir/sign/x")).toBe(true);
    expect(urlButtonSafe("http://localhost:3000/sign/x")).toBe(false);
    expect(urlButtonSafe("javascript:alert(1)")).toBe(false);
  });
});
