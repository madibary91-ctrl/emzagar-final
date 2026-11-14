import { type PDFPage } from "pdf-lib";
import { type PageMeta } from "../placement";
import { contractSources, documentFields } from "@/db/schema";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sourcesDir } from "@/lib/storage-paths";

export class DocError extends Error {
  constructor(
    message: string,
    /** کد ماشینی برای رابط کاربری (مثلاً docx_has_images) */
    readonly code: string = "invalid",
  ) {
    super(message);
    this.name = "DocError";
  }
}
/** پیام سخت‌گیرانه‌ی «Word دارای تصویر»: به‌جای تبدیل ناقص، کاربر باید PDF بارگذاری کند */
export const DOCX_IMAGES_MESSAGE =
  "این فایل Word شامل تصویر یا شیء گرافیکی است (مثلاً مهر، امضای اسکن‌شده، لوگو یا شکل). تبدیل خودکار Word این موارد را حذف می‌کند و سند از نظر حقوقی ناقص می‌شود؛ به همین دلیل بارگذاری آن پذیرفته نشد. لطفاً فایل را در Word با «File ← Save As ← PDF» به PDF تبدیل کنید و همان PDF را بارگذاری کنید.";
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const DRAFT_CODE_RE = /^[A-Za-z0-9_-]{22}$/;
export const DRAFT_TTL_MS = 24 * 3600_000;
export const safeFile = (n: string) => path.basename(n).replace(/[^a-zA-Z0-9._-]/g, "");
export const rid = () => crypto.randomBytes(14).toString("hex");
/* ───────── هندسه‌ی صفحه‌ی PDF (چرخش و CropBox) ───────── */

export function pageGeom(page: PDFPage) {
  const cb = page.getCropBox();
  const rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;
  return { cb, rot, dw: swap ? cb.height : cb.width, dh: swap ? cb.width : cb.height };
}
export interface IngestResult {
  kind: "pdf" | "docx";
  originalName: string;
  originalFile: string;
  originalSha256: string;
  pdfFile: string;
  pdfSha256: string;
  size: number;
  pageCount: number;
  pagesMeta: PageMeta[];
  warnings: string[];
}
export function cleanName(raw: string): string {
  return String(raw || "document").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e<>"\\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "document";
}
export async function removeFiles(...files: string[]) {
  for (const f of new Set(files.filter(Boolean))) await fs.unlink(path.join(sourcesDir(), safeFile(f))).catch(() => undefined);
}
/* ───────── پیش‌نویس بارگذاری (پیش از ساخت قرارداد) ───────── */

/** سقف فایل‌های مصرف‌نشده‌ی بدون حساب (جلوگیری از پر شدن دیسک توسط ناشناس‌ها) */
export const MAX_ANON_DRAFTS = 400;
/** مختصات در دیتابیس «ده‌هزارم» صفحه است (عدد صحیح)؛ بیرون از این ماژول همیشه کسر ۰ تا ۱ */
export const BP = 10_000;
export const toBp = (v: number) => Math.max(0, Math.min(BP, Math.round(v * BP)));
export type SourceRow = typeof contractSources.$inferSelect;
export type DocFieldRow = Omit<typeof documentFields.$inferSelect, "x" | "y" | "w" | "h"> & { x: number; y: number; w: number; h: number };
/* ───────── مقدار فیلدها هنگام امضا ───────── */

export const CTRL = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e<>]/g;
