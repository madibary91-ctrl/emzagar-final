import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import { chatConversations, chatMessages, messengerChats, users, workspaceMembers } from "@/db/schema";
import { faNum } from "@/lib/jalali";
import { can } from "@/modules/tenancy/roles";
import type { Bot, Chat } from "@/modules/messengers/service";
import type { Btn } from "@/modules/messengers/util";
import { REPLY_SESSION_MS } from "./alerts";
import { QUEUE_LABELS, type ChatQueue } from "./meta";
import { ChatError, markRead, platformAdminIds, staffClaim, staffSend, type Conv, type StaffScope } from "./service";

/**
 * پل دوطرفه‌ی «پیام‌رسان ⇄ گفتگوی زنده»: پشتیبان بدون باز کردن پنل، از همان بله/تلگرام
 *  - فهرست گفتگوهای بی‌پاسخ را می‌بیند (/chats)،
 *  - گفتگو را برعهده می‌گیرد،
 *  - پاسخ می‌دهد («حالت پاسخ‌گویی»: هر پیام او برای مشتری می‌رود و پیام‌های مشتری فوری برایش می‌آید).
 *
 * امنیت: فقط چتی که به «حساب» پشتیبان وصل است (نه صرفاً شماره‌ی گواهی‌شده)، و فقط اگر همان حساب
 * مدیر کل (صف پلتفرم) یا عضو دارای دسترسی نوشتن تیمِ همان گفتگو باشد. ربات تیم هرگز به صف پلتفرم و
 * صف تیمِ دیگر دسترسی نمی‌دهد. دسترسی در هر پیام دوباره سنجیده می‌شود.
 */

export type BridgeReply = { text: string; buttons?: Btn[][] };
type BotScope = Pick<Bot, "workspaceId">;
type ChatLike = Pick<Chat, "id" | "userId">;

const NO_ACCESS: BridgeReply = { text: "دسترسی به این گفتگو ندارید یا این چت به حساب پشتیبانی شما وصل نیست. از «حساب من ← پیام‌رسان‌ها» وصل شوید." };

const convById = async (id: number): Promise<Conv | null> => (await db.select().from(chatConversations).where(eq(chatConversations.id, id)))[0] ?? null;

/** آیا این ربات اجازه‌ی کار با صف این گفتگو را دارد؟ */
const botAllows = (bot: BotScope, c: Pick<Conv, "queue" | "workspaceId">) => (c.queue === "platform" ? bot.workspaceId === null : bot.workspaceId === null || bot.workspaceId === c.workspaceId);

async function scopeFor(bot: BotScope, chat: Pick<Chat, "userId">, conv: Conv): Promise<StaffScope | null> {
  if (!chat.userId || !botAllows(bot, conv)) return null;
  const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, chat.userId));
  if (!u) return null;
  if (conv.queue === "platform") return (await platformAdminIds()).includes(u.id) ? { queue: "platform", workspaceId: 0, userId: u.id, name: u.name } : null;
  const [m] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, conv.workspaceId), eq(workspaceMembers.userId, u.id)));
  return m && can(m.role, "write") ? { queue: "workspace", workspaceId: conv.workspaceId, userId: u.id, name: u.name } : null;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function transcript(convId: number, n = 5): Promise<string> {
  const rows = await db
    .select({ kind: chatMessages.senderKind, name: chatMessages.senderName, body: chatMessages.body })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, convId), eq(chatMessages.internal, false), inArray(chatMessages.senderKind, ["requester", "staff"])))
    .orderBy(desc(chatMessages.id))
    .limit(n);
  return rows
    .reverse()
    .map((r) => `${r.kind === "staff" ? "🧑‍💼" : "👤"} ${clip(r.name || (r.kind === "staff" ? "پشتیبان" : "مشتری"), 20)}: ${clip(r.body.replace(/\s+/g, " "), 200)}`)
    .join("\n");
}

const setSession = (chatRowId: number, convId: number | null) =>
  db.update(messengerChats).set({ replyConvId: convId, replyUntil: convId ? new Date(Date.now() + REPLY_SESSION_MS) : null }).where(eq(messengerChats.id, chatRowId));

/** «پاسخ از همین‌جا» */
export async function startReply(bot: BotScope, chat: ChatLike, convId: number): Promise<BridgeReply> {
  const conv = await convById(convId);
  if (!conv) return { text: "این گفتگو دیگر وجود ندارد." };
  const scope = await scopeFor(bot, chat, conv);
  if (!scope) return NO_ACCESS;
  if (conv.status === "closed") return { text: "این گفتگو بسته شده است. اگر مشتری دوباره پیام بدهد، اعلان تازه می‌رسد." };
  if (!conv.assigneeId) await staffClaim(scope, conv, "take").catch(() => undefined);
  await markRead(conv, "staff").catch(() => undefined);
  await setSession(chat.id, conv.id);
  const t = await transcript(conv.id);
  return {
    text: `💬 حالت پاسخ‌گویی فعال شد — ${QUEUE_LABELS[conv.queue as ChatQueue] ?? ""}\n👤 ${conv.requesterName || "مشتری"}\n\n${t}\n\n✍️ هر پیامی که اینجا بنویسید برای مشتری ارسال می‌شود و پیام‌های او هم فوراً همین‌جا می‌رسد.\nبرای پایان: /done (بدون فعالیت ${faNum(Math.round(REPLY_SESSION_MS / 60_000))} دقیقه‌ای خودکار تمام می‌شود)`,
    buttons: [[{ text: "🔚 پایان پاسخ‌گویی", data: `d:${conv.id}` }]],
  };
}

