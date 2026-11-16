"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { allowReconnectById, disconnectById, probeSite, type SiteProbe } from "./service";

export async function disconnectSiteAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await disconnectById(admin.workspaceId, id);
  await logAudit({ workspaceId: admin.workspaceId, userId: admin.id, action: "apikey.revoked", detail: `قطع اتصال سایت وردپرس #${id}` });
  revalidatePath("/admin/wordpress");
}

/** تست اتصال زنده‌ی یک سایت: در دسترس بودن، فعال بودن افزونه یا مسدود بودن مسیر توسط فایروال */
export async function probeSiteAction(id: number): Promise<SiteProbe | { state: "error"; title: string; hint: string }> {
  const admin = await requireTeam("settings");
  if (!Number.isInteger(id)) return { state: "error", title: "سایت نامعتبر است", hint: "" };
  const r = await probeSite(admin.workspaceId, id);
  return r ?? { state: "error", title: "سایت یافت نشد", hint: "" };
}

/** برداشتن قفل قطع‌شده توسط مدیر (بازگشت به حالت «خودترمیم» افزونه) */
export async function allowReconnectAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  if (await allowReconnectById(admin.workspaceId, id)) {
    await logAudit({ workspaceId: admin.workspaceId, userId: admin.id, action: "apikey.created", detail: `اجازه‌ی اتصال دوباره‌ی سایت وردپرس #${id}` });
  }
  revalidatePath("/admin/wordpress");
}
