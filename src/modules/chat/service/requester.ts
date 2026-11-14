import { AGENT_ONLINE_MS, type ChatMsg, type ChatQueue, type ChatState, TYPING_MS, cleanChatText } from "../meta";
import { ChatError, type Conv, type Requester, notifyStaff } from "./core";
import { type ResolvedContext } from "./context";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { appendMessage, createConversation, findConversation, getConversation } from "./conversations";
import { chatAgents, chatConversations, chatMessages, tickets, users } from "@/db/schema";
import { chatWake } from "../bus";
import { db } from "@/db";
import { relayToLiveSessions, scheduleStaffAlert } from "../alerts";

/* ═════════════ حضور پشتیبان‌ها ═════════════ */

export const agentScope = (queue: ChatQueue, workspaceId: number) => (queue === "platform" ? "platform" : `ws:${workspaceId}`);
export async function touchAgent(userId: number, scope: string): Promise<void> {
  const now = new Date();
  await db
    .insert(chatAgents)
    .values({ userId, scope, lastSeenAt: now })
    .onConflictDoUpdate({ target: [chatAgents.userId, chatAgents.scope], set: { lastSeenAt: now } });
}
export async function agentsOnline(queue: ChatQueue, workspaceId: number): Promise<boolean> {
  const [r] = await db
    .select({ n: count() })
    .from(chatAgents)
    .where(and(eq(chatAgents.scope, agentScope(queue, workspaceId)), gt(chatAgents.lastSeenAt, new Date(Date.now() - AGENT_ONLINE_MS))));
  return (r?.n ?? 0) > 0;
}
/* ═════════════ وضعیت از دید مشتری ═════════════ */

export async function requesterState(conv: Conv): Promise<ChatState> {
  const [online, assignee, ticket] = await Promise.all([
    agentsOnline(conv.queue as ChatQueue, conv.workspaceId),
    conv.assigneeId ? db.select({ name: users.name }).from(users).where(eq(users.id, conv.assigneeId)).then((r) => r[0]?.name ?? null) : Promise.resolve(null),
    conv.ticketId ? db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, conv.ticketId)).then((r) => r[0]?.number ?? null) : Promise.resolve(null),
  ]);
  return {
    status: conv.status === "closed" ? "closed" : "open",
    typing: !!conv.staffTypingAt && Date.now() - conv.staffTypingAt.getTime() < TYPING_MS,
    staffReadId: conv.staffReadId,
    unread: conv.unreadRequester,
    online,
    assignee: assignee ? assignee.split(" ")[0] : null,
    rating: conv.rating,
    ticketNumber: ticket,
  };
}
/* ═════════════ کنش‌های مشتری ═════════════ */

/**
 * ارسال پیام مشتری. اگر گفتگوی بازی نبود، ساخته می‌شود (همراه اعلان به تیم پاسخ‌گو).
 * وقتی هیچ پشتیبانی آنلاین نیست، یک‌بار پیام سیستمی «آفلاین هستیم» ثبت می‌شود.
 */
