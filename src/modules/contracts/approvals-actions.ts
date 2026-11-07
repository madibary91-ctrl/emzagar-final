"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { decideApproval, removeApproval, requestApprovals } from "./approvals";

/** فقط مسیرهای داخلی همین برنامه برای بازگشت پذیرفته می‌شود (جلوگیری از Open Redirect) */
function backTo(formData: FormData, id: number): string {
  const raw = String(formData.get("returnTo") || "");
  const ok = new RegExp(`^/(contracts|admin/contracts)/${id}(/edit)?$`).test(raw);
  return ok ? raw : `/contracts/${id}`;
}

function done(path: string, params: Record<string, string>): never {
  const qs = new URLSearchParams(params).toString();
  redirect(`${path}?${qs}#approvals`);
}

export async function requestApprovalAction(formData: FormData) {
  const team = await requireTeam("write");
  const id = Number(formData.get("id"));
  const path = backTo(formData, id);
  const approvers = formData.getAll("approver").map(Number);
  try {
    const n = await requestApprovals(id, team.workspaceId, approvers, team.id);
    revalidatePath(`/contracts/${id}`);
    done(path, { approval: `requested:${n}` });
  } catch (e) {
    if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
    if (typeof (e as { digest?: string })?.digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")) throw e;
    done(path, { approval_error: e instanceof Error ? e.message : "خطا در ثبت درخواست" });
  }
}

export async function decideApprovalAction(formData: FormData) {
  const team = await requireTeam("view");
  const id = Number(formData.get("id"));
  const path = backTo(formData, id);
  const decision = formData.get("decision") === "approved" ? "approved" : "changes_requested";
  try {
    await decideApproval(id, team.workspaceId, team.id, decision, String(formData.get("note") || ""));
    revalidatePath(`/contracts/${id}`);
    done(path, { approval: decision });
  } catch (e) {
    if (typeof (e as { digest?: string })?.digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")) throw e;
    done(path, { approval_error: e instanceof Error ? e.message : "خطا در ثبت تصمیم" });
  }
}

export async function removeApprovalAction(formData: FormData) {
  const team = await requireTeam("write");
  const id = Number(formData.get("id"));
  const path = backTo(formData, id);
  try {
    await removeApproval(id, team.workspaceId, Number(formData.get("approverId")), team.id);
    revalidatePath(`/contracts/${id}`);
    done(path, { approval: "removed" });
  } catch (e) {
    if (typeof (e as { digest?: string })?.digest === "string" && (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")) throw e;
    done(path, { approval_error: e instanceof Error ? e.message : "خطا" });
  }
}
