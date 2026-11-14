import { DOCX_IMAGES_MESSAGE, DocError, type IngestResult, MAX_UPLOAD_BYTES, cleanName, pageGeom, rid, safeFile } from "./core";
import { MAX_DOC_PAGES, type PageMeta } from "../placement";
import { PDFDocument, type PDFPage } from "pdf-lib";
import { docxToHtml, inspectDocx, isDocxBuffer } from "../docx";
import fs from "node:fs/promises";
import path from "node:path";
import { renderHtmlDocumentPdf } from "@/modules/pdf/render";
import { sha256Buf } from "@/modules/pdf/hash";
import { sourcesDir } from "@/lib/storage-paths";

/** فایل بارگذاری‌شده را بر اساس «محتوا» (نه پسوند) شناسایی و اعتبارسنجی می‌کند و PDF کاری می‌سازد */
export async function ingestUpload(buf: Buffer, rawName: string): Promise<IngestResult> {
  if (buf.length === 0) throw new DocError("فایل خالی است");
  if (buf.length > MAX_UPLOAD_BYTES) throw new DocError("حجم فایل بیشتر از ۱۲ مگابایت است");
  const warnings: string[] = [];
  const name = cleanName(rawName);
  let kind: "pdf" | "docx";
  let pdf: Buffer;

  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") {
    kind = "pdf";
    pdf = buf;
  } else if (isDocxBuffer(buf)) {
    kind = "docx";
    // سیاست «بدون تبدیل ناقص»: Word دارای تصویر (مهر/امضای اسکن‌شده/لوگو/شکل) رد می‌شود و PDF خواسته می‌شود
    let insp;
    try {
      insp = inspectDocx(buf);
    } catch {
      throw new DocError("فایل Word خوانده نشد؛ آن را به‌صورت PDF ذخیره و بارگذاری کنید");
    }
    if (insp.hasVisuals) throw new DocError(DOCX_IMAGES_MESSAGE, "docx_has_images");
    let conv;
    try {
      conv = docxToHtml(buf);
    } catch {
      throw new DocError("فایل Word خوانده نشد؛ آن را به‌صورت PDF ذخیره و بارگذاری کنید");
    }
    // ایمنی دوم: اگر مبدل هنگام تبدیل شیئی را کنار گذاشته باشد (چیزی که اسکن اولیه ندیده)، سند هرگز ساخته نمی‌شود
    if (conv.skippedImages > 0) throw new DocError(DOCX_IMAGES_MESSAGE, "docx_has_images");
    if (conv.textLength < 1 && !conv.html.includes("<table")) throw new DocError("متنی در فایل Word پیدا نشد");
    pdf = await renderHtmlDocumentPdf({ html: conv.html, title: name });
    warnings.push("فایل Word برای امضا به PDF تبدیل شد؛ ظاهر فایل ممکن است اندکی با Word تفاوت کند. برای حفظ دقیق ظاهر، از Word گزینه‌ی «ذخیره به‌صورت PDF» را بزنید.");
    if (insp.hasUnconvertedText) warnings.push("متن سرصفحه، پاصفحه یا پانویس فایل Word در نسخه‌ی تبدیل‌شده نیست. اگر این بخش‌ها برای سند مهم‌اند، فایل را به‌صورت PDF بارگذاری کنید.");
  } else if (buf.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1") {
    throw new DocError("فرمت قدیمی Word (‎.doc) پشتیبانی نمی‌شود؛ در Word گزینه‌ی «Save As» را بزنید و فایل را به‌صورت docx یا PDF ذخیره کنید");
  } else {
    throw new DocError("فقط فایل PDF یا Word (docx) پذیرفته می‌شود");
  }

  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    const enc = e instanceof Error && /encrypt/i.test(e.message);
    throw new DocError(enc ? "این PDF رمزگذاری شده است؛ نسخه‌ی بدون رمز را بارگذاری کنید" : "فایل PDF آسیب‌دیده یا نامعتبر است");
  }
  let pages: PDFPage[];
  try {
    pages = doc.getPages();
  } catch {
    throw new DocError("فایل PDF آسیب‌دیده یا نامعتبر است");
  }
  if (pages.length === 0) throw new DocError("فایل هیچ صفحه‌ای ندارد");
  if (pages.length > MAX_DOC_PAGES) throw new DocError(`حداکثر ${MAX_DOC_PAGES} صفحه مجاز است`);
  let pagesMeta: PageMeta[];
  try {
    pagesMeta = pages.map((p) => {
      const g = pageGeom(p);
      return { w: Math.round(g.dw * 100) / 100, h: Math.round(g.dh * 100) / 100 };
    });
  } catch {
    throw new DocError("ساختار صفحه‌های PDF معتبر نیست");
  }
  if (pagesMeta.some((p) => !(p.w >= 50 && p.h >= 50 && p.w <= 5000 && p.h <= 5000))) throw new DocError("ابعاد صفحه‌های فایل معتبر نیست");

  await fs.mkdir(sourcesDir(), { recursive: true, mode: 0o700 });
  const originalFile = `${rid()}.${kind === "pdf" ? "pdf" : "docx"}`;
  const pdfFile = kind === "pdf" ? originalFile : `${rid()}.pdf`;
  await fs.writeFile(path.join(sourcesDir(), originalFile), buf, { mode: 0o600 });
  if (kind === "docx") await fs.writeFile(path.join(sourcesDir(), pdfFile), pdf, { mode: 0o600 });
  return {
    kind,
    originalName: name,
    originalFile,
    originalSha256: sha256Buf(buf),
    pdfFile,
    pdfSha256: sha256Buf(pdf),
    size: buf.length,
    pageCount: pages.length,
    pagesMeta,
    warnings,
  };
}
export async function readSourceFile(file: string, expectedSha?: string): Promise<Buffer> {
  const b = await fs.readFile(path.join(sourcesDir(), safeFile(file)));
  if (expectedSha && sha256Buf(b) !== expectedSha) throw new DocError("یکپارچگی فایل مبدأ تأیید نشد");
  return b;
}
