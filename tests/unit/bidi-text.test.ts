import { describe, expect, it } from "vitest";
import { isRtlText, splitRuns, visualSegments } from "@/modules/pdf/text";
import { domainCannotReceiveMail, emailRejection, isDisposableEmail } from "@/lib/email-check";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { parseSignatureDataUrl } from "@/modules/signing/types";
import { makePng } from "../helpers";

describe("چیدمان دوطرفه‌ی متن PDF", () => {
  it("فارسی و لاتین را به ران‌های جدا می‌شکند", () => {
    const runs = splitRuns("شماره AMZ-2025-00001 در تاریخ");
    expect(runs.map((r) => r.dir)).toEqual(["R", "L", "R"]);
    expect(runs[1].text).toBe("AMZ-2025-00001");
  });
  it("عدد فارسی یک ران چپ‌به‌راست است و از پیش وارونه می‌شود (جبران fontkit)", () => {
    const segs = visualSegments("مبلغ ۱۲۳ تومان");
    const digits = segs.find((s) => s.dir === "L");
    expect(digits?.text).toContain("۳۲۱");
  });
  it("ترتیب بصری: اولین ران منطقی سمت راست‌ترین است", () => {
    const segs = visualSegments("الف ABC ب");
    expect(segs[0].text).toContain("ب");
    expect(segs[segs.length - 1].text).toContain("الف");
  });
  it("پرانتز در متن فارسی آینه می‌شود", () => {
    expect(visualSegments("(متن)")[0].text).toBe(")متن(");
  });
  it("جهت پاراگراف را تشخیص می‌دهد", () => {
    expect(isRtlText("این یک متن فارسی است")).toBe(true);
    expect(isRtlText("This is English")).toBe(false);
  });
});

describe("فیلتر ایمیل جعلی", () => {
  it("دامنه‌های یک‌بارمصرف و زیردامنه‌هایشان رد می‌شوند", () => {
    expect(isDisposableEmail("x@mailinator.com")).toBe(true);
    expect(isDisposableEmail("x@sub.yopmail.com")).toBe(true);
    expect(isDisposableEmail("x@gmail.com")).toBe(false);
  });
  it("emailRejection پیام می‌دهد (با فیلتر فعال)", async () => {
    const old = process.env.SKIP_EMAIL_DOMAIN_CHECK;
    process.env.SKIP_EMAIL_DOMAIN_CHECK = "0";
    try {
      expect(await emailRejection("a@guerrillamail.com")).toMatch(/موقت/);
    } finally {
      process.env.SKIP_EMAIL_DOMAIN_CHECK = old;
    }
  });
  it("دامنه‌ی نامعتبر قطعاً ایمیل نمی‌گیرد", async () => {
    expect(await domainCannotReceiveMail("not a domain")).toBe(true);
  });
});

describe("محدودکننده‌ی نرخ", () => {
  it("بعد از سقف مسدود می‌کند و با ریست آزاد می‌شود", () => {
    const k = `t:${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(rateLimit(k, 3, 60_000).ok).toBe(true);
    expect(rateLimit(k, 3, 60_000).ok).toBe(false);
    resetRateLimit(k);
    expect(rateLimit(k, 3, 60_000).ok).toBe(true);
  });
});

describe("اعتبارسنجی تصویر امضا", () => {
  it("PNG معتبر را می‌پذیرد", () => expect("buffer" in parseSignatureDataUrl(makePng())).toBe(true));
  it("فرمت یا حجم نامعتبر را رد می‌کند", () => {
    expect("error" in parseSignatureDataUrl("data:image/jpeg;base64,AAAA")).toBe(true);
    expect("error" in parseSignatureDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect("error" in parseSignatureDataUrl(`data:image/png;base64,${Buffer.alloc(2000, 1).toString("base64")}`)).toBe(true); // PNG نیست
    expect("error" in parseSignatureDataUrl(undefined)).toBe(true);
  });
});
