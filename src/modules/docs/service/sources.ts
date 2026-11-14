import { BP, type DocFieldRow, type SourceRow, removeFiles, toBp } from "./core";
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
