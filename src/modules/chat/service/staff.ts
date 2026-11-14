import { type ChatContextKind, type ChatMsg, type ChatQueue, IDLE_CLOSE_MS, type StaffContext, type StaffCounts, type StaffListItem, type StaffThread, TYPING_MS } from "../meta";
import { ChatError, type Conv, SEEN_FRESH_MS, notifyRequester } from "./core";
import { agentScope, touchAgent } from "./requester";
import { and, asc, count, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import { appendMessage, listMessages } from "./conversations";
import { chatConversations, contractInstallments, contractSigners, contracts, tickets, users, workspaceMembers } from "@/db/schema";
import { chatWake } from "../bus";
import { createTicket } from "@/modules/tickets/service";
import { db } from "@/db";
import { describeUserAgent } from "@/modules/auth/session";
import { workspaceName } from "./context";

/* ═════════════ کنش‌های پشتیبان ═════════════ */

export type StaffScope = { queue: ChatQueue; workspaceId: number; userId: number; name: string };
export function staffCanAccess(s: StaffScope, c: Conv): boolean {
  return c.queue === s.queue && (s.queue === "platform" || c.workspaceId === s.workspaceId);
}
export async function staffSend(s: StaffScope, conv: Conv, p: { text: string; clientId?: string | null; internal?: boolean }): Promise<ChatMsg> {
  if (conv.status === "closed" && !p.internal) throw new ChatError("closed", "گفتگو بسته است؛ ابتدا آن را دوباره باز کنید");
  void touchAgent(s.userId, agentScope(s.queue, s.workspaceId)).catch(() => undefined);
  const res = await appendMessage(conv, { kind: "staff", userId: s.userId, name: s.name, body: p.text, internal: !!p.internal, clientId: p.clientId });
  if (!res.duplicate && !p.internal) await notifyRequester(conv, res.msg).catch((e) => console.error("[chat:notify-requester]", e));
  return res.msg;
}
export async function staffClaim(s: StaffScope, conv: Conv, mode: "take" | "release"): Promise<void> {
  const next = mode === "take" ? s.userId : null;
  if (conv.assigneeId === next) return;
  await db.update(chatConversations).set({ assigneeId: next }).where(eq(chatConversations.id, conv.id));
  if (mode === "take") await appendMessage(conv, { kind: "system", name: "سیستم", body: `${s.name} گفتگو را برعهده گرفت.` });
  else chatWake(conv.code);
}
export async function staffClose(s: StaffScope, conv: Conv): Promise<void> {
  if (conv.status === "closed") return;
  await db.update(chatConversations).set({ status: "closed", closedAt: new Date(), staffTypingAt: null }).where(eq(chatConversations.id, conv.id));
  await appendMessage(conv, { kind: "system", name: "سیستم", body: `گفتگو توسط ${s.name} بسته شد. اگر سوال دیگری دارید، پیام تازه بفرستید.` });
}
export async function staffReopen(s: StaffScope, conv: Conv): Promise<void> {
  if (conv.status === "open") return;
  await db.update(chatConversations).set({ status: "open", closedAt: null }).where(eq(chatConversations.id, conv.id));
  await appendMessage(conv, { kind: "system", name: "سیستم", body: `گفتگو توسط ${s.name} دوباره باز شد.` });
}
/** تبدیل گفتگو به تیکت پشتیبانی (رونوشت گفتگو) برای پیگیری غیرهم‌زمان؛ فقط برای مشتری دارای حساب */
export async function staffToTicket(s: StaffScope, conv: Conv): Promise<string> {
  if (!conv.userId) throw new ChatError("no_account", "این مشتری حساب کاربری ندارد؛ تیکت فقط برای کاربران واردشده ساخته می‌شود");
  if (conv.ticketId) throw new ChatError("exists", "این گفتگو قبلاً به تیکت تبدیل شده است");
  const msgs = await listMessages(conv.id, { staff: false });
  const lines = msgs.filter((m) => m.kind !== "system").map((m) => `${m.kind === "staff" ? "پشتیبان" : "کاربر"}: ${m.body}`);
  let body = `رونوشت گفتگوی زنده (${conv.code}):\n\n${lines.join("\n")}`.slice(0, 5000);
  if (body.length < 10) body = "گفتگوی زنده به تیکت تبدیل شد.";
  const first = msgs.find((m) => m.kind === "requester")?.body ?? "گفتگوی زنده";
  const subject = `گفتگوی زنده: ${first.replace(/\s+/g, " ").slice(0, 100)}`;
  // تیکت به یک فضای کاری واقعی وصل می‌شود: فضای گفتگو، وگرنه نخستین فضای کاری خود کاربر
  let wsId = conv.workspaceId;
  if (!wsId) {
    const [m] = await db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, conv.userId)).limit(1);
    wsId = m?.workspaceId ?? 0;
  }
  if (!wsId) throw new ChatError("no_workspace", "این کاربر به هیچ فضای کاری وصل نیست؛ تیکت ساخته نمی‌شود");
  const id = await createTicket({ userId: conv.userId, workspaceId: wsId, subject, category: "general", priority: "normal", body });
  const [t] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, id));
  await db.update(chatConversations).set({ ticketId: id, status: "closed", closedAt: new Date() }).where(eq(chatConversations.id, conv.id));
  await appendMessage(conv, { kind: "system", name: "سیستم", body: `این گفتگو برای پیگیری به تیکت ${t?.number ?? id} تبدیل شد؛ از بخش «پشتیبانی» می‌توانید آن را دنبال کنید.` });
  return t?.number ?? String(id);
}
/* ═════════════ صندوق پشتیبان ═════════════ */

