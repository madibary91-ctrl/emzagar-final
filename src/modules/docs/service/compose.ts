import { type OverlayPage, type PdfInput, renderCertificatePdf, renderOverlayPdf } from "@/modules/pdf/render";
import { PDFDocument, degrees } from "pdf-lib";
import { contractFieldValues } from "@/db/schema";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { fieldKey } from "../placement";
import { getSource, listDocFields } from "./sources";
import { pageGeom } from "./core";
import { readSourceFile } from "./ingest";

/* ───────── ساخت نسخه‌ی نهایی: فایل اصلی + امضاها + گواهی ───────── */

export interface ComposeSource {
  pdfFile: string;
  pdfSha256: string;
  originalName: string;
  originalSha256: string;
  kind: string;
}
export interface ComposeField {
  key: string;
  kind: string;
  signerPosition: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
/** فایل PDF مبنا + امضاها و مقدار فیلدها (روکش) + صفحه‌ی گواهی ← نسخه‌ی نهایی */
export async function composeOnPdf(src: ComposeSource, fields: ComposeField[], values: Map<string, string>, input: PdfInput): Promise<Buffer> {
  const base = await PDFDocument.load(await readSourceFile(src.pdfFile, src.pdfSha256), { updateMetadata: false, throwOnInvalidObject: false });
  const pages = base.getPages();
  const geoms = pages.map(pageGeom);

  const overlay: OverlayPage[] = geoms.map((g) => ({ w: g.dw, h: g.dh, items: [] }));
  for (const f of fields) {
    const pg = overlay[f.page - 1];
    if (!pg) continue;
    const box = { x: f.x * pg.w, y: f.y * pg.h, w: f.w * pg.w, h: f.h * pg.h };
    if (f.kind === "signature") {
      const sg = input.signers[f.signerPosition - 1];
      pg.items.push({ kind: "image", ...box, image: sg?.signature ?? null });
      // مهر شرکتی روی گوشه‌ی کادر امضا (همپوشان، مثل مهر واقعی)
      if (sg?.seal) {
        const sz = Math.min(Math.max(box.h * 1.25, 36), 90);
        pg.items.push({ kind: "image", x: Math.max(0, box.x + box.w - sz * 0.9), y: Math.max(0, box.y + box.h - sz * 0.85), w: sz, h: sz, image: sg.seal });
      }
    }
    else if (f.kind === "checkbox") {
      if (values.get(f.key) === "1") pg.items.push({ kind: "check", ...box });
    } else {
      const v = values.get(f.key);
      if (v) pg.items.push({ kind: "text", ...box, text: v });
    }
  }

  // پاراف: امضای کوتاه هر طرف در پایین «تک‌تک صفحات» فایل (جلوگیری از تعویض صفحه)
  const initialed = input.signers.filter((x) => x.initials);
  if (initialed.length) {
    for (const pg of overlay) {
      initialed.forEach((x, k) => {
        const iw = 38;
        const ih = 22;
        pg.items.push({ kind: "image", x: Math.max(0, pg.w - 18 - (k + 1) * (iw + 6)), y: Math.max(0, pg.h - ih - 12), w: iw, h: ih, image: x.initials });
      });
    }
  }

  const used = overlay.map((p, i) => (p.items.length ? i : -1)).filter((i) => i >= 0);
  if (used.length) {
    const ov = await PDFDocument.load(await renderOverlayPdf(overlay));
    if (ov.getPageCount() !== overlay.length) throw new Error("overlay page mismatch");
    const embedded = await base.embedPdf(ov, used);
    used.forEach((pi, k) => {
      const { cb, rot } = geoms[pi];
      // مختصات نمایشی ← فضای کاربر صفحه (وارونِ چرخش صفحه)
      const pos = rot === 90 ? { x: cb.x + cb.width, y: cb.y } : rot === 180 ? { x: cb.x + cb.width, y: cb.y + cb.height } : rot === 270 ? { x: cb.x, y: cb.y + cb.height } : { x: cb.x, y: cb.y };
      pages[pi].drawPage(embedded[k], { x: pos.x, y: pos.y, rotate: degrees(rot) });
    });
  }

  const certBytes = await renderCertificatePdf({
    ...input,
    facts: [
      { label: `فایل اصلی: ${src.originalName}`, value: `SHA-256 فایل اصلی: ${src.originalSha256}` },
      ...(src.kind === "docx" ? [{ label: "فایل Word پیش از امضا به PDF تبدیل شده است", value: `SHA-256 PDF مبنا: ${src.pdfSha256}` }] : []),
    ],
  });
  const cert = await PDFDocument.load(certBytes);
  for (const p of await base.copyPages(cert, cert.getPageIndices())) base.addPage(p);
  base.setTitle(`${input.title} — ${input.number}`);
  base.setProducer("Emzagar PDF Engine");
  base.setCreator("Emzagar");
  base.setKeywords([`contract:${input.number}`, `sha256:${input.docHash}`]);
  return Buffer.from(await base.save({ useObjectStreams: false }));
}
export async function composeSourcePdf(contractId: number, input: PdfInput): Promise<Buffer | null> {
  const src = await getSource(contractId);
  if (!src) return null;
  const fields = (await listDocFields(contractId)).map((f) => ({ ...f, key: fieldKey(f.id) }));
  const values = new Map((await db.select().from(contractFieldValues).where(eq(contractFieldValues.contractId, contractId))).map((r) => [r.key, r.value]));
  return composeOnPdf(src, fields, values, input);
}
