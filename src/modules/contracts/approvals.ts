import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { contractApprovals, contracts, users, workspaceMembers } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { notifyUser } from "@/modules/inbox/service";

export const APPROVAL_LABELS: Record<string, string> = {
  pending: "در انتظار بررسی",
  approved: "تأیید شد",
  changes_requested: "درخواست اصلاح",
};

/** نقش‌هایی که می‌توانند تأییدکننده‌ی داخلی باشند */
const APPROVER_ROLES = ["owner", "admin", "member"];

export async function listApprovals(contractId: number) {
  return db
    .select({
      id: contractApprovals.id,
      approverId: contractApprovals.approverId,
      approverName: users.name,
      status: contractApprovals.status,
      note: contractApprovals.note,
      decidedAt: contractApprovals.decidedAt,
      createdAt: contractApprovals.createdAt,
    })
    .from(contractApprovals)
    .innerJoin(users, eq(users.id, contractApprovals.approverId))
    .where(eq(contractApprovals.contractId, contractId))
    .orderBy(asc(contractApprovals.createdAt));
}

export type ApprovalRow = Awaited<ReturnType<typeof listApprovals>>[number];

export function summarizeApprovals(rows: { status: string }[]) {
  const total = rows.length;
  const approved = rows.filter((r) => r.status === "approved").length;
  const changes = rows.filter((r) => r.status === "changes_requested").length;
  return { total, approved, changes, pending: total - approved - changes, blocked: total > 0 && approved < total };
}

/** اعضایی از تیم که می‌توانند به‌عنوان تأییدکننده انتخاب شوند */
export async function approverCandidates(workspaceId: number) {
  return db
    .select({ id: users.id, name: users.name, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.role, APPROVER_ROLES)))
    .orderBy(asc(users.name));
}

async function loadDraft(contractId: number, workspaceId: number) {
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.workspaceId, workspaceId)));
  if (!c) throw new Error("قرارداد یافت نشد");
  if (c.status !== "draft") throw new Error("تأیید داخلی فقط برای پیش‌نویس‌ها ممکن است");
  return c;
}

export async function requestApprovals(contractId: number, workspaceId: number, approverIds: number[], requesterId: number): Promise<number> {
  const c = await loadDraft(contractId, workspaceId);
  const wanted = [...new Set(approverIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 10);
  if (wanted.length === 0) throw new Error("حداقل یک تأییدکننده را انتخاب کنید");
  const valid = new Set((await approverCandidates(workspaceId)).map((u) => u.id));
  const ids = wanted.filter((id) => valid.has(id));
  if (ids.length === 0) throw new Error("تأییدکننده‌ی انتخاب‌شده عضو تیم این فضای کاری نیست");
  for (const approverId of ids) {
    await db
      .insert(contractApprovals)
      .values({ contractId, approverId, requestedBy: requesterId })
      .onConflictDoUpdate({ target: [contractApprovals.contractId, contractApprovals.approverId], set: { status: "pending", note: "", decidedAt: null, requestedBy: requesterId } });
    if (approverId !== requesterId) {
      await notifyUser(approverId, { kind: "action", title: `درخواست تأیید قرارداد ${c.number}`, body: `«${c.title}» پیش از انتشار منتظر تأیید شماست.`, href: `/contracts/${contractId}#approvals` });
    }
  }
  await logAudit({ action: "approval.requested", contractId, userId: requesterId, workspaceId, detail: `${c.number} — ${ids.length} تأییدکننده` });
  return ids.length;
}

export async function decideApproval(contractId: number, workspaceId: number, userId: number, decision: "approved" | "changes_requested", note: string): Promise<void> {
  const c = await loadDraft(contractId, workspaceId);
  const [row] = await db.select().from(contractApprovals).where(and(eq(contractApprovals.contractId, contractId), eq(contractApprovals.approverId, userId)));
  if (!row) throw new Error("شما تأییدکننده‌ی این قرارداد نیستید");
  const clean = note.trim().slice(0, 500);
  if (decision === "changes_requested" && clean.length < 3) throw new Error("برای درخواست اصلاح، توضیح کوتاهی بنویسید");
  await db.update(contractApprovals).set({ status: decision, note: clean, decidedAt: new Date() }).where(eq(contractApprovals.id, row.id));
  await logAudit({
    action: decision === "approved" ? "approval.approved" : "approval.changes_requested",
    contractId,
    userId,
    workspaceId,
    detail: `${c.number}${clean ? ` — ${clean.slice(0, 120)}` : ""}`,
  });
  if (row.requestedBy && row.requestedBy !== userId) {
    await notifyUser(row.requestedBy, {
      kind: decision === "approved" ? "success" : "warning",
      title: decision === "approved" ? `قرارداد ${c.number} تأیید شد` : `درخواست اصلاح برای ${c.number}`,
      body: clean || "تأییدکننده نسخه‌ی فعلی را تأیید کرد.",
      href: `/contracts/${contractId}#approvals`,
    });
  }
}

export async function removeApproval(contractId: number, workspaceId: number, approverId: number, actorId: number): Promise<void> {
  const c = await loadDraft(contractId, workspaceId);
  await db.delete(contractApprovals).where(and(eq(contractApprovals.contractId, contractId), eq(contractApprovals.approverId, approverId)));
  await logAudit({ action: "approval.removed", contractId, userId: actorId, workspaceId, detail: c.number });
}

/**
 * با هر تغییر در متن، تأییدهای قبلی بی‌اعتبار می‌شوند (تأیید فقط برای همان نسخه‌ای است که دیده شده).
 * فقط وقتی کسی قبلاً تصمیم گرفته باشد اثر دارد؛ تعداد تأییدکنندگانِ بازنشده را برمی‌گرداند.
 */
export async function invalidateApprovals(contractId: number, actorId: number | null, reason: string): Promise<number> {
  const decided = await db
    .select()
    .from(contractApprovals)
    .where(and(eq(contractApprovals.contractId, contractId), ne(contractApprovals.status, "pending")));
  if (decided.length === 0) return 0;
  await db.update(contractApprovals).set({ status: "pending", decidedAt: null }).where(and(eq(contractApprovals.contractId, contractId), ne(contractApprovals.status, "pending")));
  await logAudit({ action: "approval.reset", contractId, userId: actorId, detail: `تأییدها بازنشانی شد (${reason})` });
  const [c] = await db.select({ number: contracts.number, title: contracts.title }).from(contracts).where(eq(contracts.id, contractId));
  for (const r of decided) {
    if (r.approverId !== actorId) {
      await notifyUser(r.approverId, { kind: "info", title: `متن قرارداد ${c?.number ?? ""} تغییر کرد`, body: "تأیید قبلی شما بی‌اثر شد؛ لطفاً نسخه‌ی جدید را دوباره بررسی کنید.", href: `/contracts/${contractId}#approvals` });
    }
  }
  return decided.length;
}

/** انتشار فقط وقتی مجاز است که همه‌ی تأییدکنندگانِ درخواست‌شده، نسخه‌ی فعلی را تأیید کرده باشند */
export async function assertApprovalsClear(contractId: number): Promise<void> {
  const rows = await db.select({ status: contractApprovals.status }).from(contractApprovals).where(eq(contractApprovals.contractId, contractId));
  const s = summarizeApprovals(rows);
  if (s.blocked) throw new Error(`انتشار ممکن نیست: ${s.approved.toLocaleString("fa-IR")} از ${s.total.toLocaleString("fa-IR")} تأییدکننده نسخه‌ی فعلی را تأیید کرده‌اند`);
}
