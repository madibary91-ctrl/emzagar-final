import { type Bot, type Chat, fullName } from "./core";
import { type TgUser } from "../client";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots, messengerChats, users } from "@/db/schema";
import { normalizeMobile } from "../util";

export async function chatsOfUser(userId: number) {
  return db
    .select({ id: messengerChats.id, provider: messengerBots.provider, botUsername: messengerBots.botUsername, username: messengerChats.username, displayName: messengerChats.displayName, verifiedMobile: messengerChats.verifiedMobile, muted: messengerChats.muted, blocked: messengerChats.blocked, linkedAt: messengerChats.linkedAt })
    .from(messengerChats)
    .innerJoin(messengerBots, eq(messengerBots.id, messengerChats.botId))
    .where(eq(messengerChats.userId, userId))
    .orderBy(desc(messengerChats.linkedAt));
}
/* ───────── چت‌ها ───────── */

export interface ChatTarget {
  chat: Chat;
  bot: Bot;
}
/**
 * چت‌هایی که پیام یک کاربر باید به آن‌ها برسد: چت‌های وصل‌شده به حساب او + چت‌هایی که «شماره‌ی موبایل او را خود پیام‌رسان گواهی کرده».
 * mode = verified: فقط چت‌های با شماره‌ی گواهی‌شده‌ی برابر موبایل کاربر (برای کد تأیید امضا).
 */
export async function chatTargetsForUser(userId: number, o: { workspaceId?: number | null; mode?: "any" | "verified" } = {}): Promise<ChatTarget[]> {
  const [u] = await db.select({ mobile: users.mobile }).from(users).where(eq(users.id, userId));
  if (!u) return [];
  const mobile = normalizeMobile(u.mobile);
  const byUser = eq(messengerChats.userId, userId);
  const byMobile = mobile ? eq(messengerChats.verifiedMobile, mobile) : undefined;
  const who = o.mode === "verified" ? byMobile : byMobile ? or(byUser, byMobile) : byUser;
  if (!who) return [];
  const rows = await db
    .select({ chat: messengerChats, bot: messengerBots })
    .from(messengerChats)
    .innerJoin(messengerBots, eq(messengerBots.id, messengerChats.botId))
    .where(
      and(
        who,
        eq(messengerBots.active, true),
        eq(messengerChats.blocked, false),
        o.workspaceId === undefined ? undefined : o.workspaceId === null ? isNull(messengerBots.workspaceId) : or(isNull(messengerBots.workspaceId), eq(messengerBots.workspaceId, o.workspaceId)),
      ),
    );
  return rows;
}
/** همه‌ی حساب‌هایی که این چت نماینده‌ی آن‌هاست: حساب وصل‌شده + حساب‌های دارای همان موبایل گواهی‌شده (مثل امضاکننده‌ی مهمان) */
export async function accountsOfChat(chat: Pick<Chat, "userId" | "verifiedMobile">): Promise<number[]> {
  const ids = new Set<number>();
  if (chat.userId) ids.add(chat.userId);
  if (chat.verifiedMobile) {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.mobile, chat.verifiedMobile));
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}
export async function touchChat(bot: Bot, chatId: string, from?: TgUser): Promise<Chat> {
  const name = from ? fullName(from) : "";
  const [row] = await db
    .insert(messengerChats)
    .values({ botId: bot.id, chatId, username: (from?.username || "").slice(0, 60), displayName: name })
    .onConflictDoUpdate({
      target: [messengerChats.botId, messengerChats.chatId],
      set: { lastSeenAt: new Date(), blocked: false, ...(from?.username ? { username: from.username.slice(0, 60) } : {}), ...(name ? { displayName: name } : {}) },
    })
    .returning();
  return row;
}
export async function getChat(id: number): Promise<ChatTarget | null> {
  const [r] = await db.select({ chat: messengerChats, bot: messengerBots }).from(messengerChats).innerJoin(messengerBots, eq(messengerBots.id, messengerChats.botId)).where(eq(messengerChats.id, id));
  return r ?? null;
}
export async function setChatUser(chatRowId: number, userId: number | null): Promise<void> {
  await db
    .update(messengerChats)
    .set(userId ? { userId, linkedAt: new Date() } : { userId: null, verifiedMobile: "", linkedAt: null, muted: false, replyConvId: null, replyUntil: null })
    .where(eq(messengerChats.id, chatRowId));
}
export async function setChatVerifiedMobile(chatRowId: number, mobile: string): Promise<void> {
  await db.update(messengerChats).set({ verifiedMobile: mobile, linkedAt: sql`coalesce(${messengerChats.linkedAt}, now())` }).where(eq(messengerChats.id, chatRowId));
}
export async function markChatBlocked(chatRowId: number): Promise<void> {
  await db.update(messengerChats).set({ blocked: true }).where(eq(messengerChats.id, chatRowId));
}
