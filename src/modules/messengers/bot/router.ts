import { ACT_ROLES, contractAccess, sendFinalCopy, signLinkFor } from "../contracts";
import { ASK_CONTACT, MENU, parseCommand } from "./texts";
import { type Bot, accountsOfChat, botRef, claimUpdate, releaseUpdate, setChatUser } from "../service";
import { type BridgeReply, claimConversation, endReply, replyFromMessenger, startReply, waitingConversations } from "@/modules/chat/bridge";
import { type Ctx, buildCtx, linked, needLink, say, sayBridge } from "./context";
import { type TgCallback, type TgMessage, type TgUpdate, answerCallback } from "../client";
import { and, eq } from "drizzle-orm";
import { cmdContracts, cmdHelp, cmdPending, cmdStart, cmdStatus, cmdSummary, onContact, showContract } from "./commands";
import { db } from "@/db";
import { messengerBots, messengerChats } from "@/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { remindContractNow } from "@/modules/automation/service";

/* ───────── ورودی ───────── */

/**
 * handled = پردازش شد | duplicate = قبلاً پردازش شده | ignored = ربات نیست/غیرفعال |
 * retry = خطای موقت (مثلاً قطعی دیتابیس)؛ آپدیت «آزاد» شد و باید دوباره برسد | dropped = پس از چند تلاش رها شد (آپدیت سمی)
 */
export type UpdateOutcome = "handled" | "duplicate" | "ignored" | "retry" | "dropped";
export const MAX_UPDATE_ATTEMPTS = 3;
const gu = globalThis as typeof globalThis & { __emzUpdAttempts?: Map<string, number> };
const attemptsMap = (): Map<string, number> => (gu.__emzUpdAttempts ??= new Map());

/**
 * M-01: پیش‌تر آپدیت «پیش از پردازش» ثبت (claim) می‌شد و هر خطا بلعیده می‌شد؛ پس با یک لرزش دیتابیس، پیام کاربر
 * (مثلاً /start با کد اتصال) برای همیشه گم می‌شد و وب‌هوک ۲۰۰ می‌داد تا پیام‌رسان دوباره نفرستد.
 * اکنون خطا ⇒ claim آزاد می‌شود و نتیجه‌ی «retry» برمی‌گردد (وب‌هوک ۵۰۰ می‌دهد؛ polling از همان آپدیت ادامه می‌دهد).
 * آپدیت سمی (همیشه خطا) پس از MAX_UPDATE_ATTEMPTS تلاش رها می‌شود تا صف دریافت برای همیشه قفل نماند.
 */