/** «برعهده‌گرفتن» */
export async function claimConversation(bot: BotScope, chat: ChatLike, convId: number): Promise<BridgeReply> {
  const conv = await convById(convId);
  if (!conv) return { text: "این گفتگو دیگر وجود ندارد." };
  const scope = await scopeFor(bot, chat, conv);
  if (!scope) return NO_ACCESS;
  if (conv.assigneeId === scope.userId) return { text: "این گفتگو همین حالا برعهده‌ی شماست." };
  if (conv.assigneeId) {
    const [o] = await db.select({ name: users.name }).from(users).where(eq(users.id, conv.assigneeId));
    return { text: `این گفتگو را ${o?.name ? o.name.split(" ")[0] : "همکار دیگری"} برعهده دارد.` };
  }
  await staffClaim(scope, conv, "take");
  return { text: "✋ گفتگو برعهده‌ی شما قرار گرفت.", buttons: [[{ text: "💬 پاسخ از همین‌جا", data: `k:${conv.id}` }]] };
}

/** پایان «حالت پاسخ‌گویی» */
export async function endReply(chat: Pick<Chat, "id" | "replyConvId">): Promise<BridgeReply> {
  if (!chat.replyConvId) return { text: "حالت پاسخ‌گویی فعال نیست." };
  await setSession(chat.id, null);
  return { text: "🔚 حالت پاسخ‌گویی پایان یافت. اعلان‌های تازه‌ی این گفتگو دوباره به‌صورت خلاصه می‌رسد." };
}

/**
 * پیام متنی عادی در حالت پاسخ‌گویی ⇒ پاسخ پشتیبان به مشتری. اگر چت در این حالت نباشد null برمی‌گرداند
 * (تا ربات پاسخ پیش‌فرضش را بدهد).
 */
export async function replyFromMessenger(bot: BotScope, chat: Pick<Chat, "id" | "userId" | "replyConvId" | "replyUntil">, text: string, messageId: number): Promise<BridgeReply | null> {
  if (!chat.replyConvId || !chat.replyUntil) return null;
  if (chat.replyUntil.getTime() < Date.now()) {
    await setSession(chat.id, null);
    return null;
  }
  const conv = await convById(chat.replyConvId);
  if (!conv || conv.status === "closed") {
    await setSession(chat.id, null);
    return { text: "این گفتگو بسته شده است؛ حالت پاسخ‌گویی پایان یافت." };
  }
  const scope = await scopeFor(bot, chat, conv);
  if (!scope) {
    await setSession(chat.id, null);
    return NO_ACCESS;
  }
  try {
    await staffSend(scope, conv, { text, clientId: `mb:${chat.id}:${messageId}` });
  } catch (e) {
    if (e instanceof ChatError) return { text: `⚠️ ${e.message}` };
    throw e;
  }
  await markRead(conv, "staff").catch(() => undefined);
  await setSession(chat.id, conv.id); // تمدید
  return { text: "✅ برای مشتری ارسال شد." };
}

/** /chats — گفتگوهای بی‌پاسخِ قابل‌دسترس برای این پشتیبان (با دکمه‌ی پاسخ) */
export async function waitingConversations(bot: BotScope, chat: ChatLike): Promise<BridgeReply> {
  if (!chat.userId) return NO_ACCESS;
  const [admin, mem] = await Promise.all([
    bot.workspaceId === null ? platformAdminIds().then((ids) => ids.includes(chat.userId as number)) : Promise.resolve(false),
    db.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.userId, chat.userId)),
  ]);
  const wsIds = mem.filter((m) => can(m.role, "write") && (bot.workspaceId === null || m.workspaceId === bot.workspaceId)).map((m) => m.workspaceId);
  const conds = [];
  if (admin) conds.push(eq(chatConversations.queue, "platform"));
  if (wsIds.length) conds.push(and(eq(chatConversations.queue, "workspace"), inArray(chatConversations.workspaceId, wsIds)));
  if (!conds.length) return { text: "شما در این ربات دسترسی پشتیبانی گفتگوی آنلاین ندارید." };
  const rows = await db
    .select({ id: chatConversations.id, name: chatConversations.requesterName, preview: chatConversations.lastPreview, unread: chatConversations.unreadStaff, queue: chatConversations.queue })
    .from(chatConversations)
    .where(and(eq(chatConversations.status, "open"), gt(chatConversations.unreadStaff, 0), eq(chatConversations.lastMessageBy, "requester"), or(...conds)))
    .orderBy(desc(chatConversations.lastMessageAt))
    .limit(8);
  if (!rows.length) return { text: "✅ هیچ گفتگوی بی‌پاسخی ندارید." };
  return {
    text: `💬 گفتگوهای منتظر پاسخ (${faNum(rows.length)})\n\n` + rows.map((r, i) => `${faNum(i + 1)}. ${clip(r.name || "مشتری", 24)}${r.unread > 1 ? ` (${faNum(r.unread)} پیام)` : ""} — ${clip(r.preview, 70)}`).join("\n"),
    buttons: rows.map((r, i) => [{ text: `💬 ${faNum(i + 1)}. ${clip(r.name || "مشتری", 24)}`, data: `k:${r.id}` }]),
  };
}
