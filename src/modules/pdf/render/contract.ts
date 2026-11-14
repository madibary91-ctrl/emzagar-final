import { BOLD, BOTTOM, CONTENT_W, INK, MARGIN_X, MUTED, PAGE_H, REGULAR, RIGHT, TOP, clean, fontDir, htmlToBlocks } from "./layout";
import PDFDocument from "pdfkit";
import { type PdfInput, type PdfSigner } from "./types";
import QRCode from "qrcode";
import { Writer } from "./writer";
import { inspectPng } from "@/lib/png";
import { parseDocument } from "htmlparser2";
import path from "node:path";
import { toFaDigits } from "../text";

/**
 * کادر امضاکننده‌ها (مشترک بین PDF متنی و گواهی امضای فایل بارگذاری‌شده).
 * شاهد با برچسب جدا، شرکت با نام/شناسه‌ی ملی/سمت، مهر شرکتی روی گوشه‌ی امضا (همپوشان، مثل مهر واقعی) و پاراف با هش.
 */
export function drawSignerBoxes(doc: PDFKit.PDFDocument, w: Writer, signers: PdfSigner[]) {
  for (const s of signers) {
    const witness = s.role === "witness";
    const legal = !!s.companyName && !witness;
    const lines: { text: string; color: string; size: number }[] = [];
    if (legal) lines.push({ text: `${s.companyName}${s.companyNationalId ? `   |   شناسه‌ی ملی: ${toFaDigits(s.companyNationalId)}` : ""}${s.signatoryTitle ? `   |   سمت: ${s.signatoryTitle}` : ""}`, color: "#1e3a8a", size: 9 });
    lines.push({ text: `زمان ${witness ? "گواهی" : "امضا"}: ${s.signedAtText}${s.stageText ? `   |   ${s.stageText}` : ""}`, color: MUTED, size: 9 });
    lines.push({ text: `تأیید هویت: ${s.otpVerified ? "کد یکبارمصرف پیامکی" : "—"}   |   موبایل: ${s.mobileMasked || "—"}`, color: MUTED, size: 9 });
    lines.push({ text: `روش امضا: ${s.methodText}   |   IP: ${s.ip || "—"}`, color: MUTED, size: 9 });
    if (s.identityText) lines.push({ text: `هویت تأییدشده: ${s.identityText}${s.identitySeal ? `   |   مهر: ${s.identitySeal.slice(0, 16)}` : ""}`, color: "#0b6b4d", size: 9 });
    if (s.sealSha || s.initialsSha) {
      lines.push({ text: `${s.sealSha ? `مهر شرکتی ثبت شد (${s.sealSha.slice(0, 12)})` : ""}${s.sealSha && s.initialsSha ? "   |   " : ""}${s.initialsSha ? `پاراف همه‌ی صفحات ثبت شد (${s.initialsSha.slice(0, 12)})` : ""}`, color: "#0b6b4d", size: 8.5 });
    }
    const boxH = Math.max(92, 30 + lines.length * 16 + 8);
    w.ensure(boxH + 8);
    const top = w.y;
    doc.save().lineWidth(0.8).strokeColor(witness ? "#a78bfa" : legal ? "#93a8e8" : "#b7c1c4").roundedRect(MARGIN_X, top, CONTENT_W, boxH, 6).stroke().restore();
    const tx = MARGIN_X + 150;
    const tw = CONTENT_W - 150 - 10;
    w.label(`${witness ? "شاهد: " : ""}${s.label} — ${s.name}`, { x: tx, w: tw, y: top + 8, size: 11, bold: true });
    lines.forEach((l, i) => w.label(l.text, { x: tx, w: tw, y: top + 28 + i * 16, size: l.size, color: l.color }));
    // تصویر امضا پیش از رمزگشایی ساختاری سنجیده می‌شود (فایل‌های قدیمی/دست‌کاری‌شده روی دیسک هم بمب فشرده‌سازی نمی‌شوند)
    const put = (img: Buffer | null | undefined, x: number, y: number, fit: [number, number]) => {
      if (!img || !inspectPng(img).ok) return;
      try {
        doc.image(img, x, y, { fit, align: "center", valign: "center" });
      } catch {
        /* تصویر خراب: فقط جای آن خالی می‌ماند */
      }
    };
    put(s.signature, MARGIN_X + 12, top + 12, [124, 64]);
    // مهر روی گوشه‌ی امضا می‌نشیند (همپوشانی مثل مهر واقعی)؛ تصویر PNG شفاف است
    put(s.seal, MARGIN_X + 70, top + Math.max(18, boxH - 82), [76, 76]);
    w.y = top + boxH + 8;
  }
}
/* ═════════════ ساخت سند ═════════════ */

