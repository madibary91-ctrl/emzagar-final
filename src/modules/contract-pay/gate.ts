import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contractInstallments, contractSigners } from "@/db/schema";

type Installment = typeof contractInstallments.$inferSelect;

/** امضاکننده‌ی پرداخت‌کننده‌ی هر قسط (جایگاه 0 = آخرین امضاکننده) */
export function payerSigner(signers: { position: number; userId: number; id: number }[], payerPosition: number) {
  if (signers.length === 0) return null;
  const sorted = [...signers].sort((a, b) => a.position - b.position);
  return payerPosition > 0 ? (sorted.find((s) => s.position === payerPosition) ?? sorted[sorted.length - 1]) : sorted[sorted.length - 1];
}

/** اقساط «پیش‌شرط امضا»ی پرداخت‌نشده‌ی این امضاکننده؛ خالی = می‌تواند امضا کند */
export async function blockingInstallments(contractId: number, signerId: number): Promise<Installment[]> {
  const rows = await db.select().from(contractInstallments).where(and(eq(contractInstallments.contractId, contractId), eq(contractInstallments.gate, "before_sign"), eq(contractInstallments.status, "pending")));
  if (rows.length === 0) return [];
  const signers = await db.select({ id: contractSigners.id, position: contractSigners.position, userId: contractSigners.userId }).from(contractSigners).where(eq(contractSigners.contractId, contractId));
  return rows.filter((r) => payerSigner(signers, r.payerPosition)?.id === signerId);
}

export async function gateMessage(contractId: number, signerId: number): Promise<string | null> {
  const b = await blockingInstallments(contractId, signerId);
  if (b.length === 0) return null;
  const sum = b.reduce((s, i) => s + i.amount, 0);
  return `برای امضا ابتدا باید ${b.map((i) => `«${i.title}»`).join(" و ")} (${sum.toLocaleString("fa-IR")} تومان) پرداخت شود`;
}

