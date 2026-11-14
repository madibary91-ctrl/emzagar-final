import { CODE_ALPHABET, CODE_RE, type Campaign, CollectError, MAX_BODY, rand, textLen } from "./core";
import { DocError, getUsableDraft } from "@/modules/docs/service";
import { type Placement, fieldKey, sanitizePlacements } from "@/modules/docs/placement";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { cleanGuestName } from "@/modules/guests/service";
import { collectCampaigns, collectSubmissions, documentDrafts } from "@/db/schema";
import { db, withTransaction } from "@/db";
import { deleteSignatureFile } from "@/modules/signing/storage";
import fs from "node:fs/promises";
import { logAudit } from "@/modules/audit/service";
import { parseCollectFields } from "../schema";
import path from "node:path";
import { sanitizeHtml } from "@/lib/html";
import { sourcesDir } from "@/lib/storage-paths";

/* ───────── مدیریت کمپین ───────── */

export interface CampaignInput {
  title: string;
  description?: string;
  bodyHtml?: string;
  fields?: unknown;
  requireOtp?: boolean;
  requireSignature?: boolean;
  allowDuplicates?: boolean;
  maxSubmissions?: number | null;
  closesAt?: Date | null;
  successMessage?: string;
  draftCode?: string;
  placements?: unknown;
}
export async function createCampaign(workspaceId: number, userId: number, input: CampaignInput): Promise<{ id: number; code: string }> {
  const title = cleanGuestName(input.title).slice(0, 120);
  if (title.length < 3) throw new CollectError("عنوان را وارد کنید");
  const fields = parseCollectFields(input.fields);
  const requireSignature = input.requireSignature !== false;
  let body = sanitizeHtml(String(input.bodyHtml || ""));
  let doc = { file: "", sha: "", name: "", meta: "[]", placements: "[]" };
  let draft: Awaited<ReturnType<typeof getUsableDraft>> | null = null;
  if (input.draftCode) {
    try {
      draft = await getUsableDraft(input.draftCode, workspaceId);
    } catch (e) {
      throw new CollectError(e instanceof DocError ? e.message : "فایل معتبر نیست");
    }
    const pl = sanitizePlacements(input.placements, draft.pageCount, 1, { requireSignatureFor: requireSignature ? [1] : [] });
    if (!pl.ok) throw new CollectError(pl.error);
    doc = { file: draft.pdfFile, sha: draft.pdfSha256, name: draft.originalName, meta: draft.pagesMeta, placements: JSON.stringify(pl.items) };
  } else if (textLen(body) < 10) throw new CollectError("متن توافق‌نامه‌ای که مردم امضا می‌کنند را بنویسید");
  if (body.length > MAX_BODY) throw new CollectError("متن بیش از حد طولانی است");
  const max = input.maxSubmissions && input.maxSubmissions > 0 ? Math.min(Math.round(input.maxSubmissions), 1_000_000) : null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = rand(CODE_ALPHABET, 8);
    try {
      return await withTransaction(async () => {
        const [row] = await db
          .insert(collectCampaigns)
          .values({
            workspaceId,
            createdBy: userId,
            code,
            title,
            description: cleanGuestName(input.description).slice(0, 300),
            bodyHtml: body,
            fieldsJson: JSON.stringify(fields),
            requireOtp: input.requireOtp !== false,
            requireSignature,
            allowDuplicates: input.allowDuplicates === true,
            maxSubmissions: max,
            closesAt: input.closesAt ?? null,
            successMessage: cleanGuestName(input.successMessage).slice(0, 300),
            docFile: doc.file,
            docSha256: doc.sha,
            docName: doc.name,
            docPagesMeta: doc.meta,
            docPlacementsJson: doc.placements,
          })
          .returning({ id: collectCampaigns.id });
        if (draft) await db.update(documentDrafts).set({ consumedAt: new Date() }).where(eq(documentDrafts.id, draft.id));
        await logAudit({ action: "collect.created", workspaceId, userId, detail: `${title} — /c/${code}` });
        return { id: row.id, code };
      });
    } catch (e) {
      if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") continue;
      throw e;
    }
  }
  throw new CollectError("ساخت کد کوتاه انجام نشد؛ دوباره تلاش کنید");
}
export async function listCampaigns(workspaceId: number) {
  const rows = await db.select().from(collectCampaigns).where(eq(collectCampaigns.workspaceId, workspaceId)).orderBy(desc(collectCampaigns.createdAt));
  const counts = await db
    .select({ id: collectSubmissions.campaignId, n: count(), last: sql<Date | null>`max(${collectSubmissions.createdAt})` })
    .from(collectSubmissions)
    .where(and(eq(collectSubmissions.workspaceId, workspaceId), isNull(collectSubmissions.voidedAt)))
    .groupBy(collectSubmissions.campaignId);
  const map = new Map(counts.map((c) => [c.id, c]));
  return rows.map((r) => ({ ...r, submissions: map.get(r.id)?.n ?? 0, lastAt: map.get(r.id)?.last ?? null }));
}
export async function getCampaign(id: number, workspaceId: number): Promise<Campaign | null> {
  const [c] = await db.select().from(collectCampaigns).where(and(eq(collectCampaigns.id, id), eq(collectCampaigns.workspaceId, workspaceId)));
  return c ?? null;
}
export async function getCampaignByCode(code: string): Promise<Campaign | null> {
  if (!CODE_RE.test(code)) return null;
  const [c] = await db.select().from(collectCampaigns).where(eq(collectCampaigns.code, code));
  return c ?? null;
}
export async function countSubmissions(campaignId: number, opts: { includeVoided?: boolean } = {}): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(collectSubmissions)
    .where(and(eq(collectSubmissions.campaignId, campaignId), opts.includeVoided ? undefined : isNull(collectSubmissions.voidedAt)));
  return r?.n ?? 0;
}
export async function updateCampaignSettings(id: number, workspaceId: number, userId: number, p: { status?: string; title?: string; maxSubmissions?: number | null; closesAt?: Date | null; successMessage?: string; description?: string }) {
  const c = await getCampaign(id, workspaceId);
  if (!c) throw new CollectError("کمپین پیدا نشد");
  const set: Partial<typeof collectCampaigns.$inferInsert> = { updatedAt: new Date() };
  if (p.status !== undefined) {
    if (!["open", "paused", "closed"].includes(p.status)) throw new CollectError("وضعیت نامعتبر است");
    set.status = p.status;
  }
  if (p.title !== undefined) {
    const t = cleanGuestName(p.title).slice(0, 120);
    if (t.length < 3) throw new CollectError("عنوان را وارد کنید");
    set.title = t;
  }
  if (p.maxSubmissions !== undefined) set.maxSubmissions = p.maxSubmissions && p.maxSubmissions > 0 ? Math.min(Math.round(p.maxSubmissions), 1_000_000) : null;
  if (p.closesAt !== undefined) set.closesAt = p.closesAt;
  if (p.successMessage !== undefined) set.successMessage = cleanGuestName(p.successMessage).slice(0, 300);
  if (p.description !== undefined) set.description = cleanGuestName(p.description).slice(0, 300);
  await db.update(collectCampaigns).set(set).where(eq(collectCampaigns.id, id));
  await logAudit({ action: "collect.updated", workspaceId, userId, detail: `${c.title}${p.status ? ` — وضعیت: ${p.status}` : ""}` });
}
export async function deleteCampaign(id: number, workspaceId: number, userId: number) {
  const c = await getCampaign(id, workspaceId);
  if (!c) return;
  const subs = await db.select({ f: collectSubmissions.signatureFile }).from(collectSubmissions).where(eq(collectSubmissions.campaignId, id));
  for (const s of subs) if (s.f) await deleteSignatureFile(s.f);
  await db.delete(collectCampaigns).where(eq(collectCampaigns.id, id));
  if (c.docFile) await fs.unlink(path.join(sourcesDir(), path.basename(c.docFile))).catch(() => undefined);
  await logAudit({ action: "collect.deleted", workspaceId, userId, detail: c.title });
}
/** وضعیت پذیرش: برای صفحه‌ی عمومی */
export async function acceptingState(c: Campaign): Promise<{ open: boolean; reason?: string }> {
  if (c.status === "paused") return { open: false, reason: "دریافت امضا موقتاً متوقف شده است" };
  if (c.status === "closed") return { open: false, reason: "دریافت امضا برای این فرم بسته شده است" };
  if (c.closesAt && c.closesAt.getTime() < Date.now()) return { open: false, reason: "مهلت دریافت امضا تمام شده است" };
  if (c.maxSubmissions && (await countSubmissions(c.id)) >= c.maxSubmissions) return { open: false, reason: "ظرفیت این فرم تکمیل شده است" };
  return { open: true };
}
export function docFieldsOf(c: Campaign): (Placement & { key: string })[] {
  try {
    const arr = JSON.parse(c.docPlacementsJson) as Placement[];
    return Array.isArray(arr) ? arr.map((p, i) => ({ ...p, key: fieldKey(i + 1) })) : [];
  } catch {
    return [];
  }
}
