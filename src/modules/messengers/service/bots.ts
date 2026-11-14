import { BOT_COMMANDS, type Bot, type RegisterResult, botRef, fullName, webhookUrlFor } from "./core";
import { BOT_TOKEN_RE, type MessengerProvider, headerSecretFor, isProvider, newWebhookSecret, sha256Hex } from "../util";
import { BotApiError, type TgUser, deleteWebhook, getMe, setMyCommands, setWebhook } from "../client";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { assertSafeUrl } from "@/lib/ssrf";
import { db } from "@/db";
import { encryptSecret } from "@/lib/crypto";
import { messengerBots, messengerChats, messengerLog, workspaceMembers } from "@/db/schema";

export async function registerBot(p: { workspaceId: number | null; provider: string; token: string; apiBase?: string; mode?: string; label?: string }): Promise<RegisterResult> {
  if (!isProvider(p.provider)) return { ok: false, error: "نوع پیام‌رسان نامعتبر است" };
  const token = p.token.trim();
  if (!BOT_TOKEN_RE.test(token)) return { ok: false, error: "قالب توکن ربات نادرست است (نمونه: 123456789:AAH…)" };
  const apiBase = (p.apiBase || "").trim();
  if (apiBase) {
    try {
      await assertSafeUrl(apiBase);
    } catch (e) {
      return { ok: false, error: "آدرس رله: " + (e instanceof Error ? e.message : "نامعتبر") };
    }
  }
  const mode = p.mode === "polling" ? "polling" : "webhook";
  const tokenHash = sha256Hex(token);
  const [dup] = await db.select({ id: messengerBots.id }).from(messengerBots).where(eq(messengerBots.tokenHash, tokenHash));
  if (dup) return { ok: false, error: "این ربات قبلاً ثبت شده است" };

  let me: TgUser;
  try {
    me = await getMe({ provider: p.provider, token, apiBase: apiBase || undefined });
  } catch (e) {
    return { ok: false, error: e instanceof BotApiError ? e.message : "ارتباط با پیام‌رسان برقرار نشد" };
  }
  const [row] = await db
    .insert(messengerBots)
    .values({
      workspaceId: p.workspaceId,
      provider: p.provider,
      label: (p.label || "").trim().slice(0, 80),
      tokenEnc: encryptSecret(token),
      tokenHash,
      botUsername: (me.username || "").slice(0, 80),
      botName: fullName(me),
      apiBase,
      mode,
      webhookSecret: newWebhookSecret(),
    })
    .returning({ id: messengerBots.id });
  const r = await connectBot(row.id);
  return r.ok ? { ok: true, id: row.id } : { ok: true, id: row.id, warning: r.error };
}
/** (دوباره) اتصال: وب‌هوک را ثبت یا حذف می‌کند، نام کاربری ربات و فهرست دستورها را به‌روز می‌کند */
export async function connectBot(botId: number): Promise<{ ok: boolean; error?: string }> {
  const [bot] = await db.select().from(messengerBots).where(eq(messengerBots.id, botId));
  if (!bot) return { ok: false, error: "ربات یافت نشد" };
  const ref = botRef(bot);
  const fail = async (error: string) => {
    await db.update(messengerBots).set({ status: "error", lastError: error.slice(0, 300) }).where(eq(messengerBots.id, botId));
    return { ok: false, error };
  };
  try {
    const me = await getMe(ref);
    await db.update(messengerBots).set({ botUsername: (me.username || "").slice(0, 80), botName: fullName(me) }).where(eq(messengerBots.id, botId));
    if (bot.mode === "webhook") {
      const url = await webhookUrlFor(bot);
      if (!url.startsWith("https://")) return await fail("برای حالت وب‌هوک، آدرس سایت باید HTTPS باشد (APP_URL را تنظیم کنید) — یا حالت «پرسش دوره‌ای (Polling)» را انتخاب کنید");
      await setWebhook(ref, url, headerSecretFor(bot.webhookSecret));
    } else {
      await deleteWebhook(ref);
    }
    await setMyCommands(ref, BOT_COMMANDS).catch(() => undefined);
  } catch (e) {
    return await fail(e instanceof BotApiError ? e.message : "اتصال ناموفق بود");
  }
  await db.update(messengerBots).set({ status: "connected", lastError: "" }).where(eq(messengerBots.id, botId));
  return { ok: true };
}
export async function deleteBot(botId: number): Promise<void> {
  const [bot] = await db.select().from(messengerBots).where(eq(messengerBots.id, botId));
  if (!bot) return;
  try {
    await deleteWebhook(botRef(bot));
  } catch {
    /* ربات ممکن است قبلاً حذف شده باشد */
  }
  await db.delete(messengerBots).where(eq(messengerBots.id, botId));
}
/** ربات متعلق به «محدوده‌ی» مدیر (فضای کاری او یا پلتفرم)؛ جلوگیری از دست‌کاری ربات دیگران */
export async function botInScope(botId: number, workspaceId: number | null): Promise<Bot | null> {
  const [bot] = await db
    .select()
    .from(messengerBots)
    .where(and(eq(messengerBots.id, botId), workspaceId === null ? isNull(messengerBots.workspaceId) : eq(messengerBots.workspaceId, workspaceId)));
  return bot ?? null;
}
/* ───────── فهرست‌ها ───────── */

