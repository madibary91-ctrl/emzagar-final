import { type Batch, MergeError } from "./core";
import { DEFAULT_OPTIONS, type MergeOptions, detectPlaceholders, guessMapping } from "../pure";
import { type TeamUser } from "@/modules/tenancy/context";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { assertCanIssue } from "@/modules/billing/service";
import { contracts, mergeBatches, mergeRows, templates } from "@/db/schema";
import { db } from "@/db";
import { enqueueJob } from "@/modules/jobs/queue";
import { logAudit } from "@/modules/audit/service";
import { parseSpreadsheet } from "@/lib/spreadsheet";
import { sanitizeHtml } from "@/lib/html";

/** بارگذاری فایل: ردیف‌ها خام ذخیره می‌شوند و دسته در وضعیت «پیش‌نویس» برای بازبینی می‌ماند */
export async function createBatchFromFile(team: TeamUser, input: { templateId: number; title: string; fileName: string; bytes: Uint8Array }): Promise<number> {
  const [tpl] = await db.select().from(templates).where(and(eq(templates.id, input.templateId), eq(templates.workspaceId, team.workspaceId)));
  if (!tpl) throw new MergeError("قالب یافت نشد");
  let sheet;
  try {
    sheet = parseSpreadsheet(input.bytes, input.fileName);
  } catch (e) {
    throw new MergeError(e instanceof Error ? e.message : "فایل خوانده نشد");
  }
  const title = (input.title || `ارسال انبوه ${tpl.title}`).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 120);
  const body = sanitizeHtml(tpl.body);
  const mapping = guessMapping(sheet.headers, detectPlaceholders(body, tpl.title));
  const options: MergeOptions = { ...DEFAULT_OPTIONS, contractTitle: tpl.title };
  const [batch] = await db
    .insert(mergeBatches)
    .values({ workspaceId: team.workspaceId, createdBy: team.id, title, fileName: input.fileName.slice(0, 120), templateId: tpl.id, bodyHtml: body, contractTitle: tpl.title, headers: JSON.stringify(sheet.headers), mapping: JSON.stringify(mapping), options: JSON.stringify(options) })
    .returning({ id: mergeBatches.id });
  const CHUNK = 250;
  for (let i = 0; i < sheet.rows.length; i += CHUNK) {
    await db.insert(mergeRows).values(
      sheet.rows.slice(i, i + CHUNK).map((r, j) => ({ batchId: batch.id, rowNo: i + j + 1, data: JSON.stringify(Object.fromEntries(sheet.headers.map((h, k) => [h, r[k] ?? ""]))) })),
    );
  }
  await logAudit({ action: "merge.created", workspaceId: team.workspaceId, userId: team.id, detail: `«${title}» — ${sheet.rows.length.toLocaleString("fa-IR")} ردیف${sheet.truncated ? " (بیش از سقف؛ بقیه نادیده گرفته شد)" : ""}` });
  return batch.id;
}
export async function getBatch(id: number, workspaceId: number): Promise<Batch | null> {
  const [b] = await db.select().from(mergeBatches).where(and(eq(mergeBatches.id, id), eq(mergeBatches.workspaceId, workspaceId)));
  return b ?? null;
}
export async function listBatches(workspaceId: number) {
  const rows = await db.select().from(mergeBatches).where(eq(mergeBatches.workspaceId, workspaceId)).orderBy(desc(mergeBatches.createdAt)).limit(50);
  const ids = rows.map((r) => r.id);
  const counts = ids.length ? await db.select({ batchId: mergeRows.batchId, status: mergeRows.status, n: sql<number>`count(*)::int` }).from(mergeRows).where(inArray(mergeRows.batchId, ids)).groupBy(mergeRows.batchId, mergeRows.status) : [];
  return rows.map((b) => {
    const c: Record<string, number> = {};
    for (const x of counts) if (x.batchId === b.id) c[x.status] = x.n;
    return { batch: b, counts: c, total: Object.values(c).reduce((s, n) => s + n, 0) };
  });
}
/** ردیف‌های «در حال ارسال» که بیش از ۱۰ دقیقه مانده‌اند (قطع سرور): برای جلوگیری از ارسال تکراری، «ناموفق/نیازمند بررسی» می‌شوند */
export async function reviveStuck(batchId: number) {
  await db
    .update(mergeRows)
    .set({ status: "failed", error: "ارسال نیمه‌کاره ماند (قطع سرور)؛ پیش از تلاش دوباره، فهرست قراردادها را بررسی کنید", updatedAt: new Date() })
    .where(and(eq(mergeRows.batchId, batchId), eq(mergeRows.status, "processing"), lt(mergeRows.updatedAt, new Date(Date.now() - 10 * 60_000))));
}
export async function batchStats(batchId: number): Promise<Record<string, number>> {
  const rows = await db.select({ status: mergeRows.status, n: sql<number>`count(*)::int` }).from(mergeRows).where(eq(mergeRows.batchId, batchId)).groupBy(mergeRows.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
export async function listBatchRows(batchId: number, opts: { status?: string; limit?: number; offset?: number } = {}) {
  return db
    .select({ row: mergeRows, number: contracts.number, cstatus: contracts.status })
    .from(mergeRows)
    .leftJoin(contracts, eq(contracts.id, mergeRows.contractId))
    .where(and(eq(mergeRows.batchId, batchId), ...(opts.status ? [eq(mergeRows.status, opts.status)] : [])))
    .orderBy(asc(mergeRows.rowNo))
    .limit(opts.limit ?? 300)
    .offset(opts.offset ?? 0);
}
export async function cancelBatch(team: TeamUser, batchId: number): Promise<number> {
  const batch = await getBatch(batchId, team.workspaceId);
  if (!batch || batch.status !== "running") throw new MergeError("فقط دسته‌ی در حال ارسال قابل لغو است");
  await db.update(mergeBatches).set({ status: "cancelled", completedAt: new Date() }).where(eq(mergeBatches.id, batchId));
  const r = await db.update(mergeRows).set({ status: "skipped", error: "با لغو دسته ارسال نشد", updatedAt: new Date() }).where(and(eq(mergeRows.batchId, batchId), eq(mergeRows.status, "queued"))).returning({ id: mergeRows.id });
  await logAudit({ action: "merge.cancelled", workspaceId: team.workspaceId, userId: team.id, detail: `«${batch.title}» — ${r.length.toLocaleString("fa-IR")} ردیف ارسال نشد` });
  return r.length;
}
/** تلاش دوباره‌ی ردیف‌های ناموفق (پس از رفع علت: ظرفیت طرح، اعتبار و …) */
export async function retryFailed(team: TeamUser, batchId: number): Promise<number> {
  const batch = await getBatch(batchId, team.workspaceId);
  if (!batch || batch.status === "draft") throw new MergeError("دسته یافت نشد");
  if (batch.status === "cancelled") throw new MergeError("دسته‌ی لغوشده را نمی‌توان دوباره ارسال کرد");
  const failed = await db.select().from(mergeRows).where(and(eq(mergeRows.batchId, batchId), eq(mergeRows.status, "failed"), sql`${mergeRows.contractId} is null`));
  if (failed.length === 0) throw new MergeError("ردیف ناموفقِ بدون قرارداد برای تلاش دوباره نیست");
  try {
    await assertCanIssue(team.workspaceId, failed.length);
  } catch (e) {
    throw new MergeError(e instanceof Error ? `${e.message}` : "ظرفیت طرح کافی نیست");
  }
  await db.update(mergeBatches).set({ status: "running", completedAt: null }).where(eq(mergeBatches.id, batchId));
  for (let i = 0; i < failed.length; i++) {
    const attempts = failed[i].attempts + 1;
    await db.update(mergeRows).set({ status: "queued", error: null, attempts, updatedAt: new Date() }).where(eq(mergeRows.id, failed[i].id));
    await enqueueJob("merge.row", { rowId: failed[i].id }, { dedupeKey: `merge-row:${failed[i].id}:${attempts}`, kick: i === failed.length - 1, maxAttempts: 1 });
  }
  await logAudit({ action: "merge.retried", workspaceId: team.workspaceId, userId: team.id, detail: `«${batch.title}» — ${failed.length.toLocaleString("fa-IR")} ردیف` });
  return failed.length;
}
export async function deleteBatch(team: TeamUser, batchId: number): Promise<void> {
  const batch = await getBatch(batchId, team.workspaceId);
  if (!batch) throw new MergeError("دسته یافت نشد");
  if (batch.status === "running") throw new MergeError("ابتدا ارسال را لغو کنید");
  // قراردادهای ساخته‌شده حفظ می‌شوند؛ فقط خودِ دسته و ردیف‌های گزارش حذف می‌شود
  await db.delete(mergeBatches).where(eq(mergeBatches.id, batchId));
}