export async function renderContractPdf(input: PdfInput): Promise<Buffer> {
  const dir = fontDir();
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: TOP, bottom: BOTTOM, left: MARGIN_X, right: MARGIN_X },
    bufferPages: true,
    font: path.join(dir, "Vazirmatn-Regular.ttf"),
    info: {
      Title: clean(`${input.title} — ${input.number}`),
      Author: clean(input.siteName),
      Subject: "قرارداد امضاشده",
      Keywords: `contract:${input.number}; sha256:${input.docHash}`,
      Creator: "Emzagar",
      Producer: "Emzagar PDF Engine",
    },
  });
  doc.registerFont(REGULAR, path.join(dir, "Vazirmatn-Regular.ttf"));
  doc.registerFont(BOLD, path.join(dir, "Vazirmatn-Bold.ttf"));

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const w = new Writer(doc);

  // عنوان
  w.label(input.title, { size: 19, bold: true });
  w.y += 19 * 1.85;
  w.label(`مشتری: ${input.customerName}   |   تاریخ صدور: ${input.issuedAtText}   |   تاریخ تکمیل: ${input.completedAtText}`, { size: 9, color: MUTED });
  w.y += 22;
  doc.save().lineWidth(1).strokeColor(INK).moveTo(MARGIN_X, w.y).lineTo(RIGHT, w.y).stroke().restore();
  w.y += 14;

  // متن قرارداد
  const root = parseDocument(input.bodyHtml || "");
  w.blocks(htmlToBlocks(root.children), MARGIN_X, CONTENT_W);

  // بخش امضاها
  w.y += 8;
  w.ensure(110);
  w.label("امضاکنندگان و شناسنامه‌ی دیجیتال", { size: 13, bold: true });
  w.y += 13 * 1.85 + 4;
  drawSignerBoxes(doc, w, input.signers);

  // اثر انگشت و QR
  w.ensure(104);
  const top = w.y + 4;
  doc.save().lineWidth(0.8).strokeColor("#b7c1c4").roundedRect(MARGIN_X, top, CONTENT_W, 92, 6).stroke().restore();
  const qr = input.verifyUrl ? await QRCode.toBuffer(input.verifyUrl, { type: "png", margin: 1, width: 240, errorCorrectionLevel: "M" }) : null;
  if (qr) doc.image(qr, MARGIN_X + 10, top + 8, { fit: [76, 76] });
  const ix = MARGIN_X + 96;
  const iw = CONTENT_W - 96 - 10;
  w.label("اثر انگشت سند (SHA-256 محتوای قرارداد و امضاها)", { x: ix, w: iw, y: top + 10, size: 10, bold: true });
  w.label(input.docHash, { x: ix, w: iw, y: top + 32, size: 7.5, align: "left" });
  w.label("برای استعلام اصالت، QR را اسکن کنید یا آدرس زیر را باز کنید:", { x: ix, w: iw, y: top + 50, size: 8.5, color: MUTED });
  w.label(input.verifyUrl || "—", { x: ix, w: iw, y: top + 68, size: 7.5, align: "left", color: MUTED });
  w.y = top + 100;

  // سرصفحه و پاورقی همه‌ی صفحه‌ها (پس از دانستن تعداد صفحات)
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const m = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: m.left, right: m.right }; // رسم در حاشیه، صفحه‌ی جدید نمی‌سازد
    const hw = new Writer(doc);
    hw.label(input.siteName, { y: 30, size: 12, bold: true });
    hw.label(input.number, { y: 32, size: 9, align: "left", color: MUTED });
    doc.save().lineWidth(0.6).strokeColor("#cfd6d8").moveTo(MARGIN_X, 56).lineTo(RIGHT, 56).stroke().restore();
    doc.save().lineWidth(0.6).strokeColor("#cfd6d8").moveTo(MARGIN_X, PAGE_H - 46).lineTo(RIGHT, PAGE_H - 46).stroke().restore();
    hw.label(`صفحه ${toFaDigits(i + 1)} از ${toFaDigits(range.count)}`, { y: PAGE_H - 38, size: 8.5, color: MUTED, align: "center" });
    hw.label(`SHA-256: ${input.docHash.slice(0, 32)}…`, { y: PAGE_H - 38, size: 7, color: MUTED, align: "left" });
    hw.label("سند الکترونیکی معتبر", { y: PAGE_H - 38, size: 8.5, color: MUTED });
    // پاراف: امضای کوتاه هر طرف روی «تک‌تک صفحات»؛ جلوگیری از تعویض صفحه (همراه شماره‌ی صفحه و هش سند)
    const initialed = input.signers.filter((x) => x.initials && inspectPng(x.initials).ok);
    if (initialed.length) {
      hw.label("پاراف:", { y: PAGE_H - 21, size: 7, color: MUTED, x: RIGHT - 40, w: 40 });
      initialed.forEach((x, k) => {
        try {
          doc.image(x.initials as Buffer, RIGHT - 46 - (k + 1) * 44, PAGE_H - 22, { fit: [40, 18], align: "center", valign: "center" });
        } catch {
          /* ignore */
        }
      });
    }
    doc.page.margins = m;
  }

  doc.end();
  return done;
}
