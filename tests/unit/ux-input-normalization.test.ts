import { describe, expect, it } from "vitest";
import { normalizeDigits, parseLooseInt } from "@/lib/numbers";
import { parseIranMobile } from "@/lib/phone";
import { endOfDayTehran, isoDateTehran } from "@/lib/jalali";

describe("ورودی عددی کاربر ایرانی", () => {
  it("ارقام فارسی/عربی و جداکننده‌ها نرمال می‌شوند", () => {
    expect(normalizeDigits("۳۰")).toBe("30");
    expect(normalizeDigits("٣٠")).toBe("30");
    expect(normalizeDigits("۵٬۰۰۰٬۰۰۰")).toBe("5000000");
    expect(normalizeDigits(" 1,200 ")).toBe("1200");
    expect(normalizeDigits("۱۲\u200c۳")).toBe("123");
    expect(normalizeDigits(null)).toBe("");
  });

  it("parseLooseInt: خالی = null؛ نامعتبر/خارج از بازه = خطای روشن (نه نادیده‌گرفتن بی‌صدا)", () => {
    expect(parseLooseInt("", { label: "x" })).toEqual({ ok: true, value: null });
    expect(parseLooseInt("   ", { label: "x" })).toEqual({ ok: true, value: null });
    expect(parseLooseInt("۳۰", { label: "x", min: 0, max: 3650 })).toEqual({ ok: true, value: 30 });
    expect(parseLooseInt("0", { label: "x", min: 0 })).toEqual({ ok: true, value: 0 });
    for (const bad of ["abc", "12.5", "-3", "۳۰ روز", "1e3"]) {
      const r = parseLooseInt(bad, { label: "مهلت امضا", min: 0, max: 3650 });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toContain("مهلت امضا");
    }
    const big = parseLooseInt("99999", { label: "مهلت", min: 0, max: 3650 });
    expect(big.ok).toBe(false);
    const huge = parseLooseInt("9".repeat(30), { label: "مبلغ" });
    expect(huge.ok).toBe(false);
  });
});

describe("موبایل ایران", () => {
  it("همه‌ی قالب‌های رایج به 09xxxxxxxxx تبدیل می‌شوند", () => {
    for (const v of ["09123456789", "۰۹۱۲۳۴۵۶۷۸۹", "٠٩١٢٣٤٥٦٧٨٩", "+989123456789", "00989123456789", "989123456789", "9123456789", "0912 345 6789", "0912-345-6789", "(0912) 3456789"]) {
      expect(parseIranMobile(v), v).toBe("09123456789");
    }
  });
  it("نامعتبرها null می‌شوند", () => {
    for (const v of ["", "0812345678", "0912345", "091234567890", "abc", "+19123456789", "912345678"]) expect(parseIranMobile(v), v).toBeNull();
  });
});

describe("تاریخ به وقت تهران", () => {
  it("isoDateTehran: لحظه‌ی ۰۰:۳۰ تهران هنوز «همان روز» است (UTC یک روز عقب است)", () => {
    const d = new Date("2026-05-04T21:00:00Z"); // 00:30 تهران، ۱۴ اردیبهشت ← ۲۰۲۶-۰۵-۰۵
    expect(d.toISOString().slice(0, 10)).toBe("2026-05-04");
    expect(isoDateTehran(d)).toBe("2026-05-05");
    expect(isoDateTehran(null)).toBe("");
    expect(isoDateTehran("not-a-date")).toBe("");
  });
  it("endOfDayTehran: «آخرین مهلت X» یعنی تا پایان روز X؛ ورودی نامعتبر null", () => {
    const e = endOfDayTehran("2026-05-05")!;
    expect(isoDateTehran(e)).toBe("2026-05-05");
    expect(e.toISOString()).toBe("2026-05-05T20:29:59.000Z");
    expect(endOfDayTehran("2026-02-30")).toBeNull();
    expect(endOfDayTehran("05/05/2026")).toBeNull();
    expect(endOfDayTehran("")).toBeNull();
  });
});
