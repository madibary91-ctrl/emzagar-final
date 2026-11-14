"use server";

import { KycRequiredError } from "@/modules/kyc/service";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { approveOwnPendingOnPublish } from "./approvals";
import { cancelContract, duplicateContract, issueContract, publishDraft, removeContract, saveDraft, setArchived, updateContractMeta } from "./service";
import { restoreRevision } from "./revisions";
import { runBulk, type BulkOp, type BulkResult } from "./bulk";
import { remindContractNow } from "@/modules/automation/service";
import { db } from "@/db";
import { and, eq } from "drizzle-orm";
import { contracts, contractSigners } from "@/db/schema";
import { notifySigner } from "@/modules/signing/links";
import { logAudit } from "@/modules/audit/service";
import { ensureGuestSigner, GuestError } from "@/modules/guests/service";
import { parseIdentityReq } from "@/modules/identity/rules";
import { currentStageSigners, parseSigningMode, type WitnessTiming } from "@/modules/signing/stages";
import type { SignerSpec } from "./service";

/** بخش «برنامه‌ی امضا» که رابط به‌صورت یک JSON در فیلد signingPlan می‌فرستد (شیوه‌ی امضا، شاهدها، شرکت/مهر/پاراف هر طرف) */
interface PlanWire {
  mode?: string;
  witnessTiming?: string;
  parties?: Record<string, unknown>[];
  customer?: Record<string, unknown>;
  witnesses?: { label?: string; userId?: string | number; name?: string; mobile?: string; initials?: boolean }[];
}

function parsePlan(raw: FormDataEntryValue | null): PlanWire {
  if (typeof raw !== "string" || !raw || raw.length > 20_000) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as PlanWire) : {};
  } catch {
    return {};
  }
}

function specOf(w: Record<string, unknown> | undefined): SignerSpec {
  if (!w) return {};
  const legal = w.legal === true || w.signerType === "legal";
  return {
    stage: Number(w.stage) || null,
    signerType: legal ? "legal" : "natural",
    companyName: String(w.companyName ?? ""),
    companyNationalId: String(w.companyNationalId ?? ""),
    signatoryTitle: String(w.signatoryTitle ?? ""),
    sealRequired: legal && w.sealRequired === true,
    initialsRequired: w.initialsRequired === true,
  };
}

export type IssueState = { error?: string };

