import { KIND_LABELS, type KnowledgeKind, MAX_DOCS_PER_WORKSPACE, MAX_TOTAL_CHARS, isKind } from "../constants";
import { MAX_DOC_CHARS, MIN_DOC_CHARS, cleanText, htmlToText, redactPii } from "../text";
import { aiKnowledgeDocs, contracts, templates } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * «حافظه‌ی حقوقی» هر فضای کاری. همه‌ی کوئری‌ها با workspaceId فیلتر می‌شوند (ایزولاسیون کامل چندمستاجری).
 */
export type DocSummary = Omit<typeof aiKnowledgeDocs.$inferSelect, "content">;
const SUMMARY = {
  id: aiKnowledgeDocs.id,
  workspaceId: aiKnowledgeDocs.workspaceId,
  userId: aiKnowledgeDocs.userId,
  title: aiKnowledgeDocs.title,
  kind: aiKnowledgeDocs.kind,
  source: aiKnowledgeDocs.source,
  sourceRef: aiKnowledgeDocs.sourceRef,
  fileName: aiKnowledgeDocs.fileName,
  charCount: aiKnowledgeDocs.charCount,
  redactions: aiKnowledgeDocs.redactions,
  enabled: aiKnowledgeDocs.enabled,
  createdAt: aiKnowledgeDocs.createdAt,
};
export async function listDocs(workspaceId: number): Promise<DocSummary[]> {
  return db.select(SUMMARY).from(aiKnowledgeDocs).where(eq(aiKnowledgeDocs.workspaceId, workspaceId)).orderBy(desc(aiKnowledgeDocs.createdAt));
}
export async function getDocPreview(workspaceId: number, id: number): Promise<{ title: string; text: string; total: number } | null> {
  const [d] = await db.select().from(aiKnowledgeDocs).where(and(eq(aiKnowledgeDocs.id, id), eq(aiKnowledgeDocs.workspaceId, workspaceId)));
  if (!d) return null;
  return { title: d.title, text: d.content.slice(0, 4000), total: d.content.length };
}
export type AddResult = { ok: true; id: number; redactions: number; truncated: boolean; kinds: Record<string, number> } | { ok: false; error: string };
/** افزودن سند: پاک‌سازی ← (اختیاری) حذف اطلاعات حساس ← سقف‌ها ← ذخیره */
export async function addDoc(p: {
  workspaceId: number;
  userId: number;
  title: string;
  kind: string;
  source: "upload" | "paste" | "contract" | "template";
  sourceRef?: number | null;
  fileName?: string;
  rawText: string;
  redact?: boolean;
}): Promise<AddResult> {
  const kind: KnowledgeKind = isKind(p.kind) ? p.kind : "sample";
  const title = p.title.replace(/\s+/g, " ").trim().slice(0, 120) || "سند بدون عنوان";
  let text = cleanText(p.rawText);
  let truncated = false;
  if (text.length > MAX_DOC_CHARS) {
    text = text.slice(0, MAX_DOC_CHARS);
    truncated = true;
  }
  if (text.length < MIN_DOC_CHARS) return { ok: false, error: `متن سند خیلی کوتاه است (حداقل ${MIN_DOC_CHARS} نویسه)` };

  const [stat] = await db
    .select({ n: sql<number>`count(*)::int`, chars: sql<number>`coalesce(sum(${aiKnowledgeDocs.charCount}),0)::int` })
    .from(aiKnowledgeDocs)
    .where(eq(aiKnowledgeDocs.workspaceId, p.workspaceId));
  if ((stat?.n ?? 0) >= MAX_DOCS_PER_WORKSPACE) return { ok: false, error: `حداکثر ${MAX_DOCS_PER_WORKSPACE} سند برای هر فضای کاری مجاز است؛ سندهای قدیمی را حذف کنید` };
  if ((stat?.chars ?? 0) + text.length > MAX_TOTAL_CHARS) return { ok: false, error: "حجم کل حافظه به سقف رسیده است؛ برخی سندها را حذف کنید" };

  if (p.sourceRef && (p.source === "contract" || p.source === "template")) {
    const [dup] = await db
      .select({ id: aiKnowledgeDocs.id })
      .from(aiKnowledgeDocs)
      .where(and(eq(aiKnowledgeDocs.workspaceId, p.workspaceId), eq(aiKnowledgeDocs.source, p.source), eq(aiKnowledgeDocs.sourceRef, p.sourceRef)));
    if (dup) return { ok: false, error: "این مورد قبلاً به حافظه اضافه شده است" };
  }

  const red = p.redact === false ? { text, count: 0, kinds: {} as Record<string, number> } : redactPii(text);
  const [row] = await db
    .insert(aiKnowledgeDocs)
    .values({
      workspaceId: p.workspaceId,
      userId: p.userId,
      title,
      kind,
      source: p.source,
      sourceRef: p.sourceRef ?? null,
      fileName: (p.fileName || "").slice(0, 160),
      content: red.text,
      charCount: red.text.length,
      redactions: red.count,
    })
    .returning({ id: aiKnowledgeDocs.id });
  return { ok: true, id: row.id, redactions: red.count, truncated, kinds: red.kinds };
}
export async function setDocEnabled(workspaceId: number, id: number, enabled: boolean): Promise<boolean> {
  const r = await db.update(aiKnowledgeDocs).set({ enabled }).where(and(eq(aiKnowledgeDocs.id, id), eq(aiKnowledgeDocs.workspaceId, workspaceId))).returning({ id: aiKnowledgeDocs.id });
  return r.length > 0;
}
export async function setDocKind(workspaceId: number, id: number, kind: string): Promise<boolean> {
  if (!isKind(kind)) return false;
  const r = await db.update(aiKnowledgeDocs).set({ kind }).where(and(eq(aiKnowledgeDocs.id, id), eq(aiKnowledgeDocs.workspaceId, workspaceId))).returning({ id: aiKnowledgeDocs.id });
  return r.length > 0;
}
export async function deleteDoc(workspaceId: number, id: number): Promise<boolean> {
  const r = await db.delete(aiKnowledgeDocs).where(and(eq(aiKnowledgeDocs.id, id), eq(aiKnowledgeDocs.workspaceId, workspaceId))).returning({ id: aiKnowledgeDocs.id });
  return r.length > 0;
}
/** وارد کردن قراردادها/قالب‌های موجود همین فضای کاری (بدون آپلود). ایمن در برابر شناسه‌ی فضای دیگر */
export async function importFromSystem(p: { workspaceId: number; userId: number; type: "contract" | "template"; ids: number[] }): Promise<{ added: number; skipped: number; errors: string[] }> {
  const ids = [...new Set(p.ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  if (ids.length === 0) return { added: 0, skipped: 0, errors: ["موردی انتخاب نشده است"] };
  const rows =
    p.type === "contract"
      ? (await db.select({ id: contracts.id, title: contracts.title, html: contracts.bodyHtml }).from(contracts).where(and(eq(contracts.workspaceId, p.workspaceId), inArray(contracts.id, ids)))).map((r) => ({ ...r, kind: "sample" as const }))
      : (await db.select({ id: templates.id, title: templates.title, html: templates.body }).from(templates).where(and(eq(templates.workspaceId, p.workspaceId), inArray(templates.id, ids)))).map((r) => ({ ...r, kind: "sample" as const }));
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const r of rows) {
    const res = await addDoc({ workspaceId: p.workspaceId, userId: p.userId, title: r.title, kind: r.kind, source: p.type, sourceRef: r.id, rawText: htmlToText(r.html) });
    if (res.ok) added++;
    else {
      skipped++;
      errors.push(`«${r.title}»: ${res.error}`);
    }
  }
  return { added, skipped, errors };
}
/** سند‌های فعال با متن کامل (فقط برای ساخت پرامپت/اثر انگشت) */
export async function activeDocs(workspaceId: number) {
  return db
    .select({ id: aiKnowledgeDocs.id, title: aiKnowledgeDocs.title, kind: aiKnowledgeDocs.kind, content: aiKnowledgeDocs.content })
    .from(aiKnowledgeDocs)
    .where(and(eq(aiKnowledgeDocs.workspaceId, workspaceId), eq(aiKnowledgeDocs.enabled, true)))
    .orderBy(desc(aiKnowledgeDocs.createdAt));
}
export const kindLabel = (k: string) => (isKind(k) ? KIND_LABELS[k] : k);
