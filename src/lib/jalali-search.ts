/**
 * جستجوی تاریخ شمسی در سطح دیتابیس (P-01).
 *
 * داشبورد مشتری قبلاً «همه‌ی» قراردادها را به Node می‌آورد و متن تاریخ شمسی («۱۴ مرداد ۱۴۰۴») را در جاوااسکریپت
 * می‌ساخت تا واژه‌ی جستجو را در آن پیدا کند. برای اینکه فیلتر به SQL منتقل شود، واژه‌ی تاریخی را به «بازه‌های میلادی»
 * ترجمه می‌کنیم؛ دیتابیس فقط ردیف‌های داخل بازه را برمی‌گرداند.
 *
 * پشتیبانی‌شده (واژه با foldSearch «تا» می‌شود؛ ارقام لاتین):
 *  - سال: `1404`
 *  - ماه (نام کامل یا بخشی از آن، حداقل ۲ نویسه): `مرداد`
 *  - روزِ ماه (۱ یا ۲ رقم): `14`
 *  - تاریخ کامل یا ناقص با جداکننده: `1404/05`، `1404-05-14`
 * فایل خالص است (بدون دیتابیس) و آزمون‌پذیر.
 */
import { JALALI_MONTHS, jalaliMonthLength, toGregorian, toJalali } from "./jalali";
import { foldSearch } from "./search-text";

/** وقت تهران = UTC+03:30 (همان قراردادِ بازه‌ی تاریخ در queryContracts؛ ستون‌ها UTC ذخیره می‌شوند) */
const TEHRAN_OFFSET_MS = 3.5 * 3_600_000;
/** سقف تعداد بازه‌ی تولیدی برای یک واژه (جلوگیری از پرس‌وجوی عظیم) */
const MAX_RANGES = 160;
/** چند سال گذشته/آینده برای واژه‌های بدون سال (ماه/روز) بررسی می‌شود */
const YEARS_BACK = 8;
const YEARS_AHEAD = 2;

export interface DateRange {
  /** شروع (شامل) — UTC */
  from: Date;
  /** پایان (غیرشامل) — UTC */
  to: Date;
}

const MONTHS_FOLDED = JALALI_MONTHS.map((m) => foldSearch(m));

function dayStartUtc(jy: number, jm: number, jd: number): Date {
  const g = toGregorian(jy, jm, jd);
  return new Date(Date.UTC(g.gy, g.gm - 1, g.gd) - TEHRAN_OFFSET_MS);
}

/** بازه‌ی روزهای [jd1..jd2] از یک ماه شمسی */
function monthSpan(jy: number, jm: number, jd1: number, jd2: number): DateRange | null {
  const len = jalaliMonthLength(jy, jm);
  if (jd1 < 1 || jd1 > len) return null;
  const last = Math.min(jd2, len);
  const from = dayStartUtc(jy, jm, jd1);
  const to = new Date(dayStartUtc(jy, jm, last).getTime() + 86_400_000);
  return { from, to };
}

export function currentJalaliYear(now: Date = new Date()): number {
  const t = new Date(now.getTime() + TEHRAN_OFFSET_MS);
  return toJalali(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()).jy;
}

/**
 * واژه‌ی جستجو → بازه‌های تاریخ (UTC). `null` = واژه «تاریخی» نیست (فقط جستجوی متنی).
 */
export function jalaliTokenRanges(rawToken: string, now: Date = new Date()): DateRange[] | null {
  const token = foldSearch(rawToken);
  if (!token) return null;
  const cy = currentJalaliYear(now);
  const years: number[] = [];
  for (let y = cy - YEARS_BACK; y <= cy + YEARS_AHEAD; y++) years.push(y);
  const out: DateRange[] = [];
  const push = (r: DateRange | null) => {
    if (r && out.length < MAX_RANGES) out.push(r);
  };

  // تاریخ با جداکننده: سال/ماه یا سال/ماه/روز
  const full = /^(1[3-5]\d\d)[/\-.](\d{1,2})(?:[/\-.](\d{1,2}))?$/.exec(token);
  if (full) {
    const [jy, jm] = [Number(full[1]), Number(full[2])];
    if (jm < 1 || jm > 12) return null;
    const jd = full[3] ? Number(full[3]) : null;
    push(jd ? monthSpan(jy, jm, jd, jd) : monthSpan(jy, jm, 1, 31));
    return out.length ? out : null;
  }
  // فقط سال
  if (/^1[3-5]\d\d$/.test(token)) {
    const jy = Number(token);
    push({ from: dayStartUtc(jy, 1, 1), to: dayStartUtc(jy + 1, 1, 1) });
    return out;
  }
  // روزِ ماه (۱ یا ۲ رقم)
  if (/^\d{1,2}$/.test(token)) {
    const jd = Number(token);
    if (jd < 1 || jd > 31) return null;
    for (const jy of years) for (let jm = 1; jm <= 12; jm++) push(monthSpan(jy, jm, jd, jd));
    return out.length ? out : null;
  }
  // نام ماه (کامل یا بخشی از آن)
  if (token.length >= 2) {
    MONTHS_FOLDED.forEach((name, i) => {
      if (name.includes(token)) for (const jy of years) push(monthSpan(jy, i + 1, 1, 31));
    });
    return out.length ? out : null;
  }
  return null;
}
