"use server";

import { revalidatePath } from "next/cache";
import { logAudit } from "@/modules/audit/service";
import { requireTeam } from "@/modules/tenancy/context";
import type { TeamState } from "@/modules/tenancy/actions";
import { ensureGuestSigner, GuestError } from "./service";

/** افزودن امضاکننده‌ی مهمان به دفترچه‌ی مشتریان (فقط نام + موبایل؛ بدون ایمیل، رمز یا ثبت‌نام) */
export async function addGuestAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const admin = await requireTeam("write");
  try {
    const r = await ensureGuestSigner(admin.workspaceId, {
      name: String(formData.get("name") || ""),
      mobile: String(formData.get("mobile") || ""),
    });
    if (!r.created) return { error: "این امضاکننده‌ی مهمان قبلاً با همین نام و موبایل ثبت شده است" };
    await logAudit({ action: "guest.added", workspaceId: admin.workspaceId, userId: admin.id, detail: `#${r.userId}` });
    revalidatePath("/admin/customers");
    return { ok: true, message: "امضاکننده‌ی مهمان اضافه شد. حالا می‌توانید برایش قرارداد صادر کنید." };
  } catch (e) {
    return { error: e instanceof GuestError ? e.message : "ثبت امضاکننده‌ی مهمان انجام نشد" };
  }
}
