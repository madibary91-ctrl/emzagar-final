import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractComments, contracts, contractSigners } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { notifyTeam, notifyUsers } from "@/modules/inbox/service";
import { sendMail } from "@/modules/mail";
import { escapeHtml } from "@/lib/html";
import { users } from "@/db/schema";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";

export type CommentKind = "comment" | "change_request";
export type CommentVisibility = "internal" | "shared";
export type CommentSide = "team" | "signer";

export const MAX_COMMENT = 2000;

export interface CommentRow {
  id: number;
  parentId: number | null;
  authorUserId: number | null;
  authorName: string;
  authorSide: string;
  visibility: string;
  kind: string;
  quote: string;
  body: string;
  status: string;
  resolvedAt: Date | null;
  createdAt: Date;
}

/** نظرات یک قرارداد؛ یادداشت‌های داخلی فقط برای تیم برمی‌گردند */
export async function listComments(contractId: number, opts: { includeInternal: boolean }): Promise<CommentRow[]> {
  const rows = await db
    .select({
      id: contractComments.id,
      parentId: contractComments.parentId,
      authorUserId: contractComments.authorUserId,
      authorName: contractComments.authorName,
      authorSide: contractComments.authorSide,
      visibility: contractComments.visibility,
      kind: contractComments.kind,
      quote: contractComments.quote,
      body: contractComments.body,
      status: contractComments.status,
      resolvedAt: contractComments.resolvedAt,
      createdAt: contractComments.createdAt,
    })
    .from(contractComments)
    .where(eq(contractComments.contractId, contractId))
    .orderBy(asc(contractComments.createdAt), asc(contractComments.id));
  return opts.includeInternal ? rows : rows.filter((r) => r.visibility === "shared");
}

export async function openChangeRequests(contractId: number): Promise<number> {
  const rows = await db
    .select({ id: contractComments.id })
    .from(contractComments)
    .where(and(eq(contractComments.contractId, contractId), eq(contractComments.kind, "change_request"), eq(contractComments.status, "open")));
  return rows.length;
}

export interface AddCommentInput {
  contractId: number;
  authorUserId: number;
  authorName: string;
  side: CommentSide;
  visibility: CommentVisibility;
  kind: CommentKind;
  body: string;
  quote?: string;
  parentId?: number | null;
}

export async function addComment(input: AddCommentInput): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (body.length < 2) return { ok: false, error: "متن پیام را بنویسید" };
  if (body.length > MAX_COMMENT) return { ok: false, error: `حداکثر ${MAX_COMMENT.toLocaleString("fa-IR")} نویسه مجاز است` };
  const [c] = await db.select().from(contracts).where(eq(contracts.id, input.contractId));
  if (!c) return { ok: false, error: "قرارداد یافت نشد" };

  let visibility: CommentVisibility = input.side === "signer" ? "shared" : input.visibility;
  let kind: CommentKind = input.kind === "change_request" ? "change_request" : "comment";
  if (visibility === "internal") kind = "comment";
  if (c.status === "draft") visibility = "internal"; // پیش‌نویس هنوز برای طرف مقابل ارسال نشده است

  let parentId: number | null = null;
  if (input.parentId) {
    const [p] = await db.select().from(contractComments).where(and(eq(contractComments.id, input.parentId), eq(contractComments.contractId, input.contractId)));
    if (!p) return { ok: false, error: "پیام اصلی یافت نشد" };
    parentId = p.parentId ?? p.id; // گفتگو فقط یک سطح تو‌در‌تو دارد
    if (p.visibility === "internal") {
      if (input.side === "signer") return { ok: false, error: "پیام اصلی یافت نشد" };
      visibility = "internal";
    }
    kind = "comment";
  }

  const [row] = await db
    .insert(contractComments)
    .values({
      contractId: input.contractId,
      parentId,
      authorUserId: input.authorUserId,
      authorName: input.authorName.slice(0, 120),
      authorSide: input.side,
      visibility,
      kind,
      quote: (input.quote ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      body,
    })
    .returning({ id: contractComments.id });

  await logAudit({
    action: kind === "change_request" ? "comment.change_requested" : "comment.added",
    contractId: input.contractId,
    userId: input.authorUserId,
    detail: `${visibility === "internal" ? "یادداشت داخلی" : input.side === "signer" ? "پیام طرف قرارداد" : "پیام مشترک"} — ${body.slice(0, 100)}`,
  });
  await notifyAboutComment(c, { ...input, visibility, kind, body }).catch(() => undefined);
  return { ok: true, id: row.id };
}

