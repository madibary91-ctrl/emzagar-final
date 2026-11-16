const dateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "Asia/Tehran",
});
const dateTimeFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Tehran",
});

export function fa(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return dateFmt.format(new Date(date));
}

export function faTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return dateTimeFmt.format(new Date(date));
}

export function faNum(n: number): string {
  return new Intl.NumberFormat("fa-IR").format(n);
}

// نقاط شکست چرخه‌ی ۳۳ساله‌ی تقویم رسمی (همان جدول jalaali-js؛ معتبر برای سال‌های ۱۷۸ تا ۲۹۷۸ شمسی)
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
const div = (a: number, b: number) => Math.trunc(a / b);
const mod = (a: number, b: number) => a - Math.floor(a / b) * b;

/**
 * سال کبیسه‌ی شمسی طبق تقویم رسمی (چرخه‌ی ۳۳ساله). مثال: ۱۳۹۹، ۱۴۰۳ و ۱۴۰۸ کبیسه‌اند؛ ۱۴۰۴ و ۱۴۰۵ نه.
 * خارج از بازه‌ی پشتیبانی‌شده «غیرکبیسه» حساب می‌شود (محافظه‌کارانه).
 */
export function isJalaliLeap(year: number): boolean {
  const jy = Math.trunc(year);
  if (!Number.isFinite(jy) || jy < BREAKS[0] || jy >= BREAKS[BREAKS.length - 1]) return false;
  let jp = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i++) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    jp = jm;
  }
  let n = jy - jp;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return leap === 0;
}

/** تعداد روزهای ماه شمسی (اسفند در سال کبیسه ۳۰ روز و در غیر آن ۲۹ روز است) */
export function jalaliMonthLength(year: number, month: number): number {
  if (month >= 1 && month <= 6) return 31;
  if (month >= 7 && month <= 11) return 30;
  if (month === 12) return isJalaliLeap(year) ? 30 : 29;
  return 0;
}

/* ═════════════════════════════════════════════════════════════════════════════
 * تبدیل میلادی ⇄ شمسی (الگوریتم جدول jalaali-js؛ بدون وابستگی، سازگار با کلاینت و سرور)
 * پایه‌ی «تقویم شمسی» فرم‌ها (components/JalaliDatePicker.tsx): در دیتابیس و API همچنان تاریخ میلادی ISO
 * (YYYY-MM-DD) ذخیره می‌شود و فقط نمایش/ورود برای کاربر شمسی است.
 * ═══════════════════════════════════════════════════════════════════════════ */

export type JalaliDate = { jy: number; jm: number; jd: number };

export const JALALI_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"] as const;
/** هفته از شنبه شروع می‌شود */
export const JALALI_WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"] as const;
export const JALALI_WEEKDAYS_SHORT = ["ش", "ی", "د", "س", "چ", "پ", "ج"] as const;

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** ارقام فارسی/عربی → لاتین */
export function digitsToEn(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}
/** ارقام لاتین → فارسی */
export function digitsToFa(s: string): string {
  return s.replace(/\d/g, (d) => FA_DIGITS[Number(d)]);
}

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  if (jy < jp || jy >= BREAKS[bl - 1]) throw new RangeError("سال شمسی خارج از بازه‌ی پشتیبانی‌شده");
  for (let i = 1; i < bl; i++) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j += div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

