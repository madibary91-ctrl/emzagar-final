"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { generateKey } from "./service";

export type KeyState = { error?: string; plain?: string };

export async function createKeyAction(_prev: KeyState, formData: FormData): Promise<KeyState> {
  const admin = await requireTeam("settings");
  const name = String(formData.get("name") || "").trim().slice(0, 60);
  if (!name) return { error: "نام کلید را وارد کنید" };
  const k = generateKey();
  await db.insert(apiKeys).values({ workspaceId: admin.workspaceId, name, prefix: k.prefix, keyHash: k.hash, createdBy: admin.id });
  await logAudit({ workspaceId: admin.workspaceId, action: "apikey.created", userId: admin.id, detail: `${name} (${k.prefix}…)` });
  revalidatePath("/admin/api");
  // کلید فقط همین یک بار نمایش داده می‌شود؛ در دیتابیس فقط هش آن ذخیره است
  return { plain: k.plain };
}

export async function revokeKeyAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, admin.workspaceId)));
  await logAudit({ workspaceId: admin.workspaceId, action: "apikey.revoked", userId: admin.id, detail: String(id) });
  revalidatePath("/admin/api");
}
