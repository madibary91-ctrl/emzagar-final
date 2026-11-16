"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { requestResync, retryOutbox, rotateSyncSecret, sendPing, setSyncEnabled } from "./service";

const PATH = "/admin/woocommerce";
const idOf = (fd: FormData) => {
  const n = Number(fd.get("id"));
  return Number.isInteger(n) && n > 0 ? n : 0;
};

export async function retryOutboxAction(fd: FormData) {
  const t = await requireTeam("settings");
  await retryOutbox(t.workspaceId, idOf(fd) || undefined);
  revalidatePath(PATH);
}

export async function pingSiteAction(fd: FormData) {
  const t = await requireTeam("settings");
  const id = idOf(fd);
  if (id) await sendPing(t.workspaceId, id);
  revalidatePath(PATH);
}

export async function resyncSiteAction(fd: FormData) {
  const t = await requireTeam("settings");
  const id = idOf(fd);
  if (id && (await requestResync(t.workspaceId, id))) await logAudit({ workspaceId: t.workspaceId, userId: t.id, action: "apikey.created", detail: `درخواست هم‌ترازسازی کامل سایت #${id}` });
  revalidatePath(PATH);
}

export async function rotateSecretAction(fd: FormData) {
  const t = await requireTeam("settings");
  const id = idOf(fd);
  if (id) await rotateSyncSecret(t.workspaceId, id);
  revalidatePath(PATH);
}

export async function toggleSyncAction(fd: FormData) {
  const t = await requireTeam("settings");
  const id = idOf(fd);
  if (id) await setSyncEnabled(t.workspaceId, id, fd.get("enabled") === "1");
  revalidatePath(PATH);
}
