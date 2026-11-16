import { fa, faTime } from "@/lib/jalali";
import type { PayItemView } from "@/components/pay/PayInstallments";
import type { Installment } from "./service";
import { KIND_LABELS, type InstallmentKind } from "./schedule";

/** تبدیل ردیف‌های دیتابیس به مدل نمایشی صفحه‌ی پرداخت (فقط داده‌ی لازم؛ بدون شناسه‌های داخلی) */
export function toPayItems(rows: Installment[], contractStatus: string): PayItemView[] {
  const now = Date.now();
  return rows.map((r) => ({
    code: r.payCode,
    title: r.title,
    kindLabel: KIND_LABELS[r.kind as InstallmentKind] ?? "پرداخت",
    amount: r.amount,
    dueText: r.dueAt ? fa(r.dueAt) : "هنگام امضا",
    status: r.status === "paid" ? "paid" : r.status === "cancelled" ? "cancelled" : "pending",
    gate: r.gate === "before_sign",
    paidText: r.paidAt ? faTime(r.paidAt) : undefined,
    refId: r.refId,
    overdue: r.status === "pending" && contractStatus === "signed" && !!r.dueAt && r.dueAt.getTime() < now - 86400_000,
  }));
}
