import { type Campaign, CollectError, type Submission, publicBase } from "./core";
import { type CollectField, displayValue, parseCollectFields } from "../schema";
import { type PdfInput, renderContractPdf } from "@/modules/pdf/render";
import { and, eq, isNull } from "drizzle-orm";
import { collectCampaigns, collectSubmissions } from "@/db/schema";
import { composeOnPdf, readSourceFile } from "@/modules/docs/service";
import { db } from "@/db";
import { docFieldsOf } from "./campaigns";
import { escapeHtml, sanitizeHtml } from "@/lib/html";
import { fa, faTime } from "@/lib/jalali";
import { getAllSettings } from "@/modules/settings/service";
import { readSignatureFile } from "@/modules/signing/storage";
import { zipSync } from "fflate";

/* ───────── خروجی‌ها ───────── */

function valuesTable(defs: CollectField[], values: Record<string, string>): string {
  const rows = defs.filter((d) => values[d.key] !== undefined).map((d) => `<tr><td><b>${escapeHtml(d.label)}</b></td><td>${escapeHtml(displayValue(d, values[d.key]))}</td></tr>`);
  return rows.length ? `<h3>اطلاعات تکمیل‌شده</h3><table>${rows.join("")}</table>` : "";
}
/** PDF اختصاصی هر امضا: متن یا فایل اصلی + اطلاعات فرد + امضا + گواهی و QR استعلام */
export async function buildSubmissionPdf(s: Submission): Promise<Buffer> {
  const [c] = await db.select().from(collectCampaigns).where(eq(collectCampaigns.id, s.campaignId));
  if (!c) throw new CollectError("کمپین پیدا نشد");
  const cfg = await getAllSettings(c.workspaceId);
  const base = await publicBase(c.workspaceId);
  const defs = parseCollectFields(c.fieldsJson);
  const values = JSON.parse(s.valuesJson || "{}") as Record<string, string>;
  const sig = s.signatureFile ? await readSignatureFile(s.signatureFile) : null;
  const input: PdfInput = {
    siteName: cfg.site_name,
    number: s.receipt,
    title: c.title,
    customerName: s.fullName,
    issuedAtText: fa(s.createdAt),
    completedAtText: fa(s.createdAt),
    bodyHtml: `${sanitizeHtml(s.bodySnapshot)}${valuesTable(defs, values)}`,
    docHash: s.docHash,
    verifyUrl: base ? `${base}/receipt/${s.receipt}` : "",
    signers: [
      {
        label: "امضاکننده",
        name: s.fullName,
        mobileMasked: s.mobile.length >= 8 ? `${s.mobile.slice(0, 4)}***${s.mobile.slice(-4)}` : "",
        signedAtText: faTime(s.createdAt),
        ip: s.ip,
        methodText: sig ? "ترسیم/آپلود تصویر" : "بدون تصویر امضا (تأیید با پذیرش متن)",
        otpVerified: s.mobileVerified,
        signature: sig,
      },
    ],
  };
  if (c.docFile) {
    const fields = docFieldsOf(c);
    const src = { pdfFile: c.docFile, pdfSha256: c.docSha256, originalName: c.docName, originalSha256: c.docSha256, kind: "pdf" };
    // گواهی: فرم و فیلدها هم دیده شود
    input.bodyHtml = valuesTable(defs, values);
    return composeOnPdf(src, fields, new Map(Object.entries(values)), input);
  }
  return renderContractPdf(input);
}
const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
/** CSV سازگار با اکسل (UTF-8 با BOM) */
export async function buildCsv(c: Campaign): Promise<string> {
  const defs = parseCollectFields(c.fieldsJson);
  const rows = await db.select().from(collectSubmissions).where(eq(collectSubmissions.campaignId, c.id)).orderBy(collectSubmissions.createdAt);
  const head = ["ردیف", "نام و نام خانوادگی", "موبایل", "موبایل تأییدشده", ...defs.map((d) => d.label), "زمان ثبت", "IP", "کد رسید", "اثر انگشت", "وضعیت"];
  const lines = [head.map(csvCell).join(",")];
  rows.forEach((s, i) => {
    const v = JSON.parse(s.valuesJson || "{}") as Record<string, string>;
    lines.push([i + 1, s.fullName, s.mobile, s.mobileVerified ? "بله" : "خیر", ...defs.map((d) => displayValue(d, v[d.key])), faTime(s.createdAt), s.ip, s.receipt, s.docHash, s.voidedAt ? "باطل‌شده" : "معتبر"].map(csvCell).join(","));
  });
  return `\ufeff${lines.join("\r\n")}\r\n`;
}
export const ZIP_LIMIT = 250;
/** ZIP همه‌ی PDFهای معتبر (حداکثر ۲۵۰ مورد در هر دریافت) */
export async function buildZip(c: Campaign): Promise<{ data: Uint8Array; count: number; truncated: boolean }> {
  const rows = await db
    .select()
    .from(collectSubmissions)
    .where(and(eq(collectSubmissions.campaignId, c.id), isNull(collectSubmissions.voidedAt)))
    .orderBy(collectSubmissions.createdAt)
    .limit(ZIP_LIMIT + 1);
  const files: Record<string, Uint8Array> = {};
  for (const s of rows.slice(0, ZIP_LIMIT)) {
    const nm = s.fullName.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40) || "signer";
    files[`${s.receipt}-${nm}.pdf`] = new Uint8Array(await buildSubmissionPdf(s));
  }
  return { data: zipSync(files, { level: 0 }), count: Object.keys(files).length, truncated: rows.length > ZIP_LIMIT };
}
export async function readCampaignDoc(c: Campaign): Promise<Buffer | null> {
  if (!c.docFile) return null;
  return readSourceFile(c.docFile, c.docSha256);
}
