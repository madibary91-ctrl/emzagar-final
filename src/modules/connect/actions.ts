"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { disconnectById } from "./service";

export async function disconnectSiteAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await disconnectById(admin.workspaceId, id);
  await logAudit({ workspaceId: admin.workspaceId, userId: admin.id, action: "apikey.revoked", detail: `قطع اتصال سایت وردپرس #${id}` });
  revalidatePath("/admin/wordpress");
}
