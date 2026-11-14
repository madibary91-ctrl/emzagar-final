import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import type { TeamUser } from "@/modules/tenancy/context";
import { can, type Permission } from "@/modules/tenancy/roles";
import { logAudit } from "@/modules/audit/service";
import { remindContractNow } from "@/modules/automation/service";
import { approveOwnPendingOnPublish } from "./approvals";
import { cancelContract, publishDraft, removeContract, setArchived } from "./service";

export type BulkOp = "publish" | "remind" | "cancel" | "delete" | "archive";

export const BULK_LABELS: Record<BulkOp, string> = {
  publish: "ارسال (انتشار پیش‌نویس)",
  remind: "ارسال یادآوری",
  cancel: "لغو",
  delete: "حذف",
  archive: "بایگانی",
};

/** هر عملیات به یک سطح دسترسی نیاز دارد؛ عملیات مخرب فقط برای مدیر/مالک */
const REQUIRED: Record<BulkOp, Permission> = { publish: "write", remind: "write", cancel: "delete", delete: "delete", archive: "write" };

export const MAX_BULK = 200;

export interface BulkResult {
  ok: boolean;
  op: BulkOp;
  done: number;
  skipped: number;
  failed: number;
  error?: string;
}

/**
 * اجرای عملیات گروهی روی قراردادهای انتخاب‌شده.
 * شناسه‌هایی که متعلق به فضای کاری کاربر نیستند اصلاً بارگذاری نمی‌شوند (بدون نشت اطلاعات)،
 * و مواردی که وضعیتشان با عملیات سازگار نیست «رد شده» (skipped) محسوب می‌شوند نه خطا.
 */
export async function runBulk(team: TeamUser, op: BulkOp, rawIds: number[]): Promise<BulkResult> {
  const base = { op, done: 0, skipped: 0, failed: 0 };
  if (!REQUIRED[op]) return { ...base, ok: false, error: "عملیات نامعتبر است" };
  if (!can(team.wsRole, REQUIRED[op])) return { ...base, ok: false, error: "برای این عملیات دسترسی ندارید" };
  const ids = [...new Set(rawIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return { ...base, ok: false, error: "هیچ قراردادی انتخاب نشده است" };
  if (ids.length > MAX_BULK) return { ...base, ok: false, error: `حداکثر ${MAX_BULK} قرارداد در هر عملیات` };

  const rows = await db
    .select()
    .from(contracts)
    .where(and(inArray(contracts.id, ids), eq(contracts.workspaceId, team.workspaceId)));
  let done = 0;
  let skipped = ids.length - rows.length;
  let failed = 0;

  for (const c of rows) {
    try {
      if (op === "publish") {
        if (c.status !== "draft") skipped++;
        else {
          await approveOwnPendingOnPublish(c.id, team.workspaceId, team.id);
          await publishDraft(c.id, team.id, { title: c.title, bodyHtml: c.bodyHtml }, team.workspaceId);
          done++;
        }
      } else if (op === "remind") {
        if (c.status !== "sent") skipped++;
        else if (await remindContractNow(c.id, team.id, team.workspaceId)) done++;
        else skipped++;
      } else if (op === "cancel") {
        if (c.status !== "sent") skipped++;
        else {
          await cancelContract(c.id, team.id, "لغو گروهی", team.workspaceId);
          done++;
        }
      } else if (op === "archive") {
        if (await setArchived(c.id, team.workspaceId, team.id, true)) done++;
        else skipped++;
      } else if (op === "delete") {
        if (await removeContract(c.id, team.id, team.workspaceId)) done++;
        else skipped++;
      }
    } catch {
      failed++;
    }
  }

  await logAudit({
    action: "contract.bulk",
    workspaceId: team.workspaceId,
    userId: team.id,
    detail: `${BULK_LABELS[op]} — موفق: ${done}، ردشده: ${skipped}، ناموفق: ${failed}`,
  });
  return { ok: true, op, done, skipped, failed };
}
