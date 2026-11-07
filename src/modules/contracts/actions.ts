"use server";

import { KycRequiredError } from "@/modules/kyc/service";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { cancelContract, duplicateContract, issueContract, publishDraft, removeContract, saveDraft, setArchived, updateContractMeta } from "./service";
import { restoreRevision } from "./revisions";
import { runBulk, type BulkOp, type BulkResult } from "./bulk";
import { remindContractNow } from "@/modules/automation/service";
import { db } from "@/db";
import { and, eq } from "drizzle-orm";
import { contracts, contractSigners } from "@/db/schema";
import { notifySigner } from "@/modules/signing/links";
import { logAudit } from "@/modules/audit/service";

export type IssueState = { error?: string };

/** صدور تکی و گروهی: برای هر مشتری انتخاب‌شده یک قرارداد مستقل با زنجیره‌ی امضای یکسان ساخته می‌شود */
export async function issueContractsAction(_prev: IssueState, formData: FormData): Promise<IssueState> {
  const admin = await requireTeam("write");
  const title = String(formData.get("title") || "").trim();
  const body = String(formData.get("body") || "").trim();
  const templateId = Number(formData.get("templateId")) || null;
  const customerIds = formData.getAll("customerId").map(Number).filter(Boolean);
  const labels = formData.getAll("signerLabel").map((v) => String(v).trim());
  const signerUsers = formData.getAll("signerUser").map(Number);
  const isDraft = formData.get("intent") === "draft";
  const expiryRaw = String(formData.get("expiryDays") ?? "").trim();
  const expiryDays = expiryRaw === "" ? undefined : Math.max(0, Math.min(3650, Number(expiryRaw) || 0));
  const tags = String(formData.get("tags") ?? "");
  const contractValue = Number(String(formData.get("contractValue") ?? "").replace(/[,٬\s]/g, "")) || null;

  if (!title) return { error: "عنوان قرارداد را وارد کنید" };
  if (body.replace(/<[^>]*>/g, "").trim().length < 10) return { error: "متن قرارداد خالی یا بسیار کوتاه است" };
  if (customerIds.length === 0) return { error: "حداقل یک کاربر را انتخاب کنید" };

  const extraSigners: { label: string; userId: number }[] = [];
  for (let i = 0; i < signerUsers.length; i++) {
    if (!signerUsers[i]) continue;
    extraSigners.push({ label: labels[i] || `امضاکننده ${i + 1}`, userId: signerUsers[i] });
  }

  let lastId = 0;
  try {
  for (const customerId of customerIds) {
    lastId = await issueContract({
      title,
      bodyHtml: body,
      templateId,
      customerId,
      extraSigners,
      workspaceId: admin.workspaceId,
      createdBy: admin.id,
      draft: isDraft,
      expiryDays,
      tags,
      contractValue,
    });
  }
  } catch (e) {
    return { error: e instanceof Error ? e.message : "خطا در صدور قرارداد" };
  }
  revalidatePath("/admin");
  if (isDraft) redirect(customerIds.length === 1 ? `/admin/contracts/${lastId}/edit` : "/admin?status=draft");
  redirect(customerIds.length === 1 ? `/contracts/${lastId}` : "/admin?issued=" + customerIds.length);
}

export async function deleteContractAction(formData: FormData) {
  const admin = await requireTeam("delete");
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) await removeContract(id, admin.id, admin.workspaceId);
  revalidatePath("/admin");
  redirect("/admin");
}

export type DraftState = { error?: string; saved?: boolean };

/** ذخیره یا انتشار پیش‌نویس از صفحه‌ی ویرایش */
export async function draftAction(_prev: DraftState, formData: FormData): Promise<DraftState> {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  const title = String(formData.get("title") || "").trim();
  const body = String(formData.get("body") || "").trim();
  const publish = formData.get("intent") === "publish";
  const expiryRaw = String(formData.get("expiryDays") ?? "").trim();
  const expiryDays = expiryRaw === "" ? undefined : Math.max(0, Math.min(3650, Number(expiryRaw) || 0));
  if (!Number.isInteger(id)) return { error: "قرارداد نامعتبر است" };
  if (!title) return { error: "عنوان قرارداد را وارد کنید" };
  if (body.replace(/<[^>]*>/g, "").trim().length < 10) return { error: "متن قرارداد خالی یا بسیار کوتاه است" };
  try {
    if (publish) await publishDraft(id, admin.id, { title, bodyHtml: body, expiryDays }, admin.workspaceId);
    else await saveDraft(id, admin.id, { title, bodyHtml: body }, admin.workspaceId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "خطا در ذخیره" };
  }
  revalidatePath("/admin");
  revalidatePath(`/contracts/${id}`);
  if (publish) redirect(`/contracts/${id}`);
  return { saved: true };
}

