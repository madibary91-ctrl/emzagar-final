import { BOTTOM, CONTENT_W, INK, MARGIN_X, MUTED, PAGE_H, RIGHT, TOP, clean, htmlToBlocks } from "./layout";
import { type CertificateInput } from "./types";
import QRCode from "qrcode";
import { Writer } from "./writer";
import { drawSignerBoxes } from "./contract";
import { newBareDoc } from "./overlay";
import { parseDocument } from "htmlparser2";
import { toFaDigits } from "../text";

/** صفحه‌ی «گواهی امضا» که به انتهای فایل اصلی پیوست می‌شود */
export async function renderCertificatePdf(input: CertificateInput): Promise<Buffer> {
  const { doc, done } = newBareDoc({
    info: { Title: clean(`گواهی امضا — ${input.number}`), Author: clean(input.siteName), Keywords: `contract:${input.number}; sha256:${input.docHash}`, Creator: "Emzagar", Producer: "Emzagar PDF Engine" },
  });
  doc.addPage({ size: "A4", margins: { top: TOP, bottom: BOTTOM, left: MARGIN_X, right: MARGIN_X } });
  const w = new Writer(doc);
  w.label("گواهی امضای دیجیتال", { size: 19, bold: true });
  w.y += 19 * 1.85;
  w.label(`${input.title}   |   شماره: ${input.number}`, { size: 10, color: MUTED });
  w.y += 22;
  w.label(`تاریخ صدور: ${input.issuedAtText}   |   تاریخ تکمیل: ${input.completedAtText}`, { size: 9, color: MUTED });
  w.y += 18;
  doc.save().lineWidth(1).strokeColor(INK).moveTo(MARGIN_X, w.y).lineTo(RIGHT, w.y).stroke().restore();
  w.y += 14;
  for (const f of input.facts ?? []) {
    w.ensure(30);
    w.label(f.label, { size: 9, bold: true });
    w.y += 9 * 1.85;
    w.label(f.value, { size: 8, color: MUTED, align: "left" });
    w.y += 8 * 1.85 + 4;
  }
  w.y += 6;
  w.label("امضاکنندگان و شناسنامه‌ی دیجیتال", { size: 13, bold: true });
  w.y += 13 * 1.85 + 4;
  drawSignerBoxes(doc, w, input.signers);
  w.ensure(104);
  const top = w.y + 4;
  doc.save().lineWidth(0.8).strokeColor("#b7c1c4").roundedRect(MARGIN_X, top, CONTENT_W, 92, 6).stroke().restore();
  const qr = input.verifyUrl ? await QRCode.toBuffer(input.verifyUrl, { type: "png", margin: 1, width: 240, errorCorrectionLevel: "M" }) : null;
  if (qr) doc.image(qr, MARGIN_X + 10, top + 8, { fit: [76, 76] });
  const ix = MARGIN_X + 96;
  const iw = CONTENT_W - 96 - 10;
  w.label("اثر انگشت سند (SHA-256 فایل، فیلدها و امضاها)", { x: ix, w: iw, y: top + 10, size: 10, bold: true });
  w.label(input.docHash, { x: ix, w: iw, y: top + 32, size: 7.5, align: "left" });
  w.label("برای استعلام اصالت، QR را اسکن کنید یا آدرس زیر را باز کنید:", { x: ix, w: iw, y: top + 50, size: 8.5, color: MUTED });
  w.label(input.verifyUrl || "—", { x: ix, w: iw, y: top + 68, size: 7.5, align: "left", color: MUTED });
  doc.end();
  return done;
}
/** PDF ساده از HTML (برای تبدیل Word → PDF) بدون سرصفحه‌ی قرارداد و گواهی */
export async function renderHtmlDocumentPdf(input: { html: string; title: string }): Promise<Buffer> {
  const { doc, done } = newBareDoc({ info: { Title: clean(input.title), Creator: "Emzagar", Producer: "Emzagar PDF Engine" } });
  doc.addPage({ size: "A4", margins: { top: 64, bottom: BOTTOM, left: MARGIN_X, right: MARGIN_X } });
  const w = new Writer(doc);
  w.y = 64;
  w.blocks(htmlToBlocks(parseDocument(input.html || "").children), MARGIN_X, CONTENT_W);
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const m = doc.page.margins;
    doc.page.margins = { top: 0, bottom: 0, left: m.left, right: m.right };
    const hw = new Writer(doc);
    hw.label(`${toFaDigits(i + 1)} / ${toFaDigits(range.count)}`, { y: PAGE_H - 38, size: 8.5, color: MUTED, align: "center" });
    doc.page.margins = m;
  }
  doc.end();
  return done;
}