/** صدور تکی و گروهی: برای هر مشتری انتخاب‌شده یک قرارداد مستقل با زنجیره‌ی امضای یکسان ساخته می‌شود */
export async function issueContractsAction(_prev: IssueState, formData: FormData): Promise<IssueState> {
  const admin = await requireTeam("write");
  const title = String(formData.get("title") || "").trim();
  const body = String(formData.get("body") || "").trim();
  const templateId = Number(formData.get("templateId")) || null;
  const customerIds = formData.getAll("customerId").map(Number).filter(Boolean);
  // گیرندگان مهمان (بدون حساب کاربری): فقط نام + موبایل؛ همین‌جا به هویت سبک مهمان تبدیل می‌شوند
  const guestNames = formData.getAll("guestName").map((v) => String(v));
  const guestMobiles = formData.getAll("guestMobile").map((v) => String(v));
  const labels = formData.getAll("signerLabel").map((v) => String(v).trim());
  const signerUsers = formData.getAll("signerUser").map(Number);
  const isDraft = formData.get("intent") === "draft";
  const expiryRaw = String(formData.get("expiryDays") ?? "").trim();
  const expiryDays = expiryRaw === "" ? undefined : Math.max(0, Math.min(3650, Number(expiryRaw) || 0));
  const tags = String(formData.get("tags") ?? "");
  const contractValue = Number(String(formData.get("contractValue") ?? "").replace(/[,٬\s]/g, "")) || null;

  if (!title) return { error: "عنوان قرارداد را وارد کنید" };
  if (body.replace(/<[^>]*>/g, "").trim().length < 10) return { error: "متن قرارداد خالی یا بسیار کوتاه است" };

  try {
    for (let i = 0; i < guestNames.length; i++) {
      if (!guestNames[i].trim() && !(guestMobiles[i] ?? "").trim()) continue; // ردیف خالی
      const g = await ensureGuestSigner(admin.workspaceId, { name: guestNames[i], mobile: guestMobiles[i] ?? "" });
      if (!customerIds.includes(g.userId)) customerIds.push(g.userId);
    }
  } catch (e) {
    return { error: e instanceof GuestError ? e.message : "ثبت امضاکننده‌ی مهمان انجام نشد" };
  }
  if (customerIds.length === 0) return { error: "حداقل یک گیرنده انتخاب کنید یا نام و موبایل یک امضاکننده‌ی مهمان را وارد کنید" };

  // امضاکنندگان میانی: عضو تیم/مشتری ثبت‌شده، یا «مهمان» با نام و موبایل (signerUser = "guest")
  const signerRaw = formData.getAll("signerUser").map((v) => String(v));
  const signerGuestNames = formData.getAll("signerGuestName").map((v) => String(v));
  const signerGuestMobiles = formData.getAll("signerGuestMobile").map((v) => String(v));
  const plan = parsePlan(formData.get("signingPlan"));
  const extraSigners: (SignerSpec & { label: string; userId: number })[] = [];
  for (let i = 0; i < signerRaw.length; i++) {
    const label = labels[i] || `امضاکننده ${i + 1}`;
    if (signerRaw[i] === "guest") {
      try {
        const g = await ensureGuestSigner(admin.workspaceId, { name: signerGuestNames[i] ?? "", mobile: signerGuestMobiles[i] ?? "" });
        extraSigners.push({ label, userId: g.userId, ...specOf(plan.parties?.[i]) });
      } catch (e) {
        return { error: e instanceof GuestError ? `${label}: ${e.message}` : "ثبت امضاکننده‌ی مهمان انجام نشد" };
      }
      continue;
    }
    if (!signerUsers[i]) continue;
    extraSigners.push({ label, userId: signerUsers[i], ...specOf(plan.parties?.[i]) });
  }

  // شاهدها: عضو ثبت‌شده یا مهمان (نام + موبایل). فقط گواهی می‌دهند و پس از طرف‌ها (یا هم‌زمان با آخرین مرحله) امضا می‌کنند
  const witnesses: { label?: string; userId: number; initialsRequired?: boolean }[] = [];
  for (const [i, w] of (plan.witnesses ?? []).slice(0, 6).entries()) {
    const label = String(w.label ?? "").trim().slice(0, 40) || `شاهد ${i + 1}`;
    try {
      if (w.userId === "guest" || w.userId === undefined || w.userId === "") {
        if (!String(w.name ?? "").trim() && !String(w.mobile ?? "").trim()) continue; // ردیف خالی
        const g = await ensureGuestSigner(admin.workspaceId, { name: String(w.name ?? ""), mobile: String(w.mobile ?? "") });
        witnesses.push({ label, userId: g.userId, initialsRequired: w.initials === true });
      } else if (Number(w.userId)) witnesses.push({ label, userId: Number(w.userId), initialsRequired: w.initials === true });
    } catch (e) {
      return { error: e instanceof GuestError ? `${label}: ${e.message}` : "ثبت شاهد انجام نشد" };
    }
  }
  const witnessTiming: WitnessTiming = plan.witnessTiming === "together" ? "together" : "after";

  // احراز هویت اختیاری امضاکننده‌ی مشتری. «کد ملی مورد انتظار» فقط وقتی معنا دارد که دقیقاً یک گیرنده باشد
  const identityReq = parseIdentityReq(formData.get("identityReq"));
  const expectedNc = customerIds.length === 1 ? String(formData.get("expectedNc") || "") : "";
  const identity = identityReq === "none" ? undefined : { req: identityReq, expectedNc };

  let lastId = 0;
  try {
  for (const customerId of customerIds) {
    lastId = await issueContract({
      identity,
      title,
      bodyHtml: body,
      templateId,
      customerId,
      extraSigners,
      // در صدور گروهی، مشخصات «شرکت» یک مشتری معنا ندارد؛ فقط پاراف همه‌گیر می‌شود
      customerSpec: customerIds.length === 1 ? specOf(plan.customer) : { stage: Number(plan.customer?.stage) || null, initialsRequired: plan.customer?.initialsRequired === true },
      witnesses,
      witnessTiming,
      signingMode: parseSigningMode(plan.mode),
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
  // هر دو منبع (فیلد مخفی و دکمه‌ی ارسال‌کننده) بررسی می‌شود؛ وجود «publish» در هرکدام یعنی انتشار
  const publish = formData.getAll("intent").some((v) => v === "publish");
  const expiryRaw = String(formData.get("expiryDays") ?? "").trim();
  const expiryDays = expiryRaw === "" ? undefined : Math.max(0, Math.min(3650, Number(expiryRaw) || 0));
  if (!Number.isInteger(id)) return { error: "قرارداد نامعتبر است" };
  if (!title) return { error: "عنوان قرارداد را وارد کنید" };
  if (body.replace(/<[^>]*>/g, "").trim().length < 10) return { error: "متن قرارداد خالی یا بسیار کوتاه است" };
  try {
    if (publish) {
      // ۱) متن فرم ذخیره می‌شود (اگر تغییری بوده، تأییدهای قبلی درست همان‌جا باطل می‌شوند)
      await saveDraft(id, admin.id, { title, bodyHtml: body }, admin.workspaceId);
      // ۲) انتشار توسط کسی که خودش تأییدکننده است = تأیید همین نسخه؛ تأیید دیگران همچنان لازم است
      await approveOwnPendingOnPublish(id, admin.workspaceId, admin.id);
      try {
        await publishDraft(id, admin.id, { title, bodyHtml: body, expiryDays }, admin.workspaceId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "خطا در انتشار";
        // متن از قبل ذخیره شده است؛ کاربر باید بداند انتشار چرا انجام نشد (نه فقط «ذخیره شد»)
        return { error: `تغییرات به‌صورت پیش‌نویس ذخیره شد، اما انتشار انجام نشد. ${msg}` };
      }
    } else await saveDraft(id, admin.id, { title, bodyHtml: body }, admin.workspaceId);
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
  // امضای هم‌زمان: لینک برای همه‌ی اعضای مرحله‌ی فعلی ارسال می‌شود
  for (const turn of currentStageSigners(pending)) {
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
