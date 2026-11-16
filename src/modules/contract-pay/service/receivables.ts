import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { contractInstallments, contractSigners, contracts, users } from "@/db/schema";
import { db } from "@/db";
import { payerSigner } from "../gate";

/* ───────────────────────────── مطالبات (داشبورد وصول) ───────────────────────────── */
export type ReceivableRow = {
  id: number;
  contractId: number;
  number: string;
  contractTitle: string;
  contractStatus: string;
  title: string;
  kind: string;
  amount: number;
  dueAt: Date | null;
  status: string;
  method: string | null;
  paidAt: Date | null;
  gate: string;
  payerName: string;
  payerMobile: string;
  payCode: string;
  state: "paid" | "overdue" | "due_soon" | "upcoming" | "at_signing" | "cancelled" | "waiting_sign";
  reminderCount: number;
};
export const STATE_LABELS: Record<ReceivableRow["state"], string> = {
  paid: "پرداخت‌شده",
  overdue: "سررسید گذشته",
  due_soon: "سررسید نزدیک",
  upcoming: "در انتظار سررسید",
  at_signing: "هنگام امضا",
  waiting_sign: "منتظر امضا",
  cancelled: "لغوشده",
};
export function stateOf(r: { status: string; dueAt: Date | null; gate: string }, contractStatus: string, now = new Date()): ReceivableRow["state"] {
  if (r.status === "paid") return "paid";
  if (r.status === "cancelled") return "cancelled";
  if (contractStatus !== "signed") return r.gate === "before_sign" || !r.dueAt ? "at_signing" : "waiting_sign";
  if (!r.dueAt) return "overdue";
  const d = r.dueAt.getTime() - now.getTime();
  if (d < -86400_000) return "overdue";
  if (d <= 3 * 86400_000) return "due_soon";
  return "upcoming";
}
export async function receivables(workspaceId: number, limit = 500) {
  const rows = await db
    .select({ i: contractInstallments, number: contracts.number, ctitle: contracts.title, cstatus: contracts.status })
    .from(contractInstallments)
    .innerJoin(contracts, eq(contracts.id, contractInstallments.contractId))
    .where(and(eq(contractInstallments.workspaceId, workspaceId), ne(contracts.status, "draft")))
    .orderBy(desc(contractInstallments.createdAt), asc(contractInstallments.position))
    .limit(limit);
  const cids = [...new Set(rows.map((r) => r.i.contractId))];
  const signers = cids.length ? await db.select({ id: contractSigners.id, contractId: contractSigners.contractId, position: contractSigners.position, userId: contractSigners.userId }).from(contractSigners).where(inArray(contractSigners.contractId, cids)) : [];
  const uids = [...new Set(signers.map((s) => s.userId))];
  const us = uids.length ? await db.select({ id: users.id, name: users.name, mobile: users.mobile }).from(users).where(inArray(users.id, uids)) : [];
  const now = new Date();
  const out: ReceivableRow[] = rows.map(({ i, number, ctitle, cstatus }) => {
    const payer = payerSigner(signers.filter((s) => s.contractId === i.contractId), i.payerPosition);
    const u = payer ? us.find((x) => x.id === payer.userId) : undefined;
    return {
      id: i.id, contractId: i.contractId, number, contractTitle: ctitle, contractStatus: cstatus, title: i.title, kind: i.kind, amount: i.amount, dueAt: i.dueAt, status: i.status, method: i.method, paidAt: i.paidAt, gate: i.gate,
      payerName: u?.name ?? "—", payerMobile: u?.mobile ?? "", payCode: i.payCode, state: stateOf(i, cstatus, now), reminderCount: i.reminderCount,
    };
  });
  const sum = (f: (r: ReceivableRow) => boolean) => out.filter(f).reduce((s, r) => s + r.amount, 0);
  const live = (r: ReceivableRow) => r.state !== "cancelled" && !["cancelled", "rejected", "expired"].includes(r.contractStatus);
  const totals = {
    paid: sum((r) => r.state === "paid"),
    overdue: sum((r) => r.state === "overdue" && live(r)),
    dueSoon: sum((r) => r.state === "due_soon" && live(r)),
    upcoming: sum((r) => ["upcoming", "waiting_sign", "at_signing"].includes(r.state) && live(r)),
    overdueCount: out.filter((r) => r.state === "overdue" && live(r)).length,
  };
  return { rows: out, totals };
}
