import { CHAT_HISTORY_LIMIT, CHAT_NAME_MAX, CLOSED_VISIBLE_MS, type ChatMsg, cleanChatText } from "../meta";
import { ChatError, type Conv, type Requester, actorWhere, newCode, preview, toMsg } from "./core";
import { type ResolvedContext } from "./context";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { chatConversations, chatMessages } from "@/db/schema";
import { chatWake } from "../bus";
import { db, withTransaction } from "@/db";
import { getRequestInfo } from "@/lib/request";

/** آخرین گفتگوی مشتری در این زمینه (بسته‌شده‌ی قدیمی دیده نمی‌شود) */
export async function findConversation(who: Requester, key: string): Promise<Conv | null> {
  const [c] = await db
    .select()
    .from(chatConversations)
    .where(and(actorWhere(who), eq(chatConversations.contextKey, key)))
    .orderBy(desc(chatConversations.id))
    .limit(1);
  if (!c) return null;
  if (c.status === "closed" && c.closedAt && Date.now() - c.closedAt.getTime() > CLOSED_VISIBLE_MS) return null;
  return c;
}
export async function getConversation(code: string): Promise<Conv | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(code)) return null;
  const [c] = await db.select().from(chatConversations).where(eq(chatConversations.code, code));
  return c ?? null;
}
export async function createConversation(who: Requester, ctx: ResolvedContext, pagePath: string): Promise<Conv> {
  let ua = "";
  try {
    ({ userAgent: ua } = await getRequestInfo());
  } catch {
    /* خارج از چرخه‌ی درخواست */
  }
  const [c] = await db
    .insert(chatConversations)
    .values({
      code: newCode(),
      queue: ctx.queue,
      workspaceId: ctx.workspaceId,
      contextKind: ctx.kind,
      contextKey: ctx.key,
      userId: who.kind === "user" ? who.userId : null,
      visitorHash: who.kind === "visitor" ? who.hash : null,
      requesterName: ctx.name,
      requesterMobile: ctx.mobile,
      contractId: ctx.contractId,
      signerId: ctx.signerId,
      pagePath: safePageText(pagePath),
      userAgent: ua.slice(0, 300),
    })
    .returning();
  return c;
}
const safePageText = (p: string) => (/^\/[^\s<>"'`\\]*$/.test(p) ? p.slice(0, 200) : "");
/* ═════════════ پیام‌ها ═════════════ */

type NewMsg = { kind: "requester" | "staff" | "system"; userId?: number | null; name: string; body: string; internal?: boolean; clientId?: string | null };
/**
 * ثبت یک پیام + به‌روزرسانی اتمی شمارنده‌ها. ارسال تکراری با همان clientId پیام دوم نمی‌سازد.
 * خروجی: پیام (جدید یا قبلی) و duplicate.
 */
export async function appendMessage(conv: Conv, m: NewMsg): Promise<{ msg: ChatMsg; duplicate: boolean }> {
  const body = cleanChatText(m.body);
  if (!body) throw new ChatError("empty", "پیام خالی است");
  const clientId = m.clientId ? String(m.clientId).slice(0, 64) : null;
  const out = await withTransaction(async () => {
    const [row] = await db
      .insert(chatMessages)
      .values({ conversationId: conv.id, senderKind: m.kind, senderUserId: m.userId ?? null, senderName: m.name.slice(0, CHAT_NAME_MAX), body, internal: !!m.internal, clientId })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [prev] = await db.select().from(chatMessages).where(and(eq(chatMessages.conversationId, conv.id), eq(chatMessages.clientId, clientId ?? "")));
      return { msg: toMsg(prev), duplicate: true };
    }
    const now = new Date();
    if (m.kind === "requester") {
      await db
        .update(chatConversations)
        .set({
          status: "open",
          closedAt: null,
          lastMessageAt: now,
          lastMessageBy: "requester",
          lastPreview: preview(body),
          unreadStaff: sql`${chatConversations.unreadStaff} + 1`,
          requesterTypingAt: null,
          requesterSeenAt: now,
        })
        .where(eq(chatConversations.id, conv.id));
    } else if (m.kind === "staff" && !m.internal) {
      await db
        .update(chatConversations)
        .set({
          lastMessageAt: now,
          lastMessageBy: "staff",
          lastPreview: preview(body),
          unreadRequester: sql`${chatConversations.unreadRequester} + 1`,
          staffTypingAt: null,
          // اولین پاسخ‌دهنده خودکار مسئول گفتگو می‌شود
          assigneeId: m.userId ? sql`coalesce(${chatConversations.assigneeId}, ${m.userId})` : chatConversations.assigneeId,
        })
        .where(eq(chatConversations.id, conv.id));
    }
    return { msg: toMsg(row), duplicate: false };
  });
  chatWake(conv.code);
  return out;
}
/** تاریخچه‌ی گفتگو؛ after = فقط پیام‌های جدیدتر از این شناسه. برای مشتری، یادداشت داخلی هرگز برنمی‌گردد */
export async function listMessages(convId: number, o: { after?: number; staff: boolean; limit?: number }): Promise<ChatMsg[]> {
  const limit = Math.min(CHAT_HISTORY_LIMIT, o.limit ?? CHAT_HISTORY_LIMIT);
  const visible = o.staff ? undefined : eq(chatMessages.internal, false);
  if (o.after && o.after > 0) {
    const rows = await db.select().from(chatMessages).where(and(eq(chatMessages.conversationId, convId), gt(chatMessages.id, o.after), visible)).orderBy(asc(chatMessages.id)).limit(limit);
    return rows.map(toMsg);
  }
  const rows = await db.select().from(chatMessages).where(and(eq(chatMessages.conversationId, convId), visible)).orderBy(desc(chatMessages.id)).limit(limit);
  return rows.reverse().map(toMsg);
}