export async function cancelContractAction(formData: FormData) {
  const admin = await requireTeam("delete");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  try {
    await cancelContract(id, admin.id, String(formData.get("reason") || ""), admin.workspaceId);
  } catch {
    /* وضعیت قرارداد تغییر کرده است */
  }
  revalidatePath("/admin");
  revalidatePath(`/contracts/${id}`);
  redirect(`/contracts/${id}`);
}

/** یادآوری دستی برای امضاکننده‌ی فعلی */
export async function remindNowAction(formData: FormData) {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await remindContractNow(id, admin.id, admin.workspaceId);
  revalidatePath(`/contracts/${id}`);
  redirect(`/contracts/${id}?reminded=1`);
}

/** عملیات گروهی از لیست قراردادها (ارسال، یادآوری، لغو، حذف) */
export async function bulkContractsAction(op: BulkOp, ids: number[]): Promise<BulkResult> {
  const team = await requireTeam("view");
  const res = await runBulk(team, op, Array.isArray(ids) ? ids.map(Number) : []);
  revalidatePath("/admin");
  return res;
}

/** کپی قرارداد به‌صورت پیش‌نویس جدید و رفتن به صفحه‌ی ویرایش آن */
export async function duplicateContractAction(formData: FormData) {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) redirect("/admin");
  let newId = 0;
  try {
    newId = await duplicateContract(id, admin.id, admin.workspaceId);
  } catch {
    // مثلاً یکی از امضاکنندگان قبلی دیگر عضو این فضای کاری نیست
    redirect(`/contracts/${id}?dup=failed`);
  }
  revalidatePath("/admin");
  redirect(`/admin/contracts/${newId}/edit`);
}

/** ارسال مجدد لینک امضای امن (ایمیل + پیامک) برای امضاکننده‌ی فعلی */
export async function resendSigningLinkAction(formData: FormData) {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, admin.workspaceId), eq(contracts.status, "sent")));
  if (!c) redirect(`/contracts/${id}`);
  const pending = await db.select().from(contractSigners).where(and(eq(contractSigners.contractId, id), eq(contractSigners.status, "pending")));
  const turn = pending.sort((a, b) => a.position - b.position)[0];
  if (turn) {
    await notifySigner(id, turn.id, "reminder", { smsOverride: true });
    await logAudit({ action: "signlink.resent", contractId: id, userId: admin.id, detail: turn.label });
  }
  revalidatePath(`/contracts/${id}`);
  redirect(`/contracts/${id}?linksent=1`);
}

/** بایگانی / بازگردانی از بایگانی (فقط قراردادهای پایان‌یافته) */
export async function archiveContractAction(formData: FormData) {
  const team = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await setArchived(id, team.workspaceId, team.id, formData.get("archive") === "1");
  revalidatePath("/admin");
  revalidatePath(`/contracts/${id}`);
  redirect(`/contracts/${id}`);
}

/** ویرایش برچسب‌ها و ارزش قرارداد */
export async function updateMetaAction(formData: FormData) {
  const team = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const value = Number(String(formData.get("contractValue") ?? "").replace(/[,٬\s]/g, "")) || null;
  try {
    await updateContractMeta(id, team.workspaceId, team.id, { tags: String(formData.get("tags") ?? ""), value });
  } catch (e) {
    if (e instanceof KycRequiredError) redirect(`/admin/kyc?required=1`);
    throw e;
  }
  revalidatePath("/admin");
  revalidatePath(`/contracts/${id}`);
  redirect(`/contracts/${id}?meta=1`);
}

/** بازگردانی یک نسخه‌ی قدیمی در پیش‌نویس (از صفحه‌ی تاریخچه) */
export async function restoreRevisionAction(formData: FormData) {
  const team = await requireTeam("write");
  const id = Number(formData.get("id"));
  const version = Number(formData.get("version"));
  if (!Number.isInteger(id) || !Number.isInteger(version)) redirect("/admin");
  try {
    await restoreRevision(id, version, team.id, team.workspaceId);
  } catch (e) {
    redirect(`/admin/contracts/${id}/history?error=${encodeURIComponent(e instanceof Error ? e.message : "خطا")}`);
  }
  revalidatePath(`/contracts/${id}`);
  redirect(`/admin/contracts/${id}/edit`);
}
