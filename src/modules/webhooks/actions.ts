"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { assertSafeUrl, sendTest } from "./service";
import { EVENTS } from "./meta";

export type WebhookState = { ok?: boolean; error?: string };

export async function saveWebhookAction(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const admin = await requireTeam("settings");
  const provider = String(formData.get("provider") || "");
  const name = String(formData.get("name") || "").trim().slice(0, 80);
  const target = String(formData.get("target") || "").trim();
  const secret = String(formData.get("secret") || "").trim();
  const baseUrl = String(formData.get("baseUrl") || "").trim();
  const chosen = formData.getAll("events").map(String).filter((e) => EVENTS.some((x) => x.id === e && e !== "test"));

  if (!["telegram", "bale", "rubika", "generic"].includes(provider)) return { error: "نوع پیام‌رسان نامعتبر است" };
  if (!name) return { error: "نام مقصد را وارد کنید" };
  if (!target) return { error: provider === "generic" ? "آدرس وب‌هوک را وارد کنید" : "شناسه‌ی چت را وارد کنید" };

  if (provider === "generic") {
    try {
      await assertSafeUrl(target);
    } catch (e) {
      return { error: e instanceof Error ? e.message : "آدرس نامعتبر" };
    }
  } else {
    if (!/^[A-Za-z0-9:_\-.]{10,200}$/.test(secret)) return { error: "توکن ربات نامعتبر است" };
    if (!/^(-?\d{3,20}|@?[A-Za-z0-9_.-]{3,64})$/.test(target)) return { error: "شناسه‌ی چت نامعتبر است" };
    if (baseUrl) {
      try {
        await assertSafeUrl(baseUrl);
      } catch (e) {
        return { error: "آدرس پروکسی: " + (e instanceof Error ? e.message : "نامعتبر") };
      }
    }
  }
  await db.insert(webhookEndpoints).values({
    workspaceId: admin.workspaceId,
    name,
    provider,
    target,
    secret,
    baseUrl: provider === "generic" ? "" : baseUrl,
    events: chosen.length === 0 || chosen.length === EVENTS.length - 1 ? "*" : chosen.join(","),
  });
  await logAudit({ workspaceId: admin.workspaceId, action: "webhook.saved", userId: admin.id, detail: `${name} (${provider})` });
  revalidatePath("/admin/webhooks");
  return { ok: true };
}

export async function toggleWebhookAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  const [ep] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, admin.workspaceId)));
  if (!ep) return;
  await db.update(webhookEndpoints).set({ active: !ep.active }).where(eq(webhookEndpoints.id, id));
  revalidatePath("/admin/webhooks");
}

export async function deleteWebhookAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, admin.workspaceId)));
  await logAudit({ workspaceId: admin.workspaceId, action: "webhook.deleted", userId: admin.id, detail: String(id) });
  revalidatePath("/admin/webhooks");
}

export async function testWebhookAction(id: number): Promise<{ ok: boolean; error?: string }> {
  const admin = await requireTeam("settings");
  if (!Number.isInteger(id)) return { ok: false, error: "شناسه نامعتبر" };
  const r = await sendTest(id, admin.workspaceId);
  revalidatePath("/admin/webhooks");
  return r;
}