export async function listBots(workspaceId: number | null) {
  const bots = await db
    .select()
    .from(messengerBots)
    .where(workspaceId === null ? isNull(messengerBots.workspaceId) : eq(messengerBots.workspaceId, workspaceId))
    .orderBy(desc(messengerBots.createdAt));
  const ids = bots.map((b) => b.id);
  const chatStats = ids.length
    ? await db
        .select({
          botId: messengerChats.botId,
          linked: sql<number>`count(*) filter (where ${messengerChats.userId} is not null or ${messengerChats.verifiedMobile} <> '')::int`,
          verified: sql<number>`count(*) filter (where ${messengerChats.verifiedMobile} <> '')::int`,
        })
        .from(messengerChats)
        .where(inArray(messengerChats.botId, ids))
        .groupBy(messengerChats.botId)
    : [];
  const logStats = ids.length
    ? await db
        .select({
          botId: messengerLog.botId,
          sent: sql<number>`count(*) filter (where ${messengerLog.status} = 'sent')::int`,
          failed: sql<number>`count(*) filter (where ${messengerLog.status} = 'failed')::int`,
        })
        .from(messengerLog)
        .where(and(inArray(messengerLog.botId, ids), gt(messengerLog.createdAt, new Date(Date.now() - 7 * 86400_000))))
        .groupBy(messengerLog.botId)
    : [];
  // توکن و رازها هرگز به کلاینت نمی‌روند
  return bots.map((b) => ({
    id: b.id,
    provider: b.provider as MessengerProvider,
    label: b.label,
    botUsername: b.botUsername,
    botName: b.botName,
    apiBase: b.apiBase,
    mode: b.mode,
    active: b.active,
    otpMode: b.otpMode,
    sendPdf: b.sendPdf,
    status: b.status,
    lastError: b.lastError,
    lastEventAt: b.lastEventAt,
    linked: chatStats.find((s) => s.botId === b.id)?.linked ?? 0,
    verified: chatStats.find((s) => s.botId === b.id)?.verified ?? 0,
    sent7: logStats.find((s) => s.botId === b.id)?.sent ?? 0,
    failed7: logStats.find((s) => s.botId === b.id)?.failed ?? 0,
  }));
}
/** ربات‌هایی که یک کاربر می‌تواند به آن‌ها وصل شود: ربات پلتفرم + ربات فضاهای کاری عضو */
export async function botsForUser(userId: number) {
  const memberships = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, userId));
  const wsIds = memberships.map((m) => m.workspaceId);
  return db
    .select({ id: messengerBots.id, provider: messengerBots.provider, label: messengerBots.label, botUsername: messengerBots.botUsername, workspaceId: messengerBots.workspaceId })
    .from(messengerBots)
    .where(and(eq(messengerBots.active, true), eq(messengerBots.status, "connected"), ne(messengerBots.botUsername, ""), wsIds.length ? or(isNull(messengerBots.workspaceId), inArray(messengerBots.workspaceId, wsIds)) : isNull(messengerBots.workspaceId)))
    .orderBy(messengerBots.id);
}
/** ربات‌های فعال برای نمایش کارت «دریافت در پیام‌رسان» به امضاکننده‌ی یک فضای کاری */
export async function botsForWorkspace(workspaceId: number) {
  return db
    .select({ id: messengerBots.id, provider: messengerBots.provider, label: messengerBots.label, botUsername: messengerBots.botUsername })
    .from(messengerBots)
    .where(and(eq(messengerBots.active, true), eq(messengerBots.status, "connected"), ne(messengerBots.botUsername, ""), or(isNull(messengerBots.workspaceId), eq(messengerBots.workspaceId, workspaceId))))
    .orderBy(messengerBots.id);
}