let lastIdleSweep = 0;
async function closeIdle() {
  if (Date.now() - lastIdleSweep < 10 * 60_000) return;
  lastIdleSweep = Date.now();
  await db
    .update(chatConversations)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(chatConversations.status, "open"), lt(chatConversations.lastMessageAt, new Date(Date.now() - IDLE_CLOSE_MS))))
    .catch(() => undefined);
}
function scopeWhere(s: StaffScope) {
  return s.queue === "platform" ? eq(chatConversations.queue, "platform") : and(eq(chatConversations.queue, "workspace"), eq(chatConversations.workspaceId, s.workspaceId));
}
export type StaffFilter = "open" | "mine" | "unassigned" | "closed";
export async function staffList(s: StaffScope, f: { filter: StaffFilter; q?: string }): Promise<{ items: StaffListItem[]; counts: StaffCounts }> {
  await closeIdle();
  const base = scopeWhere(s);
  const conds = [base];
  if (f.filter === "closed") conds.push(eq(chatConversations.status, "closed"));
  else {
    conds.push(eq(chatConversations.status, "open"));
    if (f.filter === "mine") conds.push(eq(chatConversations.assigneeId, s.userId));
    if (f.filter === "unassigned") conds.push(isNull(chatConversations.assigneeId));
  }
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(chatConversations.requesterName, like), ilike(chatConversations.requesterMobile, like), ilike(chatConversations.lastPreview, like)));
  }
  const rows = await db
    .select({ c: chatConversations, contractNumber: contracts.number, assigneeName: users.name })
    .from(chatConversations)
    .leftJoin(contracts, eq(contracts.id, chatConversations.contractId))
    .leftJoin(users, eq(users.id, chatConversations.assigneeId))
    .where(and(...conds))
    .orderBy(sql`(${chatConversations.unreadStaff} > 0) desc`, desc(chatConversations.lastMessageAt))
    .limit(80);
  const now = Date.now();
  const items: StaffListItem[] = rows.map(({ c, contractNumber, assigneeName }) => ({
    code: c.code,
    name: c.requesterName || "مشتری",
    mobile: c.requesterMobile,
    contextKind: c.contextKind as ChatContextKind,
    contractNumber,
    status: c.status === "closed" ? "closed" : "open",
    unread: c.unreadStaff,
    preview: c.lastPreview,
    lastBy: c.lastMessageBy as StaffListItem["lastBy"],
    at: c.lastMessageAt.toISOString(),
    assigneeId: c.assigneeId,
    assigneeName: assigneeName ? assigneeName.split(" ")[0] : null,
    mine: c.assigneeId === s.userId,
    requesterOnline: !!c.requesterSeenAt && now - c.requesterSeenAt.getTime() < SEEN_FRESH_MS,
    hasTicket: !!c.ticketId,
  }));
  return { items, counts: await staffCounts(s) };
}
export async function staffCounts(s: StaffScope): Promise<StaffCounts> {
  const [r] = await db
    .select({
      open: sql<number>`count(*) filter (where ${chatConversations.status} = 'open')::int`,
      unassigned: sql<number>`count(*) filter (where ${chatConversations.status} = 'open' and ${chatConversations.assigneeId} is null)::int`,
      mine: sql<number>`count(*) filter (where ${chatConversations.status} = 'open' and ${chatConversations.assigneeId} = ${s.userId})::int`,
      unread: sql<number>`count(*) filter (where ${chatConversations.status} = 'open' and ${chatConversations.unreadStaff} > 0)::int`,
      closed: sql<number>`count(*) filter (where ${chatConversations.status} = 'closed')::int`,
    })
    .from(chatConversations)
    .where(scopeWhere(s));
  return r ?? { open: 0, unassigned: 0, mine: 0, unread: 0, closed: 0 };
}
async function staffContext(conv: Conv): Promise<StaffContext> {
  const queue = conv.queue as ChatQueue;
  let requester: StaffContext["requester"] = { name: conv.requesterName || "مشتری", mobile: conv.requesterMobile, email: null, isGuest: true, userId: null };
  if (conv.userId) {
    const [u] = await db.select({ name: users.name, email: users.email, mobile: users.mobile, isGuest: users.isGuest }).from(users).where(eq(users.id, conv.userId));
    if (u) requester = { name: u.name, mobile: u.mobile, email: queue === "platform" && !u.isGuest ? u.email : null, isGuest: u.isGuest, userId: conv.userId };
  }
  const prevWhere = conv.userId ? eq(chatConversations.userId, conv.userId) : conv.visitorHash ? eq(chatConversations.visitorHash, conv.visitorHash) : undefined;
  const [prev] = prevWhere ? await db.select({ n: count() }).from(chatConversations).where(and(prevWhere, lt(chatConversations.id, conv.id))) : [{ n: 0 }];

  let contract: StaffContext["contract"] = null;
  if (conv.contractId) {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, conv.contractId));
    if (c) {
      const signers = await db
        .select({ label: contractSigners.label, name: users.name, status: contractSigners.status })
        .from(contractSigners)
        .innerJoin(users, eq(users.id, contractSigners.userId))
        .where(eq(contractSigners.contractId, c.id))
        .orderBy(asc(contractSigners.position));
      const [pend] = await db.select({ n: count() }).from(contractInstallments).where(and(eq(contractInstallments.contractId, c.id), eq(contractInstallments.status, "pending")));
      contract = {
        id: c.id,
        number: c.number,
        title: c.title,
        status: c.status,
        issuedAt: c.issuedAt.toISOString(),
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        signers,
        pendingInstallments: pend?.n ?? 0,
        href: queue === "workspace" ? `/contracts/${c.id}` : null,
      };
    }
  }
  return {
    requester,
    contextKind: conv.contextKind as ChatContextKind,
    queue,
    workspaceName: await workspaceName(conv.workspaceId),
    pagePath: conv.pagePath,
    device: describeUserAgent(conv.userAgent),
    startedAt: conv.createdAt.toISOString(),
    previousChats: prev?.n ?? 0,
    contract,
  };
}
export async function staffThread(s: StaffScope, conv: Conv): Promise<StaffThread> {
  const [messages, context, assignee, ticket] = await Promise.all([
    listMessages(conv.id, { staff: true }),
    staffContext(conv),
    conv.assigneeId ? db.select({ name: users.name }).from(users).where(eq(users.id, conv.assigneeId)).then((r) => r[0]?.name ?? null) : Promise.resolve(null),
    conv.ticketId ? db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, conv.ticketId)).then((r) => r[0]?.number ?? null) : Promise.resolve(null),
  ]);
  return {
    code: conv.code,
    queue: conv.queue as ChatQueue,
    status: conv.status === "closed" ? "closed" : "open",
    assigneeId: conv.assigneeId,
    assigneeName: assignee ? assignee.split(" ")[0] : null,
    requesterTyping: !!conv.requesterTypingAt && Date.now() - conv.requesterTypingAt.getTime() < TYPING_MS,
    requesterOnline: !!conv.requesterSeenAt && Date.now() - conv.requesterSeenAt.getTime() < SEEN_FRESH_MS,
    requesterReadId: conv.requesterReadId,
    rating: conv.rating,
    ticketNumber: ticket,
    canTicket: !!conv.userId && !conv.ticketId,
    messages,
    context,
  };
}
/** تعداد گفتگوهای خوانده‌نشده‌ی یک صف (نشان روی منو) */
export async function unreadStaffChats(s: StaffScope): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(chatConversations)
    .where(and(scopeWhere(s), eq(chatConversations.status, "open"), gt(chatConversations.unreadStaff, 0)));
  return r?.n ?? 0;
}
