import { Wallet } from "lucide-react";
import PayInstallments from "@/components/pay/PayInstallments";
import PayPlanEditor, { type SavedRow } from "@/components/pay/PayPlanEditor";
import { fa, faTime } from "@/lib/jalali";
import { contractGateways } from "@/modules/payments/workspace";
import { listInstallments, STATE_LABELS, stateOf, summarize } from "@/modules/contract-pay/service";
import { payerSigner } from "@/modules/contract-pay/gate";
import { KIND_LABELS, type InstallmentKind, type PlanItem } from "@/modules/contract-pay/schedule";
import { toPayItems } from "@/modules/contract-pay/view";

type Props = {
  contract: { id: number; status: string; workspaceId: number; contractValue: number | null };
  signers: { id: number; position: number; userId: number; label: string; status: string }[];
  userId: number;
  isAdmin: boolean;
  canWrite: boolean;
  canDelete: boolean;
};

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** بخش «امضا و پرداخت» صفحه‌ی قرارداد: مدیر برنامه را می‌سازد/پیگیری می‌کند و پرداخت‌کننده آنلاین می‌پردازد */
export default async function ContractPaySection({ contract, signers, userId, isAdmin, canWrite, canDelete }: Props) {
  const rows = await listInstallments(contract.id);
  const canEditPlan = canWrite && (contract.status === "draft" || contract.status === "sent") && signers.every((s) => s.status === "pending") && !rows.some((r) => r.status === "paid");

  if (isAdmin && (canWrite || rows.length > 0)) {
    const sum = summarize(rows);
    const initial: PlanItem[] = rows
      .filter((r) => r.status !== "cancelled")
      .map((r) => ({ title: r.title, kind: r.kind as InstallmentKind, amount: r.amount, dueAt: iso(r.dueAt), gate: r.gate === "before_sign" ? "before_sign" : "none", payerPosition: r.payerPosition }));
    const saved: SavedRow[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      kindLabel: KIND_LABELS[r.kind as InstallmentKind] ?? "پرداخت",
      amount: r.amount,
      dueText: r.dueAt ? fa(r.dueAt) : "هنگام امضا",
      status: r.status,
      method: r.method,
      paidText: r.paidAt ? faTime(r.paidAt) : "",
      gate: r.gate === "before_sign",
      payUrlPath: `/pay/${r.payCode}`,
      stateLabel: STATE_LABELS[stateOf(r, contract.status)],
    }));
    return (
      <section id="pay" className="panel-solid scroll-mt-24 space-y-4 p-5 sm:p-6" aria-labelledby="payplan-title">
        <div className="flex flex-wrap items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><Wallet size={18} /></span>
          <div className="flex-1">
            <h2 id="payplan-title" className="text-sm font-black">امضا و پرداخت — بیعانه، اقساط و پرداخت مرحله‌ای</h2>
            <p className="mt-0.5 text-xs leading-6 text-ink/72">برنامه‌ی پرداخت در متن قرارداد درج می‌شود. اگر بیعانه «پیش‌شرط امضا» باشد، مشتری تا نپردازد نمی‌تواند امضا کند. سررسیدها خودکار یادآوری می‌شوند.</p>
          </div>
          {rows.length > 0 && <span className="badge border border-ink/10 bg-stone-50">دریافت‌شده: {sum.paid.toLocaleString("fa-IR")} از {sum.total.toLocaleString("fa-IR")} تومان</span>}
        </div>
        <PayPlanEditor contractId={contract.id} initial={initial} editable={canEditPlan} saved={saved} payers={signers.map((s) => ({ position: s.position, label: s.label }))} canDelete={canDelete} contractValue={contract.contractValue} />
      </section>
    );
  }

  // پرداخت‌کننده‌ی دارای حساب کاربری
  const mine = rows.filter((r) => payerSigner(signers, r.payerPosition)?.userId === userId);
  if (mine.length === 0 || !["sent", "signed"].includes(contract.status)) return null;
  const gateways = await contractGateways(contract.workspaceId);
  return <PayInstallments items={toPayItems(mine, contract.status)} gateways={gateways.map((g) => ({ id: g.id, label: g.label, blurb: g.blurb, own: g.own }))} />;
}
