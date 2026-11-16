import { BP, type DocFieldRow, type SourceRow, removeFiles, rid, safeFile, toBp } from "./core";
import fs from "node:fs/promises";
import path from "node:path";
import { sourcesDir } from "@/lib/storage-paths";
import { type Draft } from "./drafts";
import { type Placement } from "../placement";
import { asc, eq } from "drizzle-orm";
import { contractSources, documentDrafts, documentFields } from "@/db/schema";
import { db } from "@/db";

/** باید داخل تراکنش صدور قرارداد صدا زده شود (اتمی) */
export async function attachSourceToContract(contractId: number, draft: Draft, placements: Placement[]) {
  await db.insert(contractSources).values({
    contractId,
    kind: draft.kind,
    originalName: draft.originalName,
    originalFile: draft.originalFile,
    originalSha256: draft.originalSha256,
    pdfFile: draft.pdfFile,
    pdfSha256: draft.pdfSha256,
    size: draft.size,
    pageCount: draft.pageCount,
    pagesMeta: draft.pagesMeta,
  });
  if (placements.length) await db.insert(documentFields).values(placements.map((p) => ({ contractId, ...p, x: toBp(p.x), y: toBp(p.y), w: toBp(p.w), h: toBp(p.h) })));
  await db.update(documentDrafts).set({ consumedAt: new Date() }).where(eq(documentDrafts.id, draft.id));
}
/** حذف فایل‌های مبدأ یک قرارداد از دیسک (هنگام حذف قرارداد) */
export async function removeSourceFiles(contractId: number) {
  const [s] = await db.select().from(contractSources).where(eq(contractSources.contractId, contractId));
  if (!s) return;
  await removeFiles(s.originalFile, s.pdfFile);
  await db.delete(documentDrafts).where(eq(documentDrafts.originalFile, s.originalFile));
}
export async function getSource(contractId: number): Promise<SourceRow | null> {
  const [s] = await db.select().from(contractSources).where(eq(contractSources.contractId, contractId));
  return s ?? null;
}
export async function listDocFields(contractId: number): Promise<DocFieldRow[]> {
  const rows = await db.select().from(documentFields).where(eq(documentFields.contractId, contractId)).orderBy(asc(documentFields.page), asc(documentFields.y), asc(documentFields.id));
  return rows.map((r) => ({ ...r, x: r.x / BP, y: r.y / BP, w: r.w / BP, h: r.h / BP }));
}

/**
 * کپی «فایل مبدأ + جای فیلدها» از یک قرارداد به قرارداد دیگر (صدور مجدد/تمدید/کپی).
 * فایل‌ها «واقعاً کپی» می‌شوند، نه مشترک؛ چون حذف یک قرارداد فایل‌های مبدأش را پاک می‌کند و قرارداد دیگر نباید خراب شود.
 * خروجی: فایل‌های تازه‌ساخته (برای پاک‌کردن اگر تراکنش صدور برگردد). اگر قرارداد مبدأ فایلی ندارد، آرایه‌ی خالی.
 * باید داخل تراکنش صدور صدا زده شود.
 */
export async function cloneSourceToContract(fromContractId: number, toContractId: number, created: string[] = []): Promise<string[]> {
  const [s] = await db.select().from(contractSources).where(eq(contractSources.contractId, fromContractId));
  if (!s) return created;
  const dir = sourcesDir();
  const copy = async (name: string) => {
    const src = path.join(dir, safeFile(name));
    const dstName = `${rid()}${path.extname(safeFile(name)).slice(0, 8)}`;
    await fs.copyFile(src, path.join(dir, dstName));
    created.push(dstName);
    return dstName;
  };
  const originalFile = await copy(s.originalFile);
  const pdfFile = s.pdfFile === s.originalFile ? originalFile : await copy(s.pdfFile);
  await db.insert(contractSources).values({
    contractId: toContractId,
    kind: s.kind,
    originalName: s.originalName,
    originalFile,
    originalSha256: s.originalSha256,
    pdfFile,
    pdfSha256: s.pdfSha256,
    size: s.size,
    pageCount: s.pageCount,
    pagesMeta: s.pagesMeta,
  });
  const fields = await db.select().from(documentFields).where(eq(documentFields.contractId, fromContractId));
  if (fields.length) {
    await db.insert(documentFields).values(fields.map(({ id: _id, contractId: _c, ...f }) => ({ contractId: toContractId, ...f })));
  }
  return created;
}
