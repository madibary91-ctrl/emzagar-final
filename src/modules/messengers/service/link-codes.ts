import { LINK_CODE_TTL_MS } from "./core";
import { and, eq, gt, isNull } from "drizzle-orm";
import { botsForUser } from "./bots";
import { db } from "@/db";
import { deepLink, newLinkCode, sha256Hex } from "../util";
import { messengerBots, messengerLinkCodes } from "@/db/schema";

/* ───────── کد اتصال حساب ───────── */

export async function createLinkCode(userId: number, botId: number): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const [bot] = await db.select().from(messengerBots).where(and(eq(messengerBots.id, botId), eq(messengerBots.active, true)));
  if (!bot || !bot.botUsername) return { ok: false, error: "این ربات در دسترس نیست" };
  const allowed = await botsForUser(userId);
  if (!allowed.some((b) => b.id === botId)) return { ok: false, error: "دسترسی به این ربات ندارید" };
  await db.delete(messengerLinkCodes).where(and(eq(messengerLinkCodes.userId, userId), eq(messengerLinkCodes.botId, botId), isNull(messengerLinkCodes.usedAt)));
  const code = newLinkCode();
  await db.insert(messengerLinkCodes).values({ codeHash: sha256Hex(code), userId, botId, expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS) });
  return { ok: true, url: deepLink(bot.provider, bot.botUsername, code) };
}
/** مصرف اتمیک (یک‌بار): userId یا null */
export async function consumeLinkCode(code: string, botId: number): Promise<number | null> {
  if (!/^l[A-Za-z0-9_-]{20,60}$/.test(code)) return null;
  const rows = await db
    .update(messengerLinkCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(messengerLinkCodes.codeHash, sha256Hex(code)), eq(messengerLinkCodes.botId, botId), isNull(messengerLinkCodes.usedAt), gt(messengerLinkCodes.expiresAt, new Date())))
    .returning({ userId: messengerLinkCodes.userId });
  return rows[0]?.userId ?? null;
}
