import { type Batch, MergeError, type MergeRow, batchHeaders, batchMapping, batchOptions, resolveRow, rowData, sanitizeConfig } from "./core";
import { type MergeMapping, type MergeOptions } from "../pure";
import { type TeamUser } from "@/modules/tenancy/context";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { assertCanIssue } from "@/modules/billing/service";
import { batchStats, getBatch } from "./batches";
import { db } from "@/db";
import { enqueueJob } from "@/modules/jobs/queue";
import { ensureGuestSigner } from "@/modules/guests/service";
import { insertPlan } from "@/modules/contract-pay/service";
import { issueContract, normalizeTags } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";
import { mergeBatches, mergeRows } from "@/db/schema";
import { notifyUser } from "@/modules/inbox/service";
import { sanitizeHtml } from "@/lib/html";

/** ذخیره‌ی نگاشت/گزینه‌ها، اعتبارسنجی همه‌ی ردیف‌ها، و قرار دادن ردیف‌های معتبر در صف ارسال */
export async function startBatch(team: TeamUser, batchId: number, cfg: { mapping: MergeMapping; options: Partial<MergeOptions> }): Promise<{ queued: number; invalid: number; skipped: number }> {
  const batch = await getBatch(batchId, team.workspaceId);
  if (!batch) throw new MergeError("دسته یافت نشد");
  if (batch.status !== "draft") throw new MergeError("این دسته قبلاً شروع شده است");
  const headers = batchHeaders(batch);
  const { mapping, options } = sanitizeConfig(cfg, headers);
  if (!mapping.roles.name) throw new MergeError("ستون «نام امضاکننده» را انتخاب کنید");
  if (!mapping.roles.mobile) throw new MergeError("ستون «موبایل» را انتخاب کنید");
  if (mapping.roles.name === mapping.roles.mobile) throw new MergeError("ستون نام و موبایل باید متفاوت باشند");
  if (options.plan.enabled && !mapping.roles.amount) throw new MergeError("برای برنامه‌ی پرداخت، ستون «مبلغ» را انتخاب کنید");

  const rows = await db.select().from(mergeRows).where(eq(mergeRows.batchId, batchId)).orderBy(asc(mergeRows.rowNo));
  const seen = new Set<string>();
  const verdicts: { id: number; status: string; error: string | null; name: string; mobile: string }[] = [];
  for (const r of rows) {
    const res = resolveRow(batch, rowData(r), mapping, options, false);
    if (!res.ok) {
      verdicts.push({ id: r.id, status: "invalid", error: res.error, name: "", mobile: "" });
      continue;
    }
    const key = `${res.mobile}|${res.name.toLowerCase()}`;
    if (options.skipDuplicates && seen.has(key)) verdicts.push({ id: r.id, status: "skipped", error: "ردیف تکراری (همین نام و موبایل پیش‌تر در فایل آمده)", name: res.name, mobile: res.mobile });
    else verdicts.push({ id: r.id, status: "queued", error: null, name: res.name, mobile: res.mobile });
    seen.add(key);
  }
  const queued = verdicts.filter((v) => v.status === "queued");
  if (queued.length === 0) throw new MergeError("هیچ ردیف معتبری برای ارسال نیست؛ خطاهای جدول بازبینی را برطرف کنید");
  // سقف طرح پیش از شروع: به‌جای شکست ردیف‌به‌ردیف، همین‌جا شفاف گزارش می‌شود
  try {
    await assertCanIssue(team.workspaceId, queued.length);
  } catch (e) {
    throw new MergeError(e instanceof Error ? `${e.message} — برای ${queued.length.toLocaleString("fa-IR")} قرارداد ظرفیت کافی نیست` : "ظرفیت طرح کافی نیست");
  }

  const claimed = await db
    .update(mergeBatches)
    .set({ status: "running", startedAt: new Date(), mapping: JSON.stringify(mapping), options: JSON.stringify(options), contractTitle: options.contractTitle || batch.contractTitle })
    .where(and(eq(mergeBatches.id, batchId), eq(mergeBatches.status, "draft")))
    .returning({ id: mergeBatches.id });
  if (claimed.length === 0) throw new MergeError("این دسته قبلاً شروع شده است");
  for (const v of verdicts) await db.update(mergeRows).set({ status: v.status, error: v.error, name: v.name, mobile: v.mobile, updatedAt: new Date() }).where(eq(mergeRows.id, v.id));
  for (let i = 0; i < queued.length; i++) await enqueueJob("merge.row", { rowId: queued[i].id }, { dedupeKey: `merge-row:${queued[i].id}:0`, kick: i === queued.length - 1, maxAttempts: 1 });
  await logAudit({ action: "merge.started", workspaceId: team.workspaceId, userId: team.id, detail: `«${batch.title}» — ارسال: ${queued.length.toLocaleString("fa-IR")}، نامعتبر: ${verdicts.filter((v) => v.status === "invalid").length.toLocaleString("fa-IR")}` });
  return { queued: queued.length, invalid: verdicts.filter((v) => v.status === "invalid").length, skipped: verdicts.filter((v) => v.status === "skipped").length };
}
/** پردازش یک ردیف (اجرا در صف کارها). هیچ‌گاه پرتاب نمی‌کند؛ نتیجه روی ردیف ثبت می‌شود. */
export async function processMergeRow(rowId: number): Promise<void> {
  const [claimed] = await db.update(mergeRows).set({ status: "processing", updatedAt: new Date() }).where(and(eq(mergeRows.id, rowId), eq(mergeRows.status, "queued"))).returning();
  if (!claimed) return;
  const [batch] = await db.select().from(mergeBatches).where(eq(mergeBatches.id, claimed.batchId));
  try {
    if (!batch) throw new MergeError("دسته یافت نشد");
    if (batch.status === "cancelled") {
      await db.update(mergeRows).set({ status: "skipped", error: "با لغو دسته ارسال نشد", updatedAt: new Date() }).where(eq(mergeRows.id, rowId));
      return;
    }
    const res = resolveRow(batch, rowData(claimed), batchMapping(batch), batchOptions(batch));
    if (!res.ok) throw new MergeError(res.error);
    const opts = batchOptions(batch);
    const guest = await ensureGuestSigner(batch.workspaceId, { name: res.name, mobile: res.mobile });
    const contractId = await issueContract({
      workspaceId: batch.workspaceId,
      title: res.title,
      bodyHtml: res.body,
      templateId: batch.templateId,
      customerId: guest.userId,
      customerLabel: opts.signerLabel,
      createdBy: batch.createdBy,
      expiryDays: opts.expiryDays,
      tags: normalizeTags(`${opts.tags},ارسال انبوه`),
      contractValue: res.amount,
      amount: res.amount ?? undefined,
      onCreated: async (cid) => {
        if (res.items) await insertPlan(cid, batch.workspaceId, res.items);
      },
    });
    await db.update(mergeRows).set({ status: "sent", contractId, error: null, updatedAt: new Date() }).where(eq(mergeRows.id, rowId));
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "خطای ناشناخته").slice(0, 300);
    await db.update(mergeRows).set({ status: "failed", error: msg, updatedAt: new Date() }).where(eq(mergeRows.id, rowId));
  }
  if (batch) await finishIfDone(batch);
}
async function finishIfDone(batch: Batch) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(mergeRows).where(and(eq(mergeRows.batchId, batch.id), inArray(mergeRows.status, ["queued", "processing"])));
  if ((r?.n ?? 0) > 0) return;
  const done = await db.update(mergeBatches).set({ status: "done", completedAt: new Date() }).where(and(eq(mergeBatches.id, batch.id), eq(mergeBatches.status, "running"))).returning({ id: mergeBatches.id });
  if (done.length === 0) return;
  const st = await batchStats(batch.id);
  await notifyUser(batch.createdBy, { kind: (st.failed ?? 0) > 0 ? "warning" : "success", title: `ارسال انبوه «${batch.title}» پایان یافت`, body: `ارسال‌شده: ${(st.sent ?? 0).toLocaleString("fa-IR")} • ناموفق: ${(st.failed ?? 0).toLocaleString("fa-IR")}`, href: `/admin/merge/${batch.id}` }).catch(() => false);
}
export interface PreviewResult {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  problems: { rowNo: number; error: string }[];
  sample: null | { rowNo: number; name: string; mobile: string; title: string; bodyHtml: string; plan: { title: string; amount: number; dueAt: string | null; gate: boolean }[] };
  paymentTotal: number;
}
/** پیش‌نمایش زنده‌ی بازبینی: همان منطق ارسال واقعی روی همه‌ی ردیف‌ها + نمونه‌ی رندرشده‌ی یک ردیف */
export async function previewBatch(team: TeamUser, batchId: number, cfg: { mapping: MergeMapping; options: Partial<MergeOptions> }, sampleRowNo?: number): Promise<PreviewResult> {
  const batch = await getBatch(batchId, team.workspaceId);
  if (!batch || batch.status !== "draft") throw new MergeError("دسته در وضعیت بازبینی نیست");
  const { mapping, options } = sanitizeConfig(cfg, batchHeaders(batch));
  const rows = await db.select().from(mergeRows).where(eq(mergeRows.batchId, batchId)).orderBy(asc(mergeRows.rowNo));
  const out: PreviewResult = { total: rows.length, valid: 0, invalid: 0, duplicates: 0, problems: [], sample: null, paymentTotal: 0 };
  if (!mapping.roles.name || !mapping.roles.mobile) {
    out.invalid = rows.length;
    return out;
  }
  const seen = new Set<string>();
  let sampleChosen: MergeRow | null = null;
  for (const r of rows) {
    const res = resolveRow(batch, rowData(r), mapping, options, false);
    if (!res.ok) {
      out.invalid++;
      if (out.problems.length < 30) out.problems.push({ rowNo: r.rowNo, error: res.error });
      continue;
    }
    const key = `${res.mobile}|${res.name.toLowerCase()}`;
    if (options.skipDuplicates && seen.has(key)) {
      out.duplicates++;
      continue;
    }
    seen.add(key);
    out.valid++;
    out.paymentTotal += res.amount ?? 0;
    if (!sampleChosen && (!sampleRowNo || r.rowNo === sampleRowNo)) sampleChosen = r;
  }
  if (!sampleChosen && sampleRowNo) sampleChosen = rows.find((r) => r.rowNo === sampleRowNo) ?? null;
  if (sampleChosen) {
    const res = resolveRow(batch, rowData(sampleChosen), mapping, options, true);
    if (res.ok) out.sample = { rowNo: sampleChosen.rowNo, name: res.name, mobile: res.mobile, title: res.title, bodyHtml: sanitizeHtml(res.body), plan: (res.items ?? []).map((i) => ({ title: i.title, amount: i.amount, dueAt: i.dueAt, gate: i.gate === "before_sign" })) };
  }
  return out;
}
