import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contractAttachments, contracts } from "@/db/schema";
import { attachmentsDir } from "@/lib/storage-paths";
import { sha256Buf } from "@/modules/pdf/hash";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam } from "@/modules/inbox/service";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_CONTRACT = 12;

export type AttachmentRow = typeof contractAttachments.$inferSelect;

/** نوع واقعی فایل از روی امضای باینری (نه از نام یا Content-Type ارسالیِ کلاینت) */
export function sniffMime(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (buf.length >= 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return { mime: "image/png", ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}

/** نام نمایشی امن: بدون مسیر و نویسه‌ی کنترلی */
export function cleanFileName(name: string): string {
  const base = path.basename(String(name || "file")).replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, "_").trim();
  return (base || "file").slice(0, 120);
}

export type SaveResult = { ok: true; attachment: AttachmentRow } | { ok: false; error: string };

export async function saveAttachment(p: {
  contractId: number;
  uploader: { userId: number | null; label: string };
  title?: string;
  originalName: string;
  buffer: Buffer;
}): Promise<SaveResult> {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, p.contractId));
  if (!c) return { ok: false, error: "قرارداد یافت نشد" };
  if (["draft", "cancelled"].includes(c.status)) return { ok: false, error: "برای این قرارداد امکان پیوست فایل وجود ندارد" };
  if (p.buffer.length === 0) return { ok: false, error: "فایل خالی است" };
  if (p.buffer.length > MAX_ATTACHMENT_BYTES) return { ok: false, error: "حجم فایل بیش از ۵ مگابایت است" };
  const kind = sniffMime(p.buffer);
  if (!kind) return { ok: false, error: "فقط فایل‌های PDF، PNG، JPG و WebP پذیرفته می‌شود" };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(contractAttachments).where(eq(contractAttachments.contractId, p.contractId));
  if (n >= MAX_ATTACHMENTS_PER_CONTRACT) return { ok: false, error: `حداکثر ${MAX_ATTACHMENTS_PER_CONTRACT} پیوست برای هر قرارداد مجاز است` };

  const hash = sha256Buf(p.buffer);
  const file = `a${p.contractId}-${crypto.randomBytes(12).toString("hex")}.${kind.ext}`;
  await fs.mkdir(attachmentsDir(), { recursive: true, mode: 0o700 });
  const target = path.join(attachmentsDir(), file);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, p.buffer, { mode: 0o600 });
  await fs.rename(tmp, target);

  const [row] = await db
    .insert(contractAttachments)
    .values({
      contractId: p.contractId,
      uploadedBy: p.uploader.userId,
      uploaderLabel: p.uploader.label.slice(0, 80),
      title: (p.title || "").trim().slice(0, 120),
      originalName: cleanFileName(p.originalName),
      mime: kind.mime,
      size: p.buffer.length,
      sha256: hash,
      file,
    })
    .returning();
  await logAudit({
    action: "attachment.uploaded",
    contractId: p.contractId,
    userId: p.uploader.userId,
    detail: `${row.originalName} — ${Math.round(row.size / 1024)}KB — SHA-256: ${hash.slice(0, 16)}… — ${p.uploader.label}`,
  });
  await notifyTeam(c.workspaceId, { kind: "info", title: `پیوست جدید برای ${c.number}`, body: `${p.uploader.label} فایل «${row.originalName}» را پیوست کرد.`, href: `/contracts/${c.id}#attachments` }, [c.createdBy]);
  return { ok: true, attachment: row };
}

export async function listAttachments(contractId: number): Promise<AttachmentRow[]> {
  return db.select().from(contractAttachments).where(eq(contractAttachments.contractId, contractId)).orderBy(asc(contractAttachments.createdAt));
}

/** فقط ردیف (بدون خواندن فایل و بدون راستی‌آزمایی هش) — برای بررسی مالکیت/دسترسی */
export async function getAttachmentRow(contractId: number, id: number): Promise<AttachmentRow | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(contractAttachments).where(and(eq(contractAttachments.id, id), eq(contractAttachments.contractId, contractId)));
  return row ?? null;
}

export class AttachmentTamperedError extends Error {}

/** خواندن فایل با راستی‌آزمایی هش؛ در صورت مغایرت، رویداد امنیتی ثبت و خطا پرتاب می‌شود */
export async function readAttachment(contractId: number, id: number): Promise<{ row: AttachmentRow; buffer: Buffer } | null> {
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select().from(contractAttachments).where(and(eq(contractAttachments.id, id), eq(contractAttachments.contractId, contractId)));
  if (!row) return null;
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(path.join(attachmentsDir(), path.basename(row.file)));
  } catch {
    return null;
  }
  if (sha256Buf(buffer) !== row.sha256) {
    await logAudit({ action: "attachment.tampered", contractId, detail: `هش فایل ${row.originalName} با مقدار ثبت‌شده نمی‌خواند`, actor: "system" });
    throw new AttachmentTamperedError();
  }
  return { row, buffer };
}

/** حذف پیوست (فقط وقتی قرارداد هنوز نهایی نشده؛ پیوست قرارداد امضاشده بخشی از سند است) */
export async function deleteAttachment(contractId: number, id: number, actorUserId: number | null): Promise<{ ok: boolean; error?: string }> {
  const [c] = await db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, contractId));
  if (!c) return { ok: false, error: "قرارداد یافت نشد" };
  if (c.status === "signed") return { ok: false, error: "پیوست‌های قرارداد امضاشده قابل حذف نیستند" };
  const rows = await db.delete(contractAttachments).where(and(eq(contractAttachments.id, id), eq(contractAttachments.contractId, contractId))).returning();
  if (rows.length === 0) return { ok: false, error: "پیوست یافت نشد" };
  await fs.unlink(path.join(attachmentsDir(), path.basename(rows[0].file))).catch(() => undefined);
  await logAudit({ action: "attachment.deleted", contractId, userId: actorUserId, detail: rows[0].originalName });
  return { ok: true };
}

export async function deleteAllAttachments(contractId: number) {
  const rows = await db.delete(contractAttachments).where(eq(contractAttachments.contractId, contractId)).returning({ file: contractAttachments.file });
  for (const r of rows) await fs.unlink(path.join(attachmentsDir(), path.basename(r.file))).catch(() => undefined);
}

/** پاسخ دانلود امن: هرگز inline نمایش داده نمی‌شود و اجرای محتوا در مرورگر مسدود است */
export function downloadHeaders(row: AttachmentRow): Record<string, string> {
  const ascii = row.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return {
    "Content-Type": row.mime,
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.originalName)}`,
    "Content-Length": String(row.size),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "X-Attachment-SHA256": row.sha256,
    "Cache-Control": "private, no-store",
  };
}
