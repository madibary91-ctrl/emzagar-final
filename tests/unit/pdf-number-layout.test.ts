import { describe, expect, it } from "vitest";
import { normalizeNumberSeparators, splitRuns, visualSegments } from "@/modules/pdf/text";
import { renderContractPdf } from "@/modules/pdf/render";

/**
 * رفع باگ Bidi در PDF: جداکننده‌های هزارگان فارسی/عربی (٬ ، ٫) میان ارقام، عدد را به چند ران
 * می‌شکستند و کاماها و ارقام از هم جدا و جابه‌جا می‌شدند.
 */
describe("اعداد یکپارچه در چیدمان PDF", () => {
  it("جداکننده‌های فارسی/عربی میان ارقام به ویرگول/نقطه‌ی لاتین یکدست می‌شوند", () => {
    expect(normalizeNumberSeparators("۷۵٬۰۰۰٬۰۰۰")).toBe("۷۵,۰۰۰,۰۰۰");
    expect(normalizeNumberSeparators("75،000،000")).toBe("75,000,000");
    expect(normalizeNumberSeparators("۱٬۲۵۰٫۵۰")).toBe("۱,۲۵۰.۵۰");
  });

  it("ویرگول عربی میان کلمات (نه ارقام) دست‌نخورده می‌ماند", () => {
    expect(normalizeNumberSeparators("الف، ب")).toBe("الف، ب");
    expect(normalizeNumberSeparators("۱۲، ۱۳")).toBe("۱۲، ۱۳");
  });

  it.each(["75,000,000", "75،000،000", "۷۵,۰۰۰,۰۰۰", "۷۵٬۰۰۰٬۰۰۰", "1,250.50", "۱٬۲۵۰٫۵۰"])("عدد «%s» در متن فارسی فقط یک ران چپ‌به‌راست است", (num) => {
    const runs = splitRuns(`مبلغ قرارداد ${num} ریال است`);
    expect(runs.map((r) => r.dir)).toEqual(["R", "L", "R"]);
    expect(runs[1].text).toBe(normalizeNumberSeparators(num));
    const ltr = visualSegments(`مبلغ قرارداد ${num} ریال است`).filter((s) => s.dir === "L");
    expect(ltr).toHaveLength(1); // عدد تکه‌تکه نشده است
  });

  it("عدد لاتین کامل و بدون جابه‌جایی رسم می‌شود", () => {
    const [seg] = visualSegments("مبلغ 75,000,000 ریال").filter((s) => s.dir === "L");
    expect(seg.text).toBe("75,000,000");
  });

  it("PDF با اعداد فارسی/لاتین ساخته می‌شود و اندازه‌ی معتبر دارد", async () => {
    const buf = await renderContractPdf({
      siteName: "امضاگر",
      number: "AMZ-2025-00001",
      title: "قرارداد 75,000,000",
      customerName: "علی",
      issuedAtText: "۱۴۰۴/۰۵/۱۲",
      completedAtText: "۱۴۰۴/۰۵/۱۳",
      bodyHtml: "<p>مبلغ ۷۵٬۰۰۰٬۰۰۰ تومان معادل 75،000،000 ریال.</p>",
      signers: [],
      docHash: "a".repeat(64),
      verifyUrl: "http://localhost/verify/x",
    });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(5000);
  });
});
