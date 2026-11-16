import { describe, expect, it } from "vitest";
import { formatJalali, isoToJalali, isValidJalali, jalaliToIso, jalaliWeekday, parseJalaliInput, toGregorian, toJalali, todayJalali } from "@/lib/jalali";

/** مرجع مستقل: Intl با تقویم persian (ICU) */
const ref = new Intl.DateTimeFormat("en-u-ca-persian", { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" });
const part = (d: Date, k: string) => {
  const x = ref.formatToParts(d).find((p) => p.type === k);
  return x ? Number(x.value.replace(/\D/g, "")) : 0;
};

describe("تبدیل میلادی ⇄ شمسی (پایه‌ی تقویم شمسی فرم‌ها)", () => {
  it("نمونه‌های شناخته‌شده", () => {
    expect(toJalali(2026, 5, 5)).toEqual({ jy: 1405, jm: 2, jd: 15 });
    expect(toJalali(2025, 3, 21)).toEqual({ jy: 1404, jm: 1, jd: 1 });
    expect(toJalali(2024, 3, 19)).toEqual({ jy: 1402, jm: 12, jd: 29 });
    expect(toJalali(2024, 3, 20)).toEqual({ jy: 1403, jm: 1, jd: 1 });
    expect(toGregorian(1403, 12, 30)).toEqual({ gy: 2025, gm: 3, gd: 20 }); // اسفند کبیسه‌ی ۱۴۰۳
    expect(jalaliToIso(1405, 2, 15)).toBe("2026-05-05");
    expect(isoToJalali("2026-05-05")).toEqual({ jy: 1405, jm: 2, jd: 15 });
  });

  it("همه‌ی روزهای ۱۹۰۰ تا ۲۱۰۰ میلادی با Intl یکی است و رفت‌وبرگشت دقیق دارد", () => {
    for (let t = Date.UTC(1900, 0, 1); t < Date.UTC(2100, 0, 1); t += 86_400_000) {
      const d = new Date(t + 12 * 3_600_000);
      const got = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      expect([got.jy, got.jm, got.jd]).toEqual([part(d, "relatedYear") || part(d, "year"), part(d, "month"), part(d, "day")]);
      expect(toGregorian(got.jy, got.jm, got.jd)).toEqual({ gy: d.getUTCFullYear(), gm: d.getUTCMonth() + 1, gd: d.getUTCDate() });
      expect(jalaliWeekday(got.jy, got.jm, got.jd)).toBe((d.getUTCDay() + 1) % 7); // ۰ = شنبه
    }
  });

  it("تاریخ‌های ناممکن رد می‌شوند (اسفند ۳۰ در سال غیرکبیسه، ماه ۱۳، روز ۳۲)", () => {
    expect(isValidJalali(1404, 12, 30)).toBe(false);
    expect(jalaliToIso(1404, 12, 30)).toBeNull();
    expect(isValidJalali(1403, 12, 30)).toBe(true);
    expect(isValidJalali(1405, 13, 1)).toBe(false);
    expect(isValidJalali(1405, 1, 32)).toBe(false);
    expect(isValidJalali(1405, 7, 31)).toBe(false);
    expect(isoToJalali("2026-02-30")).toBeNull();
    expect(isoToJalali("نامعتبر")).toBeNull();
  });

  it("ورودی تایپ‌شده با ارقام فارسی/عربی و جداکننده‌های مختلف", () => {
    for (const s of ["۱۴۰۵/۲/۱۵", "1405-02-15", "۱۴۰۵.۰۲.۱۵", "١٤٠٥/٠٢/١٥", " 1405/2/15 "]) expect(parseJalaliInput(s)).toEqual({ jy: 1405, jm: 2, jd: 15 });
    for (const s of ["", "1405", "1405/13/01", "1405/02", "abcd/ef/gh", "1405/02/15/01"]) expect(parseJalaliInput(s)).toBeNull();
    expect(formatJalali({ jy: 1405, jm: 2, jd: 5 })).toBe("1405/02/05");
    expect(formatJalali({ jy: 1405, jm: 2, jd: 5 }, { persian: true })).toBe("۱۴۰۵/۰۲/۰۵");
  });

  it("todayJalali به وقت تهران است (حدود نیمه‌شب)", () => {
    // ۲۰ مارس ۲۰۲۵ ساعت ۲۰:۳۰ UTC = ۲۴:۰۰ تهران ⇒ اول فروردین ۱۴۰۴
    expect(todayJalali(new Date("2025-03-20T20:29:00Z"))).toEqual({ jy: 1403, jm: 12, jd: 30 });
    expect(todayJalali(new Date("2025-03-20T20:31:00Z"))).toEqual({ jy: 1404, jm: 1, jd: 1 });
  });
});