function d2j(jdn: number): JalaliDate {
  const g = d2g(jdn);
  let jy = g.gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(g.gy, 3, r.march);
  let k = jdn - jdn1f;
  if (k >= 0) {
    if (k <= 185) return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

/** میلادی → شمسی (ماه ۱ تا ۱۲) */
export function toJalali(gy: number, gm: number, gd: number): JalaliDate {
  return d2j(g2d(gy, gm, gd));
}

/** شمسی → میلادی (ماه ۱ تا ۱۲) */
export function toGregorian(jy: number, jm: number, jd: number): { gy: number; gm: number; gd: number } {
  return d2g(j2d(jy, jm, jd));
}

export function isValidJalali(jy: number, jm: number, jd: number): boolean {
  if (![jy, jm, jd].every(Number.isInteger)) return false;
  if (jy < 1 || jy > 3000 || jm < 1 || jm > 12 || jd < 1) return false;
  return jd <= jalaliMonthLength(jy, jm);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** «2026-05-12» → شمسی؛ نامعتبر ⇒ null */
export function isoToJalali(iso: string | null | undefined): JalaliDate | null {
  const m = ISO_RE.exec((iso ?? "").trim());
  if (!m) return null;
  const [gy, gm, gd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (gm < 1 || gm > 12 || gd < 1 || gd > new Date(Date.UTC(gy, gm, 0)).getUTCDate()) return null;
  try {
    return toJalali(gy, gm, gd);
  } catch {
    return null;
  }
}

/** شمسی → «YYYY-MM-DD» میلادی؛ نامعتبر ⇒ null */
export function jalaliToIso(jy: number, jm: number, jd: number): string | null {
  if (!isValidJalali(jy, jm, jd)) return null;
  try {
    const g = toGregorian(jy, jm, jd);
    return `${String(g.gy).padStart(4, "0")}-${String(g.gm).padStart(2, "0")}-${String(g.gd).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

export function formatJalali(j: JalaliDate, opts: { persian?: boolean } = {}): string {
  const s = `${j.jy}/${String(j.jm).padStart(2, "0")}/${String(j.jd).padStart(2, "0")}`;
  return opts.persian ? digitsToFa(s) : s;
}

/** متن تایپ‌شده («۱۴۰۵/۲/۱۵»، «1405-02-15»، «۱۴۰۵.۰۲.۱۵») → تاریخ شمسی معتبر یا null */
export function parseJalaliInput(text: string | null | undefined): JalaliDate | null {
  const v = digitsToEn(String(text ?? ""))
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .trim()
    .replace(/[-.\s،,٫]/g, "/");
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
  if (!m) return null;
  const [jy, jm, jd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidJalali(jy, jm, jd) ? { jy, jm, jd } : null;
}

/** امروز به وقت تهران (شمسی) */
export function todayJalali(now: Date = new Date()): JalaliDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return toJalali(get("year"), get("month"), get("day"));
}

/** امروز به‌صورت ISO میلادی به وقت تهران */
export function todayIso(now: Date = new Date()): string {
  const j = todayJalali(now);
  return jalaliToIso(j.jy, j.jm, j.jd) as string;
}

/** روز هفته: ۰ = شنبه … ۶ = جمعه */
export function jalaliWeekday(jy: number, jm: number, jd: number): number {
  return mod(j2d(jy, jm, jd) + 2, 7);
}

/** «اسفند ۱۴۰۴» */
export function jalaliMonthTitle(jy: number, jm: number): string {
  return `${JALALI_MONTHS[jm - 1]} ${digitsToFa(String(jy))}`;
}

/**
 * تاریخ تقویمی (ISO میلادی YYYY-MM-DD) یک لحظه «به وقت تهران».
 * `date.toISOString().slice(0, 10)` تاریخ UTC می‌دهد و برای لحظه‌های بین ۰۰:۰۰ تا ۰۳:۳۰ تهران یک روز عقب است؛
 * ذخیره‌ی دوباره‌ی همان فرم، تاریخ پایان را بی‌صدا یک روز جابه‌جا می‌کرد.
 */
export function isoDateTehran(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** پایان روز (۲۳:۵۹:۵۹) تاریخ ISO به وقت تهران؛ ورودی نامعتبر ⇒ null. «آخرین مهلت: X» یعنی تا پایان روز X (نه شروع آن). */
export function endOfDayTehran(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:59+03:30`);
  if (Number.isNaN(d.getTime()) || isoDateTehran(d) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  return d;
}
