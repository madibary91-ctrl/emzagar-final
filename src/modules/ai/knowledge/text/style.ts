import { STOP } from "./chunk";
import { asciiDigits, normalizeFa } from "./normalize";

/* ───────────── اثر انگشت سبک (رایگان، بدون AI) ───────────── */

export type StyleFingerprint = {
  docs: number;
  chars: number;
  formality: "رسمی" | "نیمه‌رسمی" | "محاوره‌ای" | "نامشخص";
  formalScore: number;
  parties: string[];
  articleStyle: string | null;
  usesPersianDigits: boolean;
  avgSentenceWords: number;
  clauses: { key: string; label: string; present: boolean }[];
  phrases: string[];
};
const PARTY_TERMS = ["کارفرما", "پیمانکار", "فروشنده", "خریدار", "موجر", "مستاجر", "مشاور", "مشتری", "ارائه‌دهنده", "سفارش‌دهنده", "کارگر", "کارمند", "همکار", "طرف اول", "طرف دوم", "مالک", "بهره‌بردار", "وام‌گیرنده", "وام‌دهنده"];
const FORMAL_MARKERS = ["می‌باشد", "می‌گردد", "مقتضی", "متعهد", "ایفاد", "مشارالیه", "مذکور", "مفاد", "ملزم", "لازم‌الاجرا", "اعم از", "مراتب", "علی‌الحساب", "بدین‌وسیله", "بدینوسیله", "ذیل", "منعقد", "فیمابین", "فی‌مابین"];
const INFORMAL_MARKERS = ["هست ", "میشه", "نمیشه", "میکنه", "بکنه", "ولی ", "خیلی", "یه ", "اینجوری", "کنیم", "بدیم", "بزنیم"];
const CLAUSES: [string, string, RegExp][] = [
  ["termination", "فسخ", /فسخ|خاتمه/],
  ["confidential", "محرمانگی", /محرمانه|محرمانگی|اسرار/],
  ["force", "فورس‌ماژور", /فورس|قوه قاهره|حوادث غیرمترقبه|غیرقابل پیش/],
  ["dispute", "حل اختلاف", /داوری|حل اختلاف|مرجع صالح|دادگاه/],
  ["penalty", "جریمه و خسارت", /جریمه|خسارت|وجه التزام|وجه‌التزام|دیرکرد/],
  ["ip", "مالکیت فکری", /مالکیت فکری|حق نشر|مالکیت معنوی|کپی.?رایت/],
  ["warranty", "ضمانت", /ضمانت|گارانتی|تضمین/],
];
const words = (s: string) => s.split(/[^\p{L}\p{N}\u200c]+/u).filter(Boolean);
/** نشانه‌های سبک از مجموع اسناد (قطعی و تکرارپذیر؛ هیچ تماس بیرونی ندارد) */
export function styleFingerprint(texts: string[]): StyleFingerprint {
  const all = texts.join("\n\n");
  const norm = normalizeFa(all);
  const w = words(norm);
  const count = (list: string[]) => list.reduce((a, m) => a + (norm.split(m).length - 1), 0);
  const per1k = (n: number) => (w.length ? (n / w.length) * 1000 : 0);
  const informalPer1k = per1k(count(INFORMAL_MARKERS));
  const formalScore = Math.max(0, Math.min(100, Math.round(per1k(count(FORMAL_MARKERS)) * 6 - informalPer1k * 8 + 25)));
  const formality: StyleFingerprint["formality"] = w.length < 60 ? "نامشخص" : informalPer1k > 6 ? "محاوره‌ای" : formalScore >= 55 ? "رسمی" : "نیمه‌رسمی";

  const parties = PARTY_TERMS.map((t) => ({ t, n: norm.split(t).length - 1 }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((x) => x.t);

  const headings = new Map<string, number>();
  for (const m of norm.matchAll(/^[ \t]*(ماده|بند|فصل)[ \t]*([\d۰-۹]+)[ \t]*([-—–:.)])?/gm)) {
    const digits = /[۰-۹]/.test(m[2]) ? "۱" : "1";
    const key = `«${m[1]} ${digits}${m[3] ? ` ${m[3]}` : ""}»`;
    headings.set(key, (headings.get(key) || 0) + 1);
  }
  const top = [...headings.entries()].sort((a, b) => b[1] - a[1])[0];

  const persian = (all.match(/[۰-۹]/g) || []).length;
  const latin = (all.match(/[0-9]/g) || []).length;
  const sentences = norm.split(/[.!؟?؛\n]+/).filter((s) => words(s).length >= 3);
  const avgSentenceWords = sentences.length ? Math.round(sentences.reduce((a, s) => a + words(s).length, 0) / sentences.length) : 0;

  return {
    docs: texts.length,
    chars: all.length,
    formality,
    formalScore,
    parties,
    articleStyle: top ? top[0] : null,
    usesPersianDigits: persian >= latin,
    avgSentenceWords,
    clauses: CLAUSES.map(([key, label, re]) => ({ key, label, present: re.test(norm) })),
    phrases: topPhrases(w),
  };
}
/** عبارت‌های سه‌کلمه‌ای تکرارشونده (امضای نگارشی شرکت) */
function topPhrases(w: string[]): string[] {
  const m = new Map<string, number>();
  for (let i = 0; i + 2 < w.length; i++) {
    const g = [w[i], w[i + 1], w[i + 2]];
    if (g.some((x) => x.length < 2) || STOP.has(g[0]) || STOP.has(g[2]) || g.some((x) => /^\d+$/.test(asciiDigits(x)))) continue;
    const k = g.join(" ");
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);
}
/** خلاصه‌ی فشرده‌ی اثر انگشت برای درج در پرامپت */
export function fingerprintForPrompt(f: StyleFingerprint): string {
  const lines: string[] = [];
  if (f.formality !== "نامشخص") lines.push(`لحن غالب: ${f.formality}`);
  if (f.parties.length) lines.push(`نام‌گذاری طرفین در اسناد: ${f.parties.join("، ")}`);
  if (f.articleStyle) lines.push(`قالب سرفصل مواد: ${f.articleStyle}`);
  lines.push(`ارقام: ${f.usesPersianDigits ? "فارسی (۱۲۳)" : "لاتین (123)"}`);
  if (f.avgSentenceWords) lines.push(`میانگین طول جمله: حدود ${f.avgSentenceWords} کلمه`);
  const present = f.clauses.filter((c) => c.present).map((c) => c.label);
  if (present.length) lines.push(`بندهای رایج در قراردادهای این کسب‌وکار: ${present.join("، ")}`);
  if (f.phrases.length) lines.push(`عبارت‌های تکراری نگارش: ${f.phrases.map((p) => `«${p}»`).join("، ")}`);
  return lines.join("\n");
}
/** پیش‌گیری از Prompt Injection: جداکننده‌ها و ساختارهای شبیه دستور از متن سند حذف می‌شوند */
export function neutralizeForPrompt(s: string): string {
  return s
    .replace(/<\/?\s*(?:system|assistant|user|instructions?)[^>]*>/gi, " ")
    .replace(/\[\/?(?:SYSTEM|INST|ASSISTANT|USER)\]/gi, " ")
    .replace(/[<>]{2,}|={3,}|-{3,}|#{3,}|`{3,}/g, " ");
}
