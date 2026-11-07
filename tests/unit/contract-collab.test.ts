import { describe, expect, it } from "vitest";
import { countWords, diffHtml, diffStats, diffText, htmlToText } from "@/lib/diff";
import { summarizeApprovals } from "@/modules/contracts/approvals";
import { normalizeTags, parseTags } from "@/modules/contracts/service";
import { BUILTIN_CLAUSES, CLAUSE_CATEGORIES } from "@/modules/clauses/builtin";
import { sanitizeHtml } from "@/lib/html";

describe("مقایسه‌ی نسخه‌ها (diff)", () => {
  it("HTML را به متن با حفظ شکست پاراگراف تبدیل می‌کند", () => {
    expect(htmlToText("<h2>ماده ۱</h2><p>متن&nbsp;اول</p><p>دوم &amp; سوم</p>")).toBe("ماده ۱\nمتن اول\nدوم & سوم");
    expect(countWords("<p>یک دو سه</p>")).toBe(3);
  });
  it("افزوده‌ها و حذف‌شده‌ها را کلمه‌به‌کلمه تشخیص می‌دهد", () => {
    const parts = diffText("مبلغ قرارداد ده میلیون تومان است", "مبلغ قرارداد بیست میلیون تومان است و نقدی");
    const st = diffStats(parts);
    expect(st.changed).toBe(true);
    expect(parts.find((p) => p.type === "del")?.text).toContain("ده");
    expect(parts.find((p) => p.type === "add")?.text).toContain("بیست");
    expect(st.added).toBeGreaterThanOrEqual(3);
    expect(st.removed).toBe(1);
  });
  it("متن یکسان تفاوتی ندارد و بازسازی متن اصلی ممکن است", () => {
    expect(diffStats(diffHtml("<p>الف ب ج</p>", "<p>الف ب ج</p>")).changed).toBe(false);
    const a = "بند یک. طرفین موظفند. بند سه";
    const b = "بند یک. هر دو طرف موظفند. بند سه. بند چهار";
    const parts = diffText(a, b);
    expect(parts.filter((p) => p.type !== "add").map((p) => p.text).join("")).toBe(a);
    expect(parts.filter((p) => p.type !== "del").map((p) => p.text).join("")).toBe(b);
  });
  it("متن بسیار بزرگ بدون خطا و سریع پردازش می‌شود", () => {
    const big = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
    const t0 = Date.now();
    const parts = diffText(big(6000, "الف"), big(6000, "ب"));
    expect(parts.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("تأیید داخلی", () => {
  it("تا تأیید همه، انتشار مسدود است", () => {
    expect(summarizeApprovals([]).blocked).toBe(false);
    expect(summarizeApprovals([{ status: "approved" }, { status: "pending" }])).toMatchObject({ total: 2, approved: 1, pending: 1, blocked: true });
    expect(summarizeApprovals([{ status: "approved" }, { status: "approved" }]).blocked).toBe(false);
    expect(summarizeApprovals([{ status: "approved" }, { status: "changes_requested" }])).toMatchObject({ changes: 1, blocked: true });
  });
});

describe("برچسب‌ها و کتابخانه‌ی بندها", () => {
  it("برچسب‌ها پاکسازی، یکتا و محدود می‌شوند", () => {
    expect(normalizeTags(" الف ، ب,الف\n ج ")).toBe("الف,ب,ج");
    expect(parseTags(normalizeTags("x".repeat(40)))[0]).toHaveLength(24);
    expect(parseTags(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(",")))).toHaveLength(8);
    expect(normalizeTags("")).toBe("");
  });
  it("بندهای آماده معتبر، یکتا و بدون اسکریپت‌اند", () => {
    const ids = new Set(BUILTIN_CLAUSES.map((c) => c.id));
    expect(ids.size).toBe(BUILTIN_CLAUSES.length);
    for (const c of BUILTIN_CLAUSES) {
      expect(c.category in CLAUSE_CATEGORIES).toBe(true);
      expect(sanitizeHtml(c.body)).toContain("<p>");
      expect(c.body).not.toMatch(/<script/i);
    }
  });
});
