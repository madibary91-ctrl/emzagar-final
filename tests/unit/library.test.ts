import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@/lib/html";
import { parseFieldDefs } from "@/modules/fields";
import { CATEGORIES, LIBRARY, fillPlaceholders, getLibraryTemplate, libraryByCategory, listPlaceholders } from "@/modules/library";

const PERSIAN = /[\u0600-\u06FF]/g;

describe("کتابخانه‌ی قالب‌های آماده", () => {
  it("حداقل ۳۰ قالب با کلید یکتا و همه‌ی دسته‌ها پر است", () => {
    expect(LIBRARY.length).toBeGreaterThanOrEqual(30);
    expect(new Set(LIBRARY.map((t) => t.key)).size).toBe(LIBRARY.length);
    for (const g of libraryByCategory()) expect(g.items.length, g.label).toBeGreaterThanOrEqual(3);
    expect(CATEGORIES.map((c) => c.id)).toEqual(expect.arrayContaining(["housing", "vehicle", "finance", "work"]));
  });

  it("هر قالب متن فارسی کامل، مواد شماره‌دار و بندهای استاندارد دارد", () => {
    for (const t of LIBRARY) {
      const text = t.body.replace(/<[^>]*>/g, " ");
      const fa = text.match(PERSIAN)?.length ?? 0;
      expect(fa / text.replace(/\s/g, "").length, t.key).toBeGreaterThan(0.5);
      expect(t.articleCount, t.key).toBeGreaterThanOrEqual(7);
      expect(t.wordCount, t.key).toBeGreaterThan(200);
      expect(t.body, t.key).toContain("[CONTRACT_NUMBER]");
      expect(t.body, t.key).toContain("حل اختلاف");
      expect(t.body, t.key).toContain("امضای الکترونیکی");
      expect(t.body, t.key).not.toMatch(/<script|undefined|\{A\}|\{B\}/);
    }
  });

  it("قالب‌ها مفاهیم رایج معاملات ایرانی را پوشش می‌دهند", () => {
    const all = LIBRARY.map((t) => t.body).join(" ");
    for (const w of ["چک صیادی", "سفته", "ضامن", "بیعانه", "وجه التزام", "کد رهگیری", "دفترخانه", "قانون مدنی", "قانون کار", "سرقفلی"]) expect(all, w).toContain(w);
  });

  it("فیلدهای امضاکننده معتبرند و کد ملی طرف دوم همیشه گرفته می‌شود", () => {
    for (const t of LIBRARY) {
      const keys = parseFieldDefs(t.body).map((d) => d.key);
      expect(keys, t.key).toContain("p2_nid");
      expect(keys, t.key).toContain("p2_address");
      t.extraSigners.forEach((_l, i) => expect(keys, t.key).toContain(`s${i + 1}_nid`));
    }
  });

  it("جاهای خالی: استخراج، پر شدن با escape کامل و تبدیل بقیه به «……»", () => {
    const t = getLibraryTemplate("rent-residential")!;
    const ph = listPlaceholders(t.body);
    expect(ph.find((p) => p.key === "p1_name")).toBeTruthy();
    expect(ph.length).toBeGreaterThan(10);
    const filled = fillPlaceholders(t.body, { p1_name: `علی <img src=x onerror=alert(1)>` });
    expect(filled).not.toContain("<img");
    expect(filled).toContain("&lt;img");
    expect(filled).not.toMatch(/\(\([a-z0-9_]+\|/);
    expect(filled).toContain("……");
  });

  it("پاکسازی HTML توکن‌های فیلد را سالم نگه می‌دارد", () => {
    for (const t of LIBRARY) {
      const clean = sanitizeHtml(fillPlaceholders(t.body));
      expect(parseFieldDefs(clean).length, t.key).toBe(parseFieldDefs(t.body).length);
      expect(clean, t.key).toContain("[USER_NAME]");
    }
  });
});
