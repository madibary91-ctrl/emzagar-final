import crypto from "node:crypto";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { ticketMessages, tickets, users, workspaces } from "@/db/schema";

export type Ticket = typeof tickets.$inferSelect;
export type TicketMessage = typeof ticketMessages.$inferSelect;

/** شماره‌ی خوانا و یکتا مثل TK-7F3A9C */
function newNumber() {
  return `TK-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export async function createTicket(p: {
  userId: number;
  workspaceId: number;
  subject: string;
  category: string;
  priority: string;
  body: string;
}): Promise<number> {
  for (let i = 0; i < 5; i++) {
    try {
      const [t] = await db
        .insert(tickets)
        .values({ number: newNumber(), userId: p.userId, workspaceId: p.workspaceId, subject: p.subject, category: p.category, priority: p.priority })
        .returning({ id: tickets.id });
      await db.insert(ticketMessages).values({ ticketId: t.id, userId: p.userId, isStaff: false, body: p.body });
      return t.id;
    } catch (e) {
      if (i === 4) throw e; // احتمال تکراری بودن شماره؛ دوباره تلاش می‌شود
    }
  }
  throw new Error("ساخت تیکت ناموفق بود");
}

export async function listUserTickets(userId: number) {
  return db.select().from(tickets).where(eq(tickets.userId, userId)).orderBy(desc(tickets.updatedAt)).limit(200);
}

/** تیکت + گفتگو برای صاحب تیکت (یادداشت‌های داخلی هرگز برنمی‌گردند) */
export async function getTicketForOwner(userId: number, id: number) {
  const [ticket] = await db.select().from(tickets).where(and(eq(tickets.id, id), eq(tickets.userId, userId)));
  if (!ticket) return null;
  const messages = await db
    .select({ id: ticketMessages.id, isStaff: ticketMessages.isStaff, body: ticketMessages.body, createdAt: ticketMessages.createdAt, author: users.name })
    .from(ticketMessages)
    .innerJoin(users, eq(users.id, ticketMessages.userId))
    .where(and(eq(ticketMessages.ticketId, id), eq(ticketMessages.internal, false)))
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
  return { ticket, messages };
}

export async function getTicketForStaff(id: number) {
  const [row] = await db
    .select({ ticket: tickets, userName: users.name, userEmail: users.email, userMobile: users.mobile, workspaceName: workspaces.name })
    .from(tickets)
    .innerJoin(users, eq(users.id, tickets.userId))
    .leftJoin(workspaces, eq(workspaces.id, tickets.workspaceId))
    .where(eq(tickets.id, id));
  if (!row) return null;
  const messages = await db
    .select({ id: ticketMessages.id, isStaff: ticketMessages.isStaff, internal: ticketMessages.internal, body: ticketMessages.body, createdAt: ticketMessages.createdAt, author: users.name })
    .from(ticketMessages)
    .innerJoin(users, eq(users.id, ticketMessages.userId))
    .where(eq(ticketMessages.ticketId, id))
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
  return { ...row, messages };
}

const PAGE_SIZE = 25;

export async function queryTickets(f: { status?: string; priority?: string; category?: string; q?: string; waiting?: boolean; page?: number }) {
  const conds = [];
  if (f.status && f.status !== "all") conds.push(eq(tickets.status, f.status));
  if (f.priority) conds.push(eq(tickets.priority, f.priority));
  if (f.category) conds.push(eq(tickets.category, f.category));
  if (f.waiting) conds.push(and(sql`${tickets.status} <> 'closed'`, eq(tickets.lastReplyBy, "customer")));
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, "\\$&")}%`;
    conds.push(or(ilike(tickets.subject, like), ilike(tickets.number, like), ilike(users.name, like), ilike(users.email, like)));
  }
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, f.page || 1);
  const rows = await db
    .select({ ticket: tickets, userName: users.name, userEmail: users.email, workspaceName: workspaces.name })
    .from(tickets)
    .innerJoin(users, eq(users.id, tickets.userId))
    .leftJoin(workspaces, eq(workspaces.id, tickets.workspaceId))
    .where(where)
    .orderBy(desc(tickets.updatedAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(tickets).innerJoin(users, eq(users.id, tickets.userId)).where(where);
  return { rows, total: n, page, pages: Math.max(1, Math.ceil(n / PAGE_SIZE)) };
}

export async function ticketCounts() {
  const rows = await db.select({ status: tickets.status, n: sql<number>`count(*)::int` }).from(tickets).groupBy(tickets.status);
  const out = { open: 0, in_progress: 0, closed: 0, total: 0, waiting: 0 };
  for (const r of rows) {
    if (r.status in out) (out as Record<string, number>)[r.status] = r.n;
    out.total += r.n;
  }
  const [w] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(sql`${tickets.status} <> 'closed'`, eq(tickets.lastReplyBy, "customer")));
  out.waiting = w?.n ?? 0;
  return out;
}

/** میانگین امتیاز رضایت کاربران */
export async function ticketSatisfaction() {
  const [r] = await db
    .select({ avg: sql<number | null>`round(avg(${tickets.rating})::numeric, 1)::float`, n: sql<number>`count(${tickets.rating})::int` })
    .from(tickets);
  return { avg: r?.avg ?? null, n: r?.n ?? 0 };
}

/** تعداد تیکت‌های باز کاربر که منتظر پاسخ او هستند (برای نشان روی منو) */
export async function userAttentionCount(userId: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tickets)
    .where(and(eq(tickets.userId, userId), sql`${tickets.status} <> 'closed'`, eq(tickets.lastReplyBy, "staff")));
  return r?.n ?? 0;
}
