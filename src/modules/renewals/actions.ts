"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { renewContract, setContractTerm } from "./service";
import { parseLooseInt } from "@/lib/numbers";

const termBack = (id: number, msg: string): never => redirect(`/contracts/${id}?term_error=${encodeURIComponent(msg)}#renewal`);

/** تاریخ میلادی ISO از ورودی date؛ خروجی null یعنی حذف زمان‌بندی */
export async function setTermAction(formData: FormData) {
  const admin = await requireTeam("write");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) redirect("/admin");
  const raw = String(formData.get("termEnds") || "").trim();
  const clear = formData.get("clear") === "1";
  const daysP = parseLooseInt(formData.get("termDays"), { label: "تعداد روز", min: 1, max: 36500 });
  const noticeP = parseLooseInt(formData.get("noticeDays"), { label: "یادآوری (روز قبل)", min: 1, max: 365 });
  // ورودی نامعتبر (مثلاً حروف) نباید بی‌صدا به «۳۰ روز» تبدیل شود
  if (!clear && !noticeP.ok) termBack(id, noticeP.error);
  const notice = (noticeP.ok ? noticeP.value : null) ?? 30;
  let termEndsAt: Date | null = null;
  if (!clear) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) termEndsAt = new Date(`${raw}T12:00:00+03:30`);
    else if (daysP.ok && daysP.value) termEndsAt = new Date(Date.now() + daysP.value * 86400000);
    else if (!daysP.ok) termBack(id, daysP.error);
    else termBack(id, "تاریخ پایان را از تقویم انتخاب کنید (یا تعداد روز را وارد کنید)");
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
