import { type RegisterInput, clean } from "./core";
import { and, desc, eq } from "drizzle-orm";
import { apiKeys, wpConnections } from "@/db/schema";
import { db } from "@/db";
import { logAudit } from "@/modules/audit/service";

/* ───────────── پس از اتصال: وضعیت، ضربان، قطع ───────────── */

export async function connectionForKey(keyId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.apiKeyId, keyId), eq(wpConnections.status, "active")));
  return c ?? null;
}
export async function heartbeat(keyId: number, meta: Partial<Pick<RegisterInput, "pluginVersion" | "wpVersion" | "wcActive" | "locale" | "siteName">>) {
  const c = await connectionForKey(keyId);
  if (!c) return null;
  await db
    .update(wpConnections)
    .set({
      lastSeenAt: new Date(),
      pluginVersion: clean(meta.pluginVersion, 20) || c.pluginVersion,
      wpVersion: clean(meta.wpVersion, 20) || c.wpVersion,
      wcActive: typeof meta.wcActive === "boolean" ? meta.wcActive : c.wcActive,
      locale: clean(meta.locale, 20) || c.locale,
      siteName: clean(meta.siteName, 60) || c.siteName,
    })
    .where(eq(wpConnections.id, c.id));
  return c;
}
export async function disconnectByKey(keyId: number, workspaceId: number) {
  const c = await connectionForKey(keyId);
  if (c) await db.update(wpConnections).set({ status: "disconnected" }).where(eq(wpConnections.id, c.id));
  await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, keyId), eq(apiKeys.workspaceId, workspaceId)));
  await logAudit({ action: "apikey.revoked", workspaceId, detail: `قطع اتصال وردپرس ${c?.siteHost ?? ""}`, actor: "wp-connect" });
}
/**
 * قطع اتصال «توسط مدیر» از پنل. وضعیت `revoked` (نه `disconnected`) ثبت می‌شود تا افزونه‌ی وردپرس
 * (که با ابطال کلید خودترمیم می‌شود و ظرف چند ثانیه دوباره وصل می‌شد) نتواند بی‌اجازه دوباره وصل شود.
 * بازگشت فقط با «اجازه‌ی اتصال دوباره» از پنل یا دانلود تازه‌ی افزونه (کد جفت‌سازی) ممکن است.
 */
export async function disconnectById(workspaceId: number, connId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return;
  await db.update(wpConnections).set({ status: "revoked" }).where(eq(wpConnections.id, c.id));
  if (c.apiKeyId) await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, c.apiKeyId), eq(apiKeys.workspaceId, workspaceId)));
}
/** برداشتن قفل «قطع توسط مدیر»: افزونه در تلاش بعدی (یا با «اتصال دوباره» در وردپرس) خودکار وصل می‌شود */
export async function allowReconnectById(workspaceId: number, connId: number): Promise<boolean> {
  const done = await db
    .update(wpConnections)
    .set({ status: "disconnected" })
    .where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId), eq(wpConnections.status, "revoked")))
    .returning({ id: wpConnections.id });
  return done.length > 0;
}
export async function listConnections(workspaceId: number) {
  return db.select().from(wpConnections).where(eq(wpConnections.workspaceId, workspaceId)).orderBy(desc(wpConnections.createdAt));
}

/**
 * H-02/H-03: مالکیت یک ایمیل تأییدنشده دست‌به‌دست می‌شود (یا کاربر از اتصال خودکار ساخته شده بوده): همه‌ی اتصال‌های وردپرس
 * و کلیدهای API که این کاربر مالک آن‌هاست باطل می‌شوند تا مهاجمی که پیش‌تر کلید گرفته، دسترسی ماندگار نداشته باشد.
 */
export async function revokeOwnedConnections(userId: number): Promise<number> {
  const conns = await db.select().from(wpConnections).where(and(eq(wpConnections.ownerUserId, userId), eq(wpConnections.status, "active")));
  for (const c of conns) {
    await db.update(wpConnections).set({ status: "disconnected" }).where(eq(wpConnections.id, c.id));
    if (c.apiKeyId) await db.update(apiKeys).set({ active: false }).where(and(eq(apiKeys.id, c.apiKeyId), eq(apiKeys.workspaceId, c.workspaceId)));
    await logAudit({ action: "apikey.revoked", workspaceId: c.workspaceId, userId, detail: `ابطال خودکار: مالکیت ایمیل حساب مالک اتصال ${c.siteHost} تغییر کرد`, actor: "system" }).catch(() => undefined);
  }
  return conns.length;
}
