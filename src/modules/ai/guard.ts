import { asciiDigits } from "@/modules/ai/knowledge/text/normalize";

/**
 * D-06: «سپر حریم خصوصی» پیش از هر تماس با سرویس هوش مصنوعی بیرونی.
 *
 * مشکل: متن قرارداد (بازنویسی/تحلیل ریسک) و اسناد دانشی با کد ملی، موبایل، ایمیل، شبا و شماره‌کارت مشتریان «عیناً» به سرویس
 * شخص ثالث (و اغلب خارج از کشور) می‌رفت. حذف قطعی («……») مثل حافظه‌ی حقوقی برای «بازنویسی قرارداد» نادرست است چون خروجی را خراب می‌کند.
 *
 * راه‌حل: «نشانگرسازی برگشت‌پذیر». هر داده‌ی حساس با نشانگر پایدار (`[[MOBILE_1]]`) عوض می‌شود، مقدار واقعی فقط در حافظه‌ی همین
 * تماس می‌ماند (هرگز روی دیسک/دیتابیس نمی‌رود) و پس از پاسخ، نشانگرها در خروجی به مقدار اصلی برمی‌گردند؛ پس قرارداد بازنویسی‌شده
 * شماره‌ها را دقیقاً حفظ می‌کند ولی ارائه‌دهنده‌ی AI هیچ‌وقت آن‌ها را نمی‌بیند.
 *
 * تشخیص «دقیق» است نه حدسی: کد ملی با رقم کنترلی و شماره‌کارت با Luhn سنجیده می‌شود تا مبلغ ۱۰ رقمیِ قرارداد (۱٬۵۰۰٬۰۰۰٬۰۰۰) یا
 * شماره‌ی سریال به‌اشتباه پنهان نشود. نام اشخاص عمداً پنهان نمی‌شود (برای نگارش حقوقی لازم است) — این محدودیت مستند است.
 */
export interface PiiVault {
  /** نشانگر → مقدار اصلی */
  map: Map<string, string>;
  counts: Record<string, number>;
  /** تعداد کل جایگزینی‌ها */
  n: number;
  /** مقدار اصلی → نشانگر (AI-08: جست‌وجوی O(1) به‌جای پیمایش خطی همه‌ی نشانگرها برای هر تطبیق) */
  rev: Map<string, string>;
}
export const newVault = (): PiiVault => ({ map: new Map(), counts: {}, n: 0, rev: new Map() });

/** مقدارهای واقعیِ نشانگرسازی‌شده (برای زدودن از پیام‌های خطا/لاگ؛ AI-01) */
export const vaultValues = (vault: PiiVault): string[] => [...vault.map.values()];

