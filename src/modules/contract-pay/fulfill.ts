import { and, eq, isNull, ne } from "drizzle-orm";
import { contractInstallments, payments } from "@/db/schema";
import type { SubscriptionExecutor } from "@/modules/billing/subscription";

type PaymentRow = typeof payments.$inferSelect;

export const CONTRACT_PLAN_PREFIX = "contract:";
/** نشانه‌ی ستون `payments.error` برای پرداختی که پول آن گرفته شده ولی قسطی برای تخصیص نبوده ⇒ بازپرداخت/تهاتر دستی لازم است */
export const REFUND_REQUIRED = "refund_required";
export const REFUND_ORPHAN = `${REFUND_REQUIRED}:installment_missing`;
export const REFUND_DOUBLE = `${REFUND_REQUIRED}:already_paid`;
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
  // قسط «حذف شده» (برنامه پس از شروع پرداخت جایگزین شد) یا «همزمان با روش دیگری پرداخت شده»: پول گرفته شده و نباید بی‌صدا گم شود.
  // (MX-02) پیش‌تر در هر دو حالت «اعمال موفق» برمی‌گشت و هیچ ردی از اینکه مبلغی بدون قسط مانده نبود. اکنون پرداخت با نشانه‌ی
  // refund_required ثبت می‌شود و announceInstallmentPaid ممیزی + اعلان هشدار به مالک/مدیر می‌فرستد (و به پرداخت‌کننده هم پیام شفاف می‌دهد).
  const upd = await tx
    .update(contractInstallments)
    .set({ status: "paid", method: "gateway", paymentId: pay.id, refId, paidAt: new Date() })
    .where(and(eq(contractInstallments.id, iid), eq(contractInstallments.workspaceId, pay.workspaceId), ne(contractInstallments.status, "paid")))
    .returning({ id: contractInstallments.id });
  if (upd.length > 0) return { applied: true, installmentId: upd[0].id };
  const [cur] = await tx
    .select({ id: contractInstallments.id })
    .from(contractInstallments)
    .where(and(eq(contractInstallments.id, iid), eq(contractInstallments.workspaceId, pay.workspaceId)));
  await tx.update(payments).set({ error: cur ? REFUND_DOUBLE : REFUND_ORPHAN }).where(eq(payments.id, pay.id));
  return { applied: true, installmentId: cur?.id ?? null };
}
