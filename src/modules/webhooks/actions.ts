"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookEndpoints } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { createEndpoint, sendTest, updateEndpoint } from "./service";
import { retryAllFailed, retryDeliveryNow } from "./retry";

export type WebhookState = {
  ok?: boolean;
  error?: string;
  /** فیلدی که خطا مربوط به آن است (برای فوکوس و علامت‌گذاری) */
  field?: string;
  /** کلید امضای تازه‌ساخته: فقط همین یک بار نمایش داده می‌شود */
  secret?: string;
  info?: string;
};

function inputOf(formData: FormData) {
  return {
    provider: String(formData.get("provider") || ""),
    name: String(formData.get("name") || ""),
    target: String(formData.get("target") || ""),
    secret: String(formData.get("secret") || ""),
    baseUrl: String(formData.get("baseUrl") || ""),
    events: formData.getAll("events").map(String),
  };
}

export async function saveWebhookAction(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const admin = await requireTeam("settings");
  const input = inputOf(formData);
  const r = await createEndpoint(admin.workspaceId, input);
  if (!r.ok) return { error: r.error, field: r.field };
  await logAudit({ workspaceId: admin.workspaceId, action: "webhook.saved", userId: admin.id, detail: `${input.name.trim().slice(0, 80)} (${input.provider})` });
  revalidatePath("/admin/webhooks");
  return { ok: true, secret: r.generatedSecret, info: r.generatedSecret ? "مقصد ذخیره شد. کلید امضای زیر را همین حالا کپی کنید؛ دوباره نمایش داده نمی‌شود." : "مقصد ذخیره شد. با دکمه‌ی «تست» اتصال را بررسی کنید." };
}

/** ویرایش مقصد (نام، آدرس/شناسه، توکن، رویدادها، چرخش کلید) بدون از دست رفتن تاریخچه و صف تلاش مجدد */
export async function updateWebhookAction(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "مقصد نامعتبر است" };
  const input = inputOf(formData);
  const r = await updateEndpoint(admin.workspaceId, id, { ...input, rotateSecret: formData.get("rotateSecret") === "on" });
  if (!r.ok) return { error: r.error, field: r.field };
  await logAudit({ workspaceId: admin.workspaceId, action: "webhook.saved", userId: admin.id, detail: `ویرایش #${id}${r.generatedSecret ? " (چرخش کلید)" : ""}` });
  revalidatePath("/admin/webhooks");
  return { ok: true, secret: r.generatedSecret, info: r.generatedSecret ? "کلید امضای تازه ساخته شد؛ همین حالا کپی کنید و در سمت گیرنده جایگزین کنید." : "تغییرات ذخیره شد. اگر ارسال‌هایی به‌خاطر اشتباه قبلی متوقف مانده‌اند، «تلاش دوباره‌ی همه» را بزنید." };
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

export async function testWebhookAction(id: number): Promise<{ ok: boolean; error?: string; raw?: string }> {
  const admin = await requireTeam("settings");
  if (!Number.isInteger(id)) return { ok: false, error: "شناسه نامعتبر" };
  const r = await sendTest(id, admin.workspaceId);
  revalidatePath("/admin/webhooks");
  return r;
}

/** تلاش دوباره‌ی دستی یک ارسال ناموفق/معلق */
export async function retryDeliveryAction(formData: FormData) {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return;
  await retryDeliveryNow(id, admin.workspaceId);
  revalidatePath("/admin/webhooks");
}

/** نسخه‌ی با بازخورد: نتیجه‌ی «تلاش دوباره» در همان ردیف نمایش داده می‌شود (فرم ساده هیچ بازخوردی نمی‌داد) */
export async function retryDeliveryStateAction(_prev: WebhookState, formData: FormData): Promise<WebhookState> {
  const admin = await requireTeam("settings");
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "ارسال نامعتبر است" };
  const r = await retryDeliveryNow(id, admin.workspaceId);
  revalidatePath("/admin/webhooks");
  return r.ok ? { ok: true, info: "ارسال شد ✓" } : { error: r.error };
}

/** تلاش دوباره‌ی همه‌ی ارسال‌های ناموفق قابل‌تلاش (بعد از اصلاح توکن/آدرس) */
export async function retryAllWebhooksAction(_prev: WebhookState, _formData: FormData): Promise<WebhookState> {
  const admin = await requireTeam("settings");
  const r = await retryAllFailed(admin.workspaceId);
  revalidatePath("/admin/webhooks");
  if (r.total === 0) return { ok: true, info: "ارسال ناموفقی برای تلاش دوباره وجود ندارد." };
  if (r.failed === 0) return { ok: true, info: `همه‌ی ${r.ok.toLocaleString("fa-IR")} ارسال با موفقیت انجام شد ✓` };
  return { error: `${r.ok.toLocaleString("fa-IR")} ارسال موفق، ${r.failed.toLocaleString("fa-IR")} ارسال هنوز ناموفق. مقصد را با «تست» بررسی کنید.` };
}
