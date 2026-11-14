import { amendmentSigners, auditLogs, contractAmendments, contractApprovals, contractComments, contractFieldValues, contractRevisions, contractSigners, contracts, otpCodes, shortLinks, signingLinks } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertKycForValue } from "@/modules/kyc/service";
import { db } from "@/db";
import { deleteAllAttachments } from "@/modules/attachments/service";
import { deleteContractDocument } from "@/modules/pdf/service";
import { deleteSignatureFile } from "@/modules/signing/storage";
import { logAudit } from "@/modules/audit/service";
import { normalizeTags } from "./core";
import { removeSourceFiles } from "@/modules/docs/service";

const ARCHIVABLE = ["signed", "rejected", "expired", "cancelled"];
/** انتقال به بایگانی یا بازگردانی؛ فقط قراردادهای پایان‌یافته. بایگانی چیزی را حذف نمی‌کند و همه‌ی سوابق می‌ماند. */
export async function setArchived(id: number, workspaceId: number, userId: number, archived: boolean): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) return false;
  if (archived && (!ARCHIVABLE.includes(c.status) || c.archivedAt)) return false;
  if (!archived && !c.archivedAt) return false;
  await db.update(contracts).set({ archivedAt: archived ? new Date() : null }).where(eq(contracts.id, id));
  await logAudit({ action: archived ? "contract.archived" : "contract.unarchived", contractId: id, userId, workspaceId, detail: c.number });
  return true;
}
/** ویرایش برچسب‌ها و ارزش مالی (متن قرارداد را تغییر نمی‌دهد؛ در هر وضعیتی مجاز است) */
export async function updateContractMeta(id: number, workspaceId: number, userId: number, input: { tags: string; value: number | null }): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) return false;
  const tags = normalizeTags(input.tags);
  const value = input.value && input.value > 0 ? Math.min(Math.round(input.value), 2_000_000_000) : null;
  // بالا بردن ارزش قرارداد منتشرشده نباید راهی برای دور زدن احراز هویت باشد
  if (c.status !== "draft" && value && value > (c.contractValue ?? 0)) await assertKycForValue(workspaceId, value);
  await db.update(contracts).set({ tags, contractValue: value }).where(eq(contracts.id, id));
  await logAudit({ action: "contract.meta_updated", contractId: id, userId, workspaceId, detail: `${c.number} — برچسب‌ها: ${tags || "—"}${value ? ` • ارزش: ${value.toLocaleString("fa-IR")} تومان` : ""}` });
  return true;
}
export async function removeContract(id: number, adminId: number, workspaceId: number): Promise<boolean> {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!c) return false;
  const signers = await db.select().from(contractSigners).where(eq(contractSigners.contractId, id));
  for (const s of signers) for (const f of [s.signatureFile, s.sealFile, s.initialsFile]) if (f) await deleteSignatureFile(f);
  await db.delete(otpCodes).where(eq(otpCodes.contractId, id));
  await removeSourceFiles(id);
  await deleteContractDocument(id);
  await deleteAllAttachments(id);
  await db.delete(contractFieldValues).where(eq(contractFieldValues.contractId, id));
  await db.delete(contractRevisions).where(eq(contractRevisions.contractId, id));
  await db.delete(contractComments).where(eq(contractComments.contractId, id));
  await db.delete(contractApprovals).where(eq(contractApprovals.contractId, id));
  const ams = await db.select({ id: contractAmendments.id }).from(contractAmendments).where(eq(contractAmendments.contractId, id));
  if (ams.length) await db.delete(amendmentSigners).where(inArray(amendmentSigners.amendmentId, ams.map((a) => a.id)));
  await db.delete(contractAmendments).where(eq(contractAmendments.contractId, id));
  await db.delete(signingLinks).where(eq(signingLinks.contractId, id));
  await db.delete(shortLinks).where(eq(shortLinks.contractId, id));
  await db.delete(contractSigners).where(eq(contractSigners.contractId, id));
  await db.delete(contracts).where(eq(contracts.id, id));
  // لاگ‌های قبلی حفظ می‌شوند تا قابل پیگیری بمانند
  await db.update(auditLogs).set({ detail: sql`${auditLogs.detail} || ' [قرارداد حذف شد]'` }).where(and(eq(auditLogs.contractId, id), eq(auditLogs.action, "contract.issued")));
  await logAudit({ action: "contract.deleted", workspaceId, contractId: id, userId: adminId, detail: c.number });
  return true;
}
