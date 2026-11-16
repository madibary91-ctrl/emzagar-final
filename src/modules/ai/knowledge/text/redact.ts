import { asciiDigits } from "./normalize";

/* ───────────── حذف اطلاعات هویتی و مالی ───────────── */

export type Redaction = { text: string; count: number; kinds: Record<string, number> };
const PII: { kind: string; re: RegExp }[] = [
  { kind: "شبا", re: /\bIR\s?\d{2}(?:[\s-]?\d{4}){5}[\s-]?\d{0,2}\b/gi },
  { kind: "کارت", re: /(?<![\d])\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?![\d])/g },
  { kind: "موبایل", re: /(?<![\d])(?:\+?98|0)?9\d{2}[\s-]?\d{3}[\s-]?\d{4}(?![\d])/g },
  { kind: "ایمیل", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "تلفن", re: /(?<![\d])0\d{2}[\s-]?\d{8}(?![\d])/g },
  { kind: "کد ملی", re: /(?<![\d,٬.])\d{10}(?![\d,٬.])/g },
];
/** اطلاعات حساس (کد ملی، موبایل، ایمیل، کارت، شبا، تلفن) → «……» پیش از ذخیره و پیش از ارسال به هر سرویس بیرونی */
export function redactPii(input: string): Redaction {
  let out = input;
  let count = 0;
  const kinds: Record<string, number> = {};
  for (const { kind, re } of PII) {
    // تطبیق روی نسخه‌ی با ارقام لاتین (هم‌طول)، جایگزینی روی همان بازه‌ها
    const probe = asciiDigits(out);
    let result = "";
    let last = 0;
    for (const m of probe.matchAll(re)) {
      const i = m.index ?? 0;
      result += out.slice(last, i) + "……";
      last = i + m[0].length;
      count++;
      kinds[kind] = (kinds[kind] || 0) + 1;
    }
    out = result + out.slice(last);
  }
  return { text: out, count, kinds };
}
