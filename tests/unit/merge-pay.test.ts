import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseCsvText, parseSpreadsheet, parseXlsxBuffer, SheetError } from "@/lib/spreadsheet";
import { buildSchedule, parseAmount, validatePlan, withScheduleBlock } from "@/modules/contract-pay/schedule";
import { checkRow, detectPlaceholders, guessMapping, norm, renderMerge } from "@/modules/merge/pure";

describe("برنامه‌ی پرداخت", () => {
  it("مجموع اقساط دقیقاً برابر مبلغ کل است (باقیمانده روی قسط آخر)", () => {
    const r = buildSchedule({ total: 10_000_001, depositPercent: 30, count: 3, intervalDays: 30, gateDeposit: true, now: new Date("2026-01-01T00:00:00Z") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.reduce((s, i) => s + i.amount, 0)).toBe(10_000_001);
    expect(r.items[0]).toMatchObject({ kind: "deposit", gate: "before_sign", dueAt: null });
    expect(r.items).toHaveLength(4);
    expect(r.items[1].dueAt).toBe("2026-01-31");
  });
  it("ورودی نامعتبر رد می‌شود", () => {
    expect(buildSchedule({ total: 500, count: 1, intervalDays: 30 }).ok).toBe(false);
    expect(buildSchedule({ total: 100_000, depositPercent: 95, count: 1, intervalDays: 30 }).ok).toBe(false);
    expect(buildSchedule({ total: 5_000, count: 36, intervalDays: 30 }).ok).toBe(false);
    expect(validatePlan([{ title: "x", amount: "12", dueAt: null }]).ok).toBe(false);
    expect(validatePlan([{ title: "قسط", amount: "5000", dueAt: "2026-13-45" }]).ok).toBe(false);
    expect(validatePlan([]).ok).toBe(false);
  });
  it("ارقام فارسی و جداکننده‌ها", () => {
    expect(parseAmount("۱٬۲۰۰٬۰۰۰ تومان")).toBe(1_200_000);
    expect(parseAmount("12,000")).toBe(12_000);
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
  });
  it("جدول داخل متن idempotent است و XSS ندارد", () => {
    const items = [{ title: "<b>x</b>", kind: "installment" as const, amount: 5000, dueAt: null, gate: "none" as const, payerPosition: 0 }];
    const once = withScheduleBlock("<p>متن</p>", items);
    const twice = withScheduleBlock(once, items);
    expect(twice).toBe(once);
    expect(once).not.toContain("<b>x</b>");
    expect(withScheduleBlock(once, null)).toBe("<p>متن</p>");
  });
});

describe("خواندن اکسل/CSV", () => {
  it("CSV: BOM، جداکننده‌ی ; ، گیومه و خط جدید داخل سلول", () => {
    const rows = parseCsvText('\uFEFFنام;موبایل;یادداشت\r\n"علی ""رضا""";09121234567;"خط ۱\nخط ۲"\n');
    expect(rows).toEqual([["نام", "موبایل", "یادداشت"], ['علی "رضا"', "09121234567", "خط ۱\nخط ۲"]]);
  });
  it("XLSX کمینه (sharedStrings + عدد) خوانده می‌شود", () => {
    const sheet = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>9123456789</v></c></row></sheetData></worksheet>`;
    const ss = `<?xml version="1.0"?><sst><si><t>نام</t></si><si><t>موبایل</t></si><si><t>سارا &amp; علی</t></si></sst>`;
    const zip = zipSync({ "xl/worksheets/sheet1.xml": strToU8(sheet), "xl/sharedStrings.xml": strToU8(ss) });
    expect(parseXlsxBuffer(zip)).toEqual([["نام", "موبایل"], ["سارا & علی", "9123456789"]]);
    const parsed = parseSpreadsheet(zip, "a.xlsx");
    expect(parsed.headers).toEqual(["نام", "موبایل"]);
  });
  it("فایل نامعتبر/خطرناک رد می‌شود", () => {
    expect(() => parseSpreadsheet(new Uint8Array([0x50, 0x4b, 1, 2, 3]), "x.xlsx")).toThrow(SheetError);
    expect(() => parseSpreadsheet(new Uint8Array([0xd0, 0xcf, 0x11]), "x.xls")).toThrow(SheetError);
    expect(() => parseSpreadsheet(new TextEncoder().encode("a,b\n1,2"), "x.exe")).toThrow(SheetError);
    expect(() => parseSpreadsheet(new TextEncoder().encode("a,b"), "x.csv")).toThrow(SheetError);
  });
});

describe("ادغام متغیرها", () => {
  const body = "<p>{{ سمت }} — [SALARY] — [USER_NAME] — {{field:nid|text}}</p>";
  it("متغیرها کشف و نگاشت می‌شوند (فارسی/عربی یکسان)", () => {
    const ph = detectPlaceholders(body);
    expect(ph.map((p) => p.key).sort()).toEqual(["SALARY", "USER_NAME", "سمت"].sort());
    const m = guessMapping(["نام و نام خانوادگي", "شماره موبایل", "سمت", "salary", "مبلغ"], ph);
    expect(m.roles.name).toBe("نام و نام خانوادگي");
    expect(m.roles.mobile).toBe("شماره موبایل");
    expect(m.vars["سمت"]).toBe("سمت");
    expect(m.vars.SALARY).toBe("salary");
    expect(norm("ك ي")).toBe("کی");
  });
  it("مقدار HTML-escape می‌شود و توکن فیلد دست‌نخورده می‌ماند", () => {
    const out = renderMerge(body, { سمت: "<script>alert(1)</script>", SALARY: "۱۰" });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("{{field:nid|text}}");
    expect(out).toContain("[USER_NAME]");
  });
  it("اعتبارسنجی ردیف", () => {
    const mapping = { roles: { name: "n", mobile: "m", amount: "", deposit: "", count: "" }, vars: { سمت: "p" } };
    expect(checkRow({ n: "علی رضایی", m: "۰۹۱۲۱۲۳۴۵۶۷", p: "مدیر" }, mapping)).toMatchObject({ ok: true, mobile: "09121234567" });
    expect(checkRow({ n: "علی رضایی", m: "123", p: "مدیر" }, mapping).ok).toBe(false);
    expect(checkRow({ n: "ع", m: "09121234567", p: "مدیر" }, mapping).ok).toBe(false);
    expect(checkRow({ n: "علی رضایی", m: "09121234567", p: "" }, mapping).ok).toBe(false);
  });
});