/** کد ملی ایران: ۱۰ رقم با رقم کنترلی (مجموع وزن‌دار mod 11) */
export function isValidNationalCode(code: string): boolean {
  if (!/^\d{10}$/.test(code) || /^(\d)\1{9}$/.test(code)) return false;
  // مبلغ‌های رند (۱٬۵۰۰٬۰۰۰٬۰۰۰) با احتمال ≈۹٪ رقم کنترلی را اتفاقی درست می‌کنند؛ کد ملی واقعی تقریباً هرگز سه صفر پایانی ندارد
  if (/000$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(code[i]) * (10 - i);
  const r = sum % 11;
  return Number(code[9]) === (r < 2 ? r : 11 - r);
}
/** الگوریتم Luhn (کارت‌های بانکی ایران هم از آن پیروی می‌کنند) */
export function luhnOk(digits: string): boolean {
  if (!/^\d{16}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let d = Number(digits[15 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const RULES: { kind: string; re: RegExp; ok?: (m: string) => boolean }[] = [
  { kind: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "IBAN", re: /\bIR\s?\d{2}(?:[\s-]?\d{4}){5}[\s-]?\d{0,2}\b/gi },
  { kind: "CARD", re: /(?<![\d])\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\d])/g, ok: (m) => luhnOk(m.replace(/\D/g, "")) },
  { kind: "MOBILE", re: /(?<![\d])(?:\+?98|0)?9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?![\d])/g },
  { kind: "PHONE", re: /(?<![\d])0\d{2}[\s-]?\d{8}(?![\d])/g },
  { kind: "NID", re: /(?<![\d,٬.])\d{10}(?![\d,٬.])/g, ok: (m) => isValidNationalCode(m) },
];

/**
 * AI-05: اگر خودِ متن ورودی از قبل چیزی شبیه نشانگر داشته باشد (`[[MOBILE_1]]` تایپ‌شده توسط کاربر یا تزریق‌شده)،
 * نشانگر واقعیِ هم‌نام با آن یکی می‌شد و در خروجی مقدار واقعیِ یک شماره جای متن کاربر می‌نشست.
 * شمارنده‌ها از بالاتر از بزرگ‌ترین شماره‌ی موجود شروع می‌شوند؛ پس نشانگر واقعی هرگز با متن کاربر برخورد نمی‌کند.
 */
function reserveExistingMarkers(input: string, vault: PiiVault): void {
  for (const m of input.matchAll(/\[\[?\s*([A-Za-z]+)[_\s-]?(\d+)\s*\]?\]/g)) {
    const kind = m[1].toUpperCase();
    const n = Number(m[2]);
    if (Number.isFinite(n) && n < 1_000_000 && (vault.counts[kind] ?? 0) < n && !vault.map.has(`[[${kind}_${n}]]`)) vault.counts[kind] = n;
  }
}

/** جایگزینی داده‌ی حساس با نشانگر (روی نسخه‌ی با ارقام لاتین هم‌طول؛ برش روی متن اصلی تا ارقام فارسی دست‌نخورده برگردند) */
export function protectText(input: string, vault: PiiVault): string {
  if (!input) return input;
  reserveExistingMarkers(input, vault);
  let out = input;
  for (const { kind, re, ok } of RULES) {
    const probe = asciiDigits(out);
    if (probe.length !== out.length) continue; // احتیاط: نگاشت هم‌طول نیست ⇒ دست نمی‌زنیم
    let res = "";
    let last = 0;
    for (const m of probe.matchAll(re)) {
      if (ok && !ok(m[0])) continue;
      const i = m.index ?? 0;
      const original = out.slice(i, i + m[0].length);
      // یک مقدار تکراری همیشه یک نشانگر می‌گیرد (مدل بتواند «همان شماره» را دنبال کند)
      let token = vault.rev.get(original);
      if (!token) {
        vault.counts[kind] = (vault.counts[kind] ?? 0) + 1;
        token = `[[${kind}_${vault.counts[kind]}]]`;
        vault.map.set(token, original);
        vault.rev.set(original, token);
      }
      res += out.slice(last, i) + token;
      last = i + m[0].length;
      vault.n++;
    }
    out = res + out.slice(last);
  }
  return out;
}

/** بازگرداندن نشانگرها در پاسخ مدل (با تحمل فاصله/حروف کوچک/براکت تکی که مدل‌ها گاهی می‌سازند) */
export function restoreText(text: string, vault: PiiVault): string {
  return restoreTextDetailed(text, vault).text;
}

/** مثل restoreText ولی می‌گوید کدام نشانگرها برگشتند (برای تشخیص «نشانگری که مدل حذف کرد» ⇒ داده‌ی گم‌شده در قرارداد) */
export function restoreTextDetailed(text: string, vault: PiiVault): { text: string; restored: Set<string> } {
  const restored = new Set<string>();
  if (!text || vault.map.size === 0) return { text, restored };
  const out = text.replace(/\[\[?\s*([A-Za-z]+)[_\s-]?(\d+)\s*\]?\]/g, (whole, kind: string, n: string) => {
    const key = `[[${kind.toUpperCase()}_${n}]]`;
    const v = vault.map.get(key);
    if (v === undefined) return whole;
    restored.add(key);
    return v;
  });
  return { text: out, restored };
}

export const GUARD_NOTE = "\n\n[حریم خصوصی] متن ممکن است شامل نشانگرهایی مثل [[MOBILE_1]] یا [[NID_1]] باشد؛ هر نشانگر را «عیناً و بدون تغییر» در خروجی بیاور و مقدار آن را حدس نزن.";

/** AI_REDACT=0 فقط برای عیب‌یابی؛ پیش‌فرض همیشه روشن */
export const aiGuardEnabled = (): boolean => process.env.AI_REDACT !== "0";

/** AI-06: خاموش‌بودن سپر در production یک «خطای سیستمی» است، نه تنظیم بی‌صدا */
export class AiGuardDisabledError extends Error {
  constructor() {
    super("سپر حریم خصوصی هوش مصنوعی در محیط production خاموش است (AI_REDACT=0)؛ برای جلوگیری از ارسال داده‌ی مشتریان، تماس انجام نشد. متغیر را حذف کنید.");
    this.name = "AiGuardDisabledError";
  }
}

let guardWarned = false;
/**
 * پیش از هر تماسِ دارای داده‌ی کاربر فراخوانی می‌شود. در production، `AI_REDACT=0` «خطا» می‌دهد (fail-closed) مگر مدیر
 * عمداً و صریحاً `AI_REDACT_ALLOW_UNSAFE=1` بگذارد؛ آن‌گاه فقط یک هشدار پررنگ در لاگ ثبت می‌شود.
 * (پیش‌تر یک متغیر عیب‌یابیِ جامانده در سرور واقعی، بی‌صدا کد ملی/موبایل/شبای مشتریان را به سرویس بیرونی می‌فرستاد.)
 */
export function assertGuardPolicy(): void {
  if (aiGuardEnabled() || process.env.NODE_ENV !== "production") return;
  if (process.env.AI_REDACT_ALLOW_UNSAFE === "1") {
    if (!guardWarned) {
      guardWarned = true;
      console.error("[ai:guard] هشدار امنیتی: AI_REDACT=0 و AI_REDACT_ALLOW_UNSAFE=1 — داده‌ی حساس بدون نشانگرسازی به سرویس AI می‌رود");
    }
    return;
  }
  throw new AiGuardDisabledError();
}
