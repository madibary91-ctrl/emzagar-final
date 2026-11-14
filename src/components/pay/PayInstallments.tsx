"use client";

import { useState } from "react";
import { BadgeCheck, CreditCard, Lock, LoaderCircle, Wallet } from "lucide-react";
import { startPayAction } from "@/modules/contract-pay/actions";

export type PayItemView = {
  code: string;
  title: string;
  kindLabel: string;
  amount: number;
  dueText: string;
  status: "pending" | "paid" | "cancelled";
  gate: boolean;
  paidText?: string;
  refId?: string | null;
  overdue?: boolean;
};
export type GatewayView = { id: string; label: string; blurb: string; own: boolean };

const fmt = (n: number) => n.toLocaleString("fa-IR");

/** پنل «تعهدات مالی»: برنامه‌ی پرداخت و دکمه‌ی پرداخت آنلاین هر مورد (در صفحه‌ی امضا و لینک پرداخت عمومی) */
export default function PayInstallments({ items, gateways, signToken, title = "تعهدات مالی قرارداد", intro }: { items: PayItemView[]; gateways: GatewayView[]; signToken?: string; title?: string; intro?: string }) {
  const [gw, setGw] = useState(gateways[0]?.id ?? "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const live = items.filter((i) => i.status !== "cancelled");
  const total = live.reduce((s, i) => s + i.amount, 0);
  const paid = live.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount, 0);
  const pct = total ? Math.round((paid / total) * 100) : 0;
  const blocking = live.filter((i) => i.status === "pending" && i.gate);

  const pay = async (code: string) => {
    setError("");
    setBusy(code);
    const r = await startPayAction(code, gw || undefined, signToken);
    if (r.ok && r.url) {
      window.location.href = r.url;
      return;
    }
    setBusy("");
    setError(r.error || "شروع پرداخت انجام نشد");
  };

  return (
    <section className="panel-solid space-y-4 p-5 sm:p-6" aria-labelledby="pay-title" id="pay">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pay-title" className="flex items-center gap-2 text-base font-black"><Wallet size={18} />{title}</h2>
        <span className="badge border border-ink/10 bg-stone-50 text-ink/80">پرداخت‌شده: {fmt(paid)} از {fmt(total)} تومان</span>
      </div>
      {intro && <p className="text-xs leading-7 text-ink/75">{intro}</p>}
      <div className="h-2 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="پیشرفت پرداخت">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
      {blocking.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-7 text-amber-900" role="status">
          <Lock size={15} className="mt-1 shrink-0" />
          برای فعال‌شدن امضا، ابتدا {blocking.map((b) => `«${b.title}»`).join(" و ")} را پرداخت کنید. پس از پرداخت موفق، به همین صفحه برمی‌گردید و امضا فعال می‌شود.
        </p>
      )}
      {gateways.length > 1 && (
        <div>
          <label htmlFor="pay-gw" className="label">درگاه پرداخت</label>
          <select id="pay-gw" className="input" value={gw} onChange={(e) => setGw(e.target.value)}>
            {gateways.map((g) => <option key={g.id} value={g.id}>{g.label}{g.own ? " — مستقیم به حساب صادرکننده" : ""}</option>)}
          </select>
        </div>
      )}
      <ul className="divide-y divide-ink/[.07]">
        {live.map((i, idx) => (
          <li key={i.code} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <b className="text-sm">{idx + 1}. {i.title}</b>
              <span className="mr-2 text-xs text-ink/65">({i.kindLabel})</span>
              <p className={`mt-1 text-xs ${i.overdue ? "font-bold text-rose-600" : "text-ink/72"}`}>
                {i.status === "paid" ? <>پرداخت شد {i.paidText}{i.refId ? <> — پیگیری: <span dir="ltr" className="font-mono">{i.refId}</span></> : null}</> : <>سررسید: {i.dueText}{i.overdue ? " (گذشته)" : ""}{i.gate ? " — پیش‌شرط امضا" : ""}</>}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <b className="whitespace-nowrap text-sm">{fmt(i.amount)} تومان</b>
              {i.status === "paid" ? (
                <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-700"><BadgeCheck size={14} />پرداخت شد</span>
              ) : (
                <button type="button" className="btn-primary btn-mint btn-sm" disabled={!!busy || gateways.length === 0} onClick={() => pay(i.code)}>
                  {busy === i.code ? <LoaderCircle size={15} className="animate-spin" /> : <CreditCard size={15} />}پرداخت آنلاین
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {gateways.length === 0 && <p className="text-xs text-rose-600" role="alert">درگاه پرداخت فعالی در دسترس نیست؛ با صادرکننده‌ی قرارداد تماس بگیرید.</p>}
      {error && <p className="text-xs font-bold text-rose-600" role="alert">{error}</p>}
    </section>
  );
}