export async function requesterSend(who: Requester, ctx: ResolvedContext, p: { text: string; clientId?: string | null; pagePath?: string }): Promise<{ conv: Conv; msg: ChatMsg; created: boolean }> {
  const text = cleanChatText(p.text);
  if (!text) throw new ChatError("empty", "پیام خالی است");
  if (ctx.kind === "site" && ctx.name.length < 2) throw new ChatError("name_required", "لطفاً نام خود را وارد کنید");
  let conv = await findConversation(who, ctx.key);
  let created = false;
  if (!conv || conv.status === "closed") {
    conv = await createConversation(who, ctx, p.pagePath || "");
    created = true;
  }
  const res = await appendMessage(conv, { kind: "requester", userId: who.kind === "user" ? who.userId : null, name: conv.requesterName || "مشتری", body: text, clientId: p.clientId });
  if (!res.duplicate) {
    const online = await agentsOnline(conv.queue as ChatQueue, conv.workspaceId);
    if (!online) {
      await appendMessage(conv, {
        kind: "system",
        name: "سیستم",
        body: "همکاران ما در حال حاضر آنلاین نیستند. پیام شما ثبت شد و به‌محض بازگشت پاسخ می‌دهند" + (who.kind === "user" ? "؛ پاسخ را در اعلان‌ها (زنگوله) هم خواهید دید." : "؛ همین صفحه را باز نگه دارید یا بعداً دوباره سر بزنید."),
        clientId: "sys-offline",
      }).catch(() => undefined);
    }
    await notifyStaff(conv, res.msg, online, created).catch((e) => console.error("[chat:notify-staff]", e));
    // اعلان هوشمند به پیام‌رسان‌ها (بله/تلگرام/ایتا/…): فوری اگر کسی آنلاین نیست، وگرنه پس از مهلت بی‌پاسخی؛ + پل زنده برای پاسخ‌دهندگان در پیام‌رسان
    await relayToLiveSessions(conv.id, res.msg.id);
    await scheduleStaffAlert({ convId: conv.id, msgId: res.msg.id, staffOnline: online });
  }
  return { conv: (await getConversation(conv.code)) ?? conv, msg: res.msg, created };
}
export async function setTyping(conv: Conv, who: "requester" | "staff"): Promise<void> {
  await db
    .update(chatConversations)
    .set(who === "requester" ? { requesterTypingAt: new Date(), requesterSeenAt: new Date() } : { staffTypingAt: new Date() })
    .where(eq(chatConversations.id, conv.id));
  chatWake(conv.code);
}
/** مشتری پیام‌های پشتیبان را دید / پشتیبان پیام‌های مشتری را دید */
export async function markRead(conv: Conv, who: "requester" | "staff"): Promise<void> {
  const from = who === "requester" ? "staff" : "requester";
  const [mx] = await db
    .select({ id: sql<number>`coalesce(max(${chatMessages.id}), 0)::int` })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conv.id), eq(chatMessages.senderKind, from), eq(chatMessages.internal, false)));
  const upTo = mx?.id ?? 0;
  const patch = who === "requester" ? { unreadRequester: 0, requesterReadId: upTo, requesterSeenAt: new Date() } : { unreadStaff: 0, staffReadId: upTo };
  const unread = who === "requester" ? conv.unreadRequester : conv.unreadStaff;
  const seen = who === "requester" ? conv.requesterReadId : conv.staffReadId;
  if (unread === 0 && seen >= upTo) {
    if (who === "requester") await db.update(chatConversations).set({ requesterSeenAt: new Date() }).where(eq(chatConversations.id, conv.id));
    return;
  }
  await db.update(chatConversations).set(patch).where(eq(chatConversations.id, conv.id));
  chatWake(conv.code);
}
/** ضربان حضور مشتری (برای تصمیم‌گیری درباره‌ی اعلان پاسخ پشتیبان) */
export async function touchRequester(convId: number): Promise<void> {
  await db.update(chatConversations).set({ requesterSeenAt: new Date() }).where(eq(chatConversations.id, convId));
}
export async function closeByRequester(conv: Conv): Promise<void> {
  if (conv.status === "closed") return;
  await db.update(chatConversations).set({ status: "closed", closedAt: new Date() }).where(eq(chatConversations.id, conv.id));
  await appendMessage(conv, { kind: "system", name: "سیستم", body: "مشتری گفتگو را بست." }).catch(() => undefined);
  chatWake(conv.code);
}
export async function rate(conv: Conv, rating: number): Promise<void> {
  const r = Math.round(rating);
  if (!(r >= 1 && r <= 5)) throw new ChatError("bad_rating", "امتیاز باید بین ۱ تا ۵ باشد");
  await db.update(chatConversations).set({ rating: r }).where(eq(chatConversations.id, conv.id));
  chatWake(conv.code);
}