async function notifyAboutComment(c: typeof contracts.$inferSelect, i: AddCommentInput & { visibility: CommentVisibility; kind: CommentKind }) {
  const href = `/contracts/${c.id}#negotiation`;
  const snippet = i.body.slice(0, 160);
  if (i.visibility === "internal") {
    await notifyTeam(c.workspaceId, { kind: "info", title: `یادداشت داخلی جدید در ${c.number}`, body: `${i.authorName}: ${snippet}`, href }, [], undefined).catch(() => 0);
    return;
  }
  if (i.side === "signer") {
    const isChange = i.kind === "change_request";
    await notifyTeam(c.workspaceId, { kind: isChange ? "warning" : "action", title: isChange ? `درخواست اصلاح در ${c.number}` : `پیام جدید در ${c.number}`, body: `${i.authorName}: ${snippet}`, href });
    return;
  }
  // پیام مشترک تیم → همه‌ی طرف‌های قرارداد (درون‌برنامه‌ای) + ایمیل با لینک امنِ نوبت فعلی
  const signers = await db.select().from(contractSigners).where(eq(contractSigners.contractId, c.id));
  await notifyUsers([c.customerId, ...signers.map((s) => s.userId)].filter((id) => id !== i.authorUserId), { kind: "action", title: `پیام جدید درباره‌ی ${c.number}`, body: `${i.authorName}: ${snippet}`, href: `/contracts/${c.id}#negotiation` });
  if (c.status !== "sent") return;
  const turn = signers.filter((s) => s.status === "pending").sort((a, b) => a.position - b.position)[0];
  if (!turn) return;
  const [u] = await db.select().from(users).where(eq(users.id, turn.userId));
  if (!u?.email) return;
  const link = await getOrCreateSigningLink(turn.id);
  const url = link ? await signingUrl(link.token, c.workspaceId) : "";
  await sendMail({
    to: u.email,
    contractId: c.id,
    subject: `پیام جدید درباره‌ی قرارداد ${c.number}`,
    html: `<div dir="rtl" style="font-family:Tahoma,sans-serif;line-height:2"><p>${escapeHtml(i.authorName)} درباره‌ی قرارداد «${escapeHtml(c.title)}» برای شما پیام گذاشته است:</p><blockquote style="border-right:3px solid #1f7a5a;margin:0;padding:6px 12px;background:#f5f7f5">${escapeHtml(i.body).replace(/\n/g, "<br>")}</blockquote>${url ? `<p><a href="${escapeHtml(url)}">مشاهده و پاسخ در صفحه‌ی امن قرارداد</a></p>` : ""}</div>`,
  });
}

/** بستن/بازکردن یک موضوع (فقط خودِ پیام ریشه؛ پاسخ‌ها همراه آن بسته می‌شوند) */
export async function setCommentResolved(contractId: number, commentId: number, resolved: boolean, actorId: number): Promise<boolean> {
  const [row] = await db.select().from(contractComments).where(and(eq(contractComments.id, commentId), eq(contractComments.contractId, contractId)));
  if (!row || row.parentId) return false;
  await db
    .update(contractComments)
    .set({ status: resolved ? "resolved" : "open", resolvedBy: resolved ? actorId : null, resolvedAt: resolved ? new Date() : null })
    .where(eq(contractComments.id, commentId));
  await logAudit({ action: resolved ? "comment.resolved" : "comment.reopened", contractId, userId: actorId, detail: row.body.slice(0, 100) });
  if (resolved && row.authorSide === "signer" && row.authorUserId && row.visibility === "shared") {
    await notifyUsers([row.authorUserId], { kind: "success", title: "درخواست شما بررسی و بسته شد", body: row.body.slice(0, 120), href: `/contracts/${contractId}#negotiation` });
  }
  return true;
}
