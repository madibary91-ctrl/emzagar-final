import { DRAFT_CODE_RE, DRAFT_TTL_MS, DocError, MAX_ANON_DRAFTS, removeFiles } from "./core";
import { type PageMeta } from "../placement";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "@/db";
import { documentDrafts } from "@/db/schema";
import { escapeHtml } from "@/lib/html";
import { ingestUpload } from "./ingest";

export async function createDraft(p: { buf: Buffer; name: string; workspaceId: number | null; userId: number | null; ip: string }) {
  if (p.workspaceId === null) {
    const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(documentDrafts).where(and(isNull(documentDrafts.workspaceId), isNull(documentDrafts.consumedAt)));
    if ((n?.n ?? 0) >= MAX_ANON_DRAFTS) throw new DocError("ظرفیت بارگذاری موقتاً پر است؛ چند دقیقه بعد دوباره تلاش کنید");
  }
  const r = await ingestUpload(p.buf, p.name);
  const code = crypto.randomBytes(16).toString("base64url");
  try {
    await db.insert(documentDrafts).values({
      code,
      workspaceId: p.workspaceId,
      userId: p.userId,
      ip: p.ip.slice(0, 64),
      kind: r.kind,
      originalName: r.originalName,
      originalFile: r.originalFile,
      originalSha256: r.originalSha256,
      pdfFile: r.pdfFile,
      pdfSha256: r.pdfSha256,
      size: r.size,
      pageCount: r.pageCount,
      pagesMeta: JSON.stringify(r.pagesMeta),
    });
  } catch (e) {
    await removeFiles(r.originalFile, r.pdfFile);
    throw e;
  }
  return { code, ...r };
}
export type Draft = typeof documentDrafts.$inferSelect;
export async function getDraft(code: string): Promise<Draft | null> {
  if (!DRAFT_CODE_RE.test(code)) return null;
  const [d] = await db.select().from(documentDrafts).where(eq(documentDrafts.code, code));
  return d ?? null;
}
/** پیش‌نویسِ قابل‌استفاده برای یک فضای کاری مشخص (null = ارسال سریع بدون حساب) */
export async function getUsableDraft(code: string, workspaceId: number | null): Promise<Draft> {
  const d = await getDraft(code);
  if (!d || d.consumedAt) throw new DocError("فایل بارگذاری‌شده پیدا نشد یا قبلاً استفاده شده است؛ دوباره بارگذاری کنید");
  if ((d.workspaceId ?? null) !== workspaceId) throw new DocError("دسترسی به این فایل مجاز نیست");
  if (Date.now() - d.createdAt.getTime() > DRAFT_TTL_MS) throw new DocError("مهلت فایل بارگذاری‌شده تمام شده است؛ دوباره بارگذاری کنید");
  return d;
}
export const parseMeta = (raw: string): PageMeta[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((p) => ({ w: Number(p.w) || 595, h: Number(p.h) || 842 })) : [];
  } catch {
    return [];
  }
};
/** پاک‌سازی فایل‌های مصرف‌نشده‌ی قدیمی (از کرون صدا زده می‌شود) */
export async function purgeStaleDrafts(): Promise<number> {
  const old = await db.select().from(documentDrafts).where(and(isNull(documentDrafts.consumedAt), lt(documentDrafts.createdAt, new Date(Date.now() - DRAFT_TTL_MS))));
  for (const d of old) {
    await removeFiles(d.originalFile, d.pdfFile);
    await db.delete(documentDrafts).where(eq(documentDrafts.id, d.id));
  }
  return old.length;
}
/* ───────── اتصال فایل به قرارداد ───────── */

export function sourceStubHtml(name: string, sha: string): string {
  return `<p>این قرارداد روی فایل بارگذاری‌شده‌ی «${escapeHtml(name)}» امضا می‌شود؛ متن اصلی همان فایل است و امضاها و فیلدها دقیقاً روی خودِ فایل درج می‌شوند.</p><p dir="ltr">SHA-256: ${escapeHtml(sha)}</p>`;
}
