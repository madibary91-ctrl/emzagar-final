import { db } from "@/db";
import { desc, eq, isNull, lt } from "drizzle-orm";
import { messengerBots, messengerLinkCodes, messengerLog, messengerUpdates } from "@/db/schema";

export async function recentMessengerLog(workspaceId: number | null, limit = 25) {
  return db
    .select({ id: messengerLog.id, kind: messengerLog.kind, status: messengerLog.status, error: messengerLog.error, createdAt: messengerLog.createdAt, provider: messengerBots.provider, botUsername: messengerBots.botUsername })
    .from(messengerLog)
    .innerJoin(messengerBots, eq(messengerBots.id, messengerLog.botId))
    .where(workspaceId === null ? isNull(messengerBots.workspaceId) : eq(messengerBots.workspaceId, workspaceId))
    .orderBy(desc(messengerLog.id))
    .limit(limit);
}
/* ───────── لاگ و پاک‌سازی ───────── */

export async function logMessenger(e: { botId: number; chatRowId?: number | null; kind: string; status: "sent" | "failed"; error?: string; contractId?: number | null }): Promise<void> {
  try {
    await db.insert(messengerLog).values({ botId: e.botId, chatRowId: e.chatRowId ?? null, kind: e.kind, status: e.status, error: (e.error || "").slice(0, 300), contractId: e.contractId ?? null });
  } catch (err) {
    console.error("[messenger:log]", err);
  }
}
/** ثبت آپدیت؛ false = قبلاً پردازش شده (تکراری) */
export async function claimUpdate(botId: number, updateId: number): Promise<boolean> {
  const rows = await db.insert(messengerUpdates).values({ botId, updateId }).onConflictDoNothing().returning({ id: messengerUpdates.id });
  return rows.length > 0;
}
export async function purgeMessengerData(): Promise<void> {
  const day = 86400_000;
  await db.delete(messengerUpdates).where(lt(messengerUpdates.createdAt, new Date(Date.now() - 3 * day)));
  await db.delete(messengerLinkCodes).where(lt(messengerLinkCodes.expiresAt, new Date(Date.now() - day)));
  await db.delete(messengerLog).where(lt(messengerLog.createdAt, new Date(Date.now() - 60 * day)));
}
