import sanitize from "sanitize-html";
import { safeUnzipSync } from "@/lib/safe-unzip";

/**
 * هسته‌ی «حافظه‌ی حقوقی»: توابع خالص (بدون دیتابیس و شبکه) برای
 *  ۱) استخراج امن متن از فایل‌های کاربر  ۲) حذف اطلاعات هویتی/مالی  ۳) قطعه‌بندی و رتبه‌بندی BM25 فارسی
 *  ۴) «اثر انگشت سبک» (لحن، نام طرفین، قالب مواد، پوشش بندها) که رایگان و بدون هوش مصنوعی محاسبه می‌شود.
 */

export const MAX_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_DOC_CHARS = 120_000;
export const MIN_DOC_CHARS = 80;
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
  // M-02: سقف روی بایت‌های واقعی اینفلیت‌شده
  const files = safeUnzipSync(new Uint8Array(buf), { filter: (f) => f.name === "word/document.xml", maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 });
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
