"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { generateKey } from "./service";
import { ALL_SCOPES, DEFAULT_KEY_LIFETIME_DAYS, DEFAULT_NEW_KEY_SCOPES, MAX_KEY_LIFETIME_DAYS, serializeScopes } from "./scopes";
import { parseIpAllowlist } from "./ip-allowlist";

export type KeyState = { error?: string; plain?: string };

export async function createKeyAction(_prev: KeyState, formData: FormData): Promise<KeyState> {
  const admin = await requireTeam("settings");
  const name = String(formData.get("name") || "").trim().slice(0, 60);
  if (!name) return { error: "نام کلید را وارد کنید" };
  // M-05: دامنه‌ی دسترسی صریح (حداقل یکی). بدون انتخاب ← فقط خواندن.
  const picked = formData.getAll("scope").map(String).filter((x) => (ALL_SCOPES as string[]).includes(x));
  const scopes = serializeScopes(picked.length ? picked : DEFAULT_NEW_KEY_SCOPES);
  // M-05: انقضا اجباری و حداکثر ۳۶۶ روز
  const daysRaw = Number(formData.get("expiryDays") || DEFAULT_KEY_LIFETIME_DAYS);
  const days = Number.isFinite(daysRaw) ? Math.min(MAX_KEY_LIFETIME_DAYS, Math.max(1, Math.floor(daysRaw))) : DEFAULT_KEY_LIFETIME_DAYS;
  const ips = parseIpAllowlist(String(formData.get("allowedIps") || ""));
  if (ips.invalid.length) return { error: `IP/CIDR نامعتبر: ${ips.invalid.slice(0, 3).join("، ")}` };
  const k = generateKey();
  await db.insert(apiKeys).values({
    workspaceId: admin.workspaceId,
    name,
    prefix: k.prefix,
    keyHash: k.hash,
    createdBy: admin.id,
    scopes,
    expiresAt: new Date(Date.now() + days * 86400_000),
    allowedIps: ips.entries.join(","),
  });
  await logAudit({ workspaceId: admin.workspaceId, action: "apikey.created", userId: admin.id, detail: `${name} (${k.prefix}…) scopes=${scopes} expires=${days}d${ips.entries.length ? ` ips=${ips.entries.join("|")}` : ""}` });
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
