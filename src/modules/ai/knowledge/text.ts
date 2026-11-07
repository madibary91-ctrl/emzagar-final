import { unzipSync } from "fflate";
import sanitize from "sanitize-html";

/**
 * هسته‌ی «حافظه‌ی حقوقی»: توابع خالص (بدون دیتابیس و شبکه) برای
 *  ۱) استخراج امن متن از فایل‌های کاربر  ۲) حذف اطلاعات هویتی/مالی  ۳) قطعه‌بندی و رتبه‌بندی BM25 فارسی
 *  ۴) «اثر انگشت سبک» (لحن، نام طرفین، قالب مواد، پوشش بندها) که رایگان و بدون هوش مصنوعی محاسبه می‌شود.
 */

export const MAX_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_DOC_CHARS = 120_000;
export const MIN_DOC_CHARS = 80;

/* ───────────── نرمال‌سازی فارسی ───────────── */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** ارقام فارسی/عربی → لاتین (یک‌به‌یک؛ طول رشته تغییر نمی‌کند) */
export function asciiDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (d) => {
    const i = FA_DIGITS.indexOf(d);
    return String(i >= 0 ? i : AR_DIGITS.indexOf(d));
  });
}

/** یکسان‌سازی ي/ك عربی، حذف اعراب و کشیده */
export function normalizeFa(s: string): string {
  return s
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ۀ/g, "ه")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "");
}

/** پاک‌سازی متن خام: نویسه‌های کنترلی/جهت، فاصله‌های اضافه (ساختار پاراگراف حفظ می‌شود) */
export function cleanText(raw: string): string {
  return normalizeFa(raw)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ───────────── استخراج متن از فایل ───────────── */

export type ExtractResult = { ok: true; text: string; format: string } | { ok: false; error: string };

const BLOCK_CLOSE = /<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article)>|<br\s*\/?>/gi;

/** HTML → متن ساده (هیچ تگ/اسکریپتی باقی نمی‌ماند) */
export function htmlToText(html: string): string {
  const withBreaks = html.replace(BLOCK_CLOSE, (m) => `${m}\n`).replace(/<\/t[dh]>/gi, "$& ");
  const stripped = sanitize(withBreaks, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: "discard" });
  return stripped
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, "&");
}

/** متن DOCX از word/document.xml (با سقف حجم بازشده؛ ضد Zip-bomb) */
export function docxToText(buf: Buffer): string {
  const files = unzipSync(new Uint8Array(buf), {
    filter: (f) => f.name === "word/document.xml" && f.originalSize <= 20 * 1024 * 1024,
  });
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("ساختار DOCX نامعتبر است");
  const doc = Buffer.from(xml).toString("utf8");
  const out: string[] = [];
  for (const p of doc.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    let line = "";
    for (const t of p[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
      line += t[1] !== undefined ? decodeXml(t[1]) : t[0].startsWith("<w:tab") ? "\t" : "\n";
    }
    out.push(line);
  }
  return out.join("\n");
}

function decodeTextFile(buf: Buffer): string {
  if (buf.includes(0)) throw new Error("فایل متنی نیست");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // فایل‌های قدیمی فارسی (ویندوز-۱۲۵۶)
    return new TextDecoder("windows-1256").decode(buf);
  }
}

