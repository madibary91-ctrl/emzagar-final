import { BOLD, INK, REGULAR, clean, fontDir } from "./layout";
import { type Dir, isRtlText } from "../text";
import { type OverlayPage } from "./types";
import PDFDocument from "pdfkit";
import { Writer } from "./writer";
import { inspectPng } from "@/lib/png";
import path from "node:path";

export function newBareDoc(extra: Partial<ConstructorParameters<typeof PDFDocument>[0]> = {}) {
  const dir = fontDir();
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true, font: path.join(dir, "Vazirmatn-Regular.ttf"), ...extra });
  doc.registerFont(REGULAR, path.join(dir, "Vazirmatn-Regular.ttf"));
  doc.registerFont(BOLD, path.join(dir, "Vazirmatn-Bold.ttf"));
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  return { doc, done };
}
/** PDF شفاف هم‌اندازه‌ی صفحه‌های فایل اصلی که فقط امضاها و مقدار فیلدها روی آن رسم شده است */
export async function renderOverlayPdf(pages: OverlayPage[]): Promise<Buffer> {
  const { doc, done } = newBareDoc({ info: { Producer: "Emzagar PDF Engine", Creator: "Emzagar" } });
  const w = new Writer(doc);
  for (const pg of pages) {
    doc.addPage({ size: [pg.w, pg.h], margin: 0 });
    for (const it of pg.items) {
      if (it.kind === "image") {
        if (it.image && inspectPng(it.image).ok) {
          try {
            doc.image(it.image, it.x, it.y, { fit: [it.w, it.h], align: "center", valign: "center" });
          } catch {
            /* تصویر خراب: جای امضا خالی می‌ماند */
          }
        }
      } else if (it.kind === "check") {
        const s = Math.min(it.w, it.h);
        const cx = it.x + (it.w - s) / 2;
        const cy = it.y + (it.h - s) / 2;
        doc.save().lineWidth(Math.max(1.2, s / 9)).lineCap("round").lineJoin("round").strokeColor(INK).moveTo(cx + s * 0.18, cy + s * 0.55).lineTo(cx + s * 0.42, cy + s * 0.78).lineTo(cx + s * 0.84, cy + s * 0.22).stroke().restore();
      } else if (it.text) {
        const text = clean(it.text).replace(/\s+/g, " ").trim();
        let size = Math.max(6, Math.min(12, it.h * 0.58));
        const base: Dir = isRtlText(text) ? "R" : "L";
        while (size > 6 && w.width(text, false, size, base) > it.w - 2) size -= 0.5;
        const lh = size * 1.85;
        w.label(text, { x: it.x + 1, w: it.w - 2, y: it.y + Math.max(0, (it.h - lh) / 2), size });
      }
    }
  }
  if (pages.length === 0) doc.addPage({ size: "A4", margin: 0 });
  doc.end();
  return done;
}
