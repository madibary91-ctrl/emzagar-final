import { and, eq, isNull, ne } from "drizzle-orm";
import { contractInstallments, payments } from "@/db/schema";
import type { SubscriptionExecutor } from "@/modules/billing/subscription";

type PaymentRow = typeof payments.$inferSelect;

export const CONTRACT_PLAN_PREFIX = "contract:";
export const installmentIdOf = (plan: string): number | null => {
  if (!plan.startsWith(CONTRACT_PLAN_PREFIX)) return null;
  const n = Number(plan.slice(CONTRACT_PLAN_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * اعمال اثر پرداخت قرارداد داخل «همان تراکنش» تایید پرداخت (اتمی و ایدمپوتنت):
 * علامت اعمال (payments.fulfilled_at) و پرداخت‌شدن قسط با هم ثبت می‌شوند یا هیچ‌کدام.
 */
export async function applyContractPayment(tx: SubscriptionExecutor, pay: PaymentRow, refId: string): Promise<{ applied: boolean; installmentId: number | null }> {
  const claimed = await tx
    .update(payments)
    .set({ fulfilledAt: new Date() })
    .where(and(eq(payments.id, pay.id), isNull(payments.fulfilledAt)))
    .returning({ id: payments.id });
  if (claimed.length === 0) return { applied: false, installmentId: null };
  const iid = installmentIdOf(pay.plan);
  if (!iid) throw new Error("contract_payment_ref_invalid");
  // اگر قسط همزمان با روش دیگری (ثبت دستی) پرداخت شده باشد، دوباره‌کاری نمی‌شود؛ پرداخت درگاه ثبت می‌ماند ولی مدیر باید بازپرداخت را رسیدگی کند
  const upd = await tx
    .update(contractInstallments)
    .set({ status: "paid", method: "gateway", paymentId: pay.id, refId, paidAt: new Date() })
    .where(and(eq(contractInstallments.id, iid), eq(contractInstallments.workspaceId, pay.workspaceId), ne(contractInstallments.status, "paid")))
    .returning({ id: contractInstallments.id });
  return { applied: true, installmentId: upd[0]?.id ?? iid };
}