export async function handleUpdate(botId: number, update: TgUpdate): Promise<UpdateOutcome> {
  let claimed = false;
  const hasId = typeof update.update_id === "number";
  try {
    const [bot] = await db.select().from(messengerBots).where(and(eq(messengerBots.id, botId), eq(messengerBots.active, true)));
    if (!bot) return "ignored";
    if (hasId) {
      if (!(await claimUpdate(bot.id, update.update_id))) return "duplicate"; // تکراری
      claimed = true;
    }
    await db.update(messengerBots).set({ lastEventAt: new Date() }).where(eq(messengerBots.id, bot.id));
    if (update.message) await onMessage(bot, update.message);
    else if (update.callback_query) await onCallback(bot, update.callback_query);
    attemptsMap().delete(`${botId}:${update.update_id}`);
    return "handled";
  } catch (e) {
    console.error("[messenger:update]", e instanceof Error ? e.message : e);
    if (!hasId) return "dropped";
    const m = attemptsMap();
    if (m.size > 2000) m.clear();
    const key = `${botId}:${update.update_id}`;
    const n = (m.get(key) ?? 0) + 1;
    if (n >= MAX_UPDATE_ATTEMPTS) {
      m.delete(key);
      return "dropped";
    }
    m.set(key, n);
    if (claimed) await releaseUpdate(botId, update.update_id).catch(() => undefined);
    return "retry";
  }
}
async function onMessage(bot: Bot, msg: TgMessage) {
  if (msg.chat.type !== "private") return; // فقط گفتگوی خصوصی (لینک امضا و وضعیت قرارداد در گروه فاش نشود)
  const chatId = String(msg.chat.id);
  if (!rateLimit(`mb:${bot.id}:${chatId}`, 45, 60_000).ok) return;
  const c = await buildCtx(bot, chatId, msg.from);
  if (msg.contact) return onContact(c, msg);
  const text = (msg.text || "").trim();
  if (!text) return;
  const cmd = parseCommand(text);
  if (!cmd) {
    // پشتیبانی که «پاسخ از همین‌جا» را زده: پیام او پاسخ به مشتریِ گفتگوی زنده است
    const bridged = await replyFromMessenger(c.bot, c.chat, text, msg.message_id).catch((e) => {
      console.error("[messenger:chat-reply]", e instanceof Error ? e.message : e);
      return { text: "⚠️ ارسال پاسخ ممکن نشد؛ دوباره تلاش کنید." } as BridgeReply;
    });
    if (bridged) return sayBridge(c, bridged);
    return say(c, "متوجه نشدم 🤔 از منوی پایین یا دستور /help استفاده کنید.", undefined, MENU);
  }
  switch (cmd.cmd) {
    case "start":
      return cmdStart(c, cmd.arg);
    case "help":
    case "menu":
      return cmdHelp(c);
    case "pending":
      return cmdPending(c);
    case "contracts":
      return cmdContracts(c);
    case "status":
      return cmdStatus(c, cmd.arg);
    case "summary":
      return cmdSummary(c);
    case "chats":
      return sayBridge(c, await waitingConversations(c.bot, c.chat));
    case "done":
      return sayBridge(c, await endReply(c.chat));
    case "verify":
      return say(c, "برای تأیید شماره، دکمه‌ی «اشتراک شماره‌ی من» را بزنید. فقط شماره‌ی خودِ همین حساب پذیرفته می‌شود.", undefined, ASK_CONTACT);
    case "mute":
    case "unmute": {
      const mute = cmd.cmd === "mute";
      await db.update(messengerChats).set({ muted: mute }).where(eq(messengerChats.id, c.chat.id));
      return say(c, mute ? "🔕 اعلان‌های عمومی بی‌صدا شد. لینک امضا و کد تأیید همچنان می‌رسد." : "🔔 اعلان‌ها دوباره فعال شد.", undefined, MENU);
    }
    case "stop":
      await setChatUser(c.chat.id, null);
      return say(c, "اتصال این گفتگو قطع شد و دیگر پیامی دریافت نمی‌کنید. هر زمان خواستید با /start دوباره وصل شوید.", undefined, { remove_keyboard: true });
    default:
      return say(c, "این دستور را نمی‌شناسم. /help", undefined, MENU);
  }
}
async function onCallback(bot: Bot, cb: TgCallback) {
  const chatMsg = cb.message?.chat;
  const ref = botRef(bot);
  await answerCallback(ref, cb.id).catch(() => undefined); // بله/تلگرام تا پاسخ، دکمه را در حالت انتظار نگه می‌دارد
  if (!chatMsg || chatMsg.type !== "private" || !cb.data) return;
  const chatId = String(chatMsg.id);
  if (!rateLimit(`mb:${bot.id}:${chatId}`, 45, 60_000).ok) return;
  const c = await buildCtx(bot, chatId, cb.from);
  if (!linked(c.chat)) return needLink(c);
  // گفتگوی زنده: پاسخ از همین‌جا / برعهده‌گرفتن / پایان پاسخ‌گویی
  const lc = /^([khd]):(\d{1,10})$/.exec(cb.data);
  if (lc) return chatCallback(c, lc[1], Number(lc[2]));
  const m = /^([cprf]):(\d{1,10})$/.exec(cb.data);
  if (!m) return;
  const id = Number(m[2]);
  const accounts = await accountsOfChat(c.chat);
  const access = await contractAccess(c, accounts, id);
  if (!access) return say(c, "قرارداد پیدا نشد یا به آن دسترسی ندارید.");
  switch (m[1]) {
    case "c":
      return showContract(c, accounts, id);
    case "p": {
      const link = await signLinkFor(access);
      return link ? say(c, `✍️ لینک امضای قرارداد ${access.contract.number}`, [[{ text: "مشاهده و امضا", url: link.url }]]) : say(c, "اکنون نوبت امضای شما نیست یا قرارداد بسته شده است.");
    }
    case "r": {
      const cr = access.contract;
      if (!access.teamRole || !ACT_ROLES.includes(access.teamRole) || !c.chat.userId) return say(c, "فقط اعضای تیم می‌توانند یادآوری بفرستند.");
      if (cr.status !== "sent") return say(c, "این قرارداد منتظر امضا نیست.");
      if (cr.lastReminderAt && Date.now() - cr.lastReminderAt.getTime() < 3600_000) return say(c, "⏱ یادآوری کمتر از یک ساعت پیش ارسال شده است.");
      const ok = await remindContractNow(cr.id, c.chat.userId, cr.workspaceId);
      return say(c, ok ? `🔔 یادآوری برای امضاکننده‌ی قرارداد ${cr.number} ارسال شد.` : "ارسال یادآوری ممکن نشد.");
    }
    case "f": {
      if (access.contract.status !== "signed") return say(c, "این قرارداد هنوز نهایی نشده است.");
      await sendFinalCopy(c, access, { final: false });
      return;
    }
  }
}
async function chatCallback(c: Ctx, kind: string, convId: number) {
  try {
    if (kind === "k") return await sayBridge(c, await startReply(c.bot, c.chat, convId));
    if (kind === "h") return await sayBridge(c, await claimConversation(c.bot, c.chat, convId));
    return await sayBridge(c, await endReply(c.chat));
  } catch (e) {
    console.error("[messenger:chat-callback]", e instanceof Error ? e.message : e);
    return say(c, "⚠️ انجام این کار ممکن نشد؛ دوباره تلاش کنید.");
  }
}
