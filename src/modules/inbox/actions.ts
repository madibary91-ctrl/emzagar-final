"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/modules/auth/session";
import { deleteNotification, markRead } from "./service";

export async function markAllReadAction(): Promise<void> {
  const user = await requireUser();
  await markRead(user.id);
  revalidatePath("/notifications");
}

export async function markReadAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) await markRead(user.id, [id]);
  revalidatePath("/notifications");
}

export async function deleteNotificationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (Number.isInteger(id)) await deleteNotification(user.id, id);
  revalidatePath("/notifications");
}
