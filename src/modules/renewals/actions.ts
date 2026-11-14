"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { renewContract, setContractTerm } from "./service";

/** تاریخ میلادی ISO از ورودی date؛ خروجی null یعنی حذف زمان‌بندی */
export async function setTermAction(formData: FormData) {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) redirect("/admin");
  const raw = String(formData.get("termEnds") || "").trim();
  const clear = formData.get("clear") === "1";
  const days = Number(formData.get("termDays"));
  const notice = Number(formData.get("noticeDays")) || 30;
  let termEndsAt: Date | null = null;
  if (!clear) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) termEndsAt = new Date(`${raw}T12:00:00+03:30`);
    else if (Number.isFinite(days) && days > 0) termEndsAt = new Date(Date.now() + Math.min(days, 36500) * 86400000);
    else redirect(`/contracts/${id}?term_error=${encodeURIComponent("تاریخ پایان یا تعداد روز را وارد کنید")}#renewal`);
  }
  const r = await setContractTerm({ contractId: id, workspaceId: admin.workspaceId, actorId: admin.id, termEndsAt, noticeDays: notice });
  revalidatePath(`/contracts/${id}`);
  revalidatePath("/admin/renewals");
  if (!r.ok) redirect(`/contracts/${id}?term_error=${encodeURIComponent(r.error || "خطا")}#renewal`);
  redirect(`/contracts/${id}?term_saved=1#renewal`);
}

export async function renewContractAction(formData: FormData) {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) redirect("/admin");
  let newId = 0;
  try {
    newId = (await renewContract(id, admin.id, admin.workspaceId)).id;
  } catch {
    redirect(`/contracts/${id}?dup=failed`);
  }
  revalidatePath("/admin");
  revalidatePath("/admin/renewals");
  redirect(`/admin/contracts/${newId}/edit`);
}