/** استخراج متن از TXT / MD / HTML / DOCX بر اساس «محتوای واقعی» (نه فقط پسوند) */
export function extractText(buf: Buffer, fileName: string): ExtractResult {
  if (buf.length === 0) return { ok: false, error: "فایل خالی است" };
  if (buf.length > MAX_FILE_BYTES) return { ok: false, error: `حجم فایل بیش از ${MAX_FILE_BYTES / 1024 / 1024} مگابایت است` };
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
  try {
    if (isPdf || ext === "pdf") return { ok: false, error: "PDF پشتیبانی نمی‌شود (استخراج متن فارسی از PDF قابل‌اعتماد نیست). فایل را به DOCX تبدیل کنید یا متن را در بخش «چسباندن متن» بگذارید." };
    if (isZip) {
      if (ext !== "docx") return { ok: false, error: "فقط فایل DOCX (و نه ZIP یا قالب‌های دیگر) پشتیبانی می‌شود" };
      return { ok: true, text: docxToText(buf), format: "docx" };
    }
    if (ext === "doc" || ext === "rtf" || ext === "odt") return { ok: false, error: "این قالب پشتیبانی نمی‌شود؛ آن را به DOCX یا TXT ذخیره کنید" };
    if (!["txt", "md", "markdown", "html", "htm", "text", ""].includes(ext)) return { ok: false, error: "قالب فایل پشتیبانی نمی‌شود (TXT، MD، HTML، DOCX)" };
    const raw = decodeTextFile(buf);
    if (ext === "html" || ext === "htm" || /^\s*<(!doctype|html|body|p|div|h\d)\b/i.test(raw)) return { ok: true, text: htmlToText(raw), format: "html" };
    return { ok: true, text: raw, format: ext === "md" || ext === "markdown" ? "md" : "txt" };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message.length < 80 ? e.message : "خواندن فایل ممکن نشد؛ فایل خراب است" };
  }
}

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

/* ───────────── قطعه‌بندی ───────────── */

export type Chunk = { docId: number; docTitle: string; kind: string; index: number; text: string };

const TARGET = 900;
const HARD_MAX = 1500;

/** قطعه‌بندی بر اساس «ماده/بند» و پاراگراف؛ هر قطعه ≈ ۹۰۰ نویسه (هرگز وسط کلمه بریده نمی‌شود) */
export function chunkText(text: string): string[] {
  const blocks = text
    .split(/\n{2,}|\n(?=\s*(?:ماده|بند|فصل|تبصره)\s*[\d۰-۹]*)/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const b of blocks) {
    if (b.length > HARD_MAX) {
      flush();
      for (let i = 0; i < b.length; ) {
        let end = Math.min(b.length, i + TARGET);
        if (end < b.length) {
          const sp = b.lastIndexOf(" ", end);
          if (sp > i + TARGET / 2) end = sp;
        }
        out.push(b.slice(i, end).trim());
        i = end;
      }
      continue;
    }
    if (cur && cur.length + b.length > TARGET) flush();
    cur += (cur ? "\n" : "") + b;
  }
  flush();
  return out.filter((c) => c.length >= 20);
}

/* ───────────── توکن‌سازی و BM25 ───────────── */

const STOP = new Set(
  "ها های و در به از که این آن را با برای است شد شود می بر یا تا هر همه یک دو سه کرد کند باید بود بوده نیز اما اگر هم پس خود ما شما او آنها آنان ایشان طرف طرفین بین مورد موضوع بند ماده قرارداد مطابق طبق مذکور فوق ذیل چنانچه صورت مدت".split(" "),
);

/** ریشه‌یابی سبک: حذف «ها/های/ان/ات» پایانی (برای تطابق «پرداخت‌ها» با «پرداخت») */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("های")) return t.slice(0, -3);
  if (t.length > 4 && (t.endsWith("ها") || t.endsWith("ان") || t.endsWith("ات"))) return t.slice(0, -2);
  return t;
}

export function tokenize(s: string): string[] {
  return asciiDigits(normalizeFa(s))
    .toLowerCase()
    // «پرداخت‌ها» → «پرداخت» (پسوند جمع بعد از نیم‌فاصله)، سپس نیم‌فاصله‌های باقی‌مانده فاصله می‌شوند
    .replace(/\u200c(?:ها|های|ان|ات)(?![\p{L}])/gu, "")
    .replace(/[\u200c_]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .map(stem)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

export type Scored = { chunk: Chunk; score: number };

/** BM25 استاندارد (k1=1.4, b=0.75) روی قطعه‌ها؛ بدون هیچ سرویس بیرونی یا embedding */
export function rankChunks(chunks: Chunk[], query: string, k1 = 1.4, b = 0.75): Scored[] {
  const q = [...new Set(tokenize(query))];
  if (chunks.length === 0) return [];
  const docs = chunks.map((c) => tokenize(c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  return chunks
    .map((chunk, i) => {
      const d = docs[i];
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.length) / avg));
      }
      return { chunk, score };
    })
    .sort((a, b2) => b2.score - a.score || a.chunk.index - b2.chunk.index);
}

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
