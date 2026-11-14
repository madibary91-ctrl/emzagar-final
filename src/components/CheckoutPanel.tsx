"use client";

import { useActionState, useState } from "react";
import { Check, CreditCard, Loader2, Sparkles, Wallet } from "lucide-react";
import GatewayPicker from "@/components/GatewayPicker";
import type { CheckoutGateway } from "@/modules/payments/registry";
import { checkoutAction, type CheckoutState } from "@/modules/billing/actions";
import { limitLabel, planDurations, planFeatures, planOffersMonths, planPrice, type Plan, type PlanId } from "@/modules/billing/plans";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** کارت طرح‌ها با انتخاب مدت اشتراک؛ دکمه‌ی هر طرح فرم را با همان طرح ارسال می‌کند */
export default function CheckoutPanel({ plans, current, canBuy, mode, gateways, walletBalance }: { plans: Plan[]; current: PlanId; canBuy: boolean; mode: "live" | "demo" | "none"; gateways: CheckoutGateway[]; walletBalance: number }) {
  // مدت‌های قابل انتخاب = اجتماع مدت‌های طرح‌های پولی (هر طرح مدت‌ها و تخفیف خودش را دارد)
  const monthOptions = [...new Set(plans.filter((p) => !p.isDefault && p.priceToman > 0).flatMap((p) => planDurations(p).map(([m]) => m)))].sort((a, b) => a - b);
  const bestOff = (m: number) => Math.max(0, ...plans.filter((p) => !p.isDefault && p.priceToman > 0 && planOffersMonths(p, m)).map((p) => p.durations[m] ?? 0));
  const [months, setMonths] = useState<number>(monthOptions[0] ?? 1);
  const [method, setMethod] = useState<"gateway" | "wallet">("gateway");
  const [state, action, pending] = useActionState<CheckoutState, FormData>(checkoutAction, {});

  return (
    <form action={action}>
      <input type="hidden" name="months" value={months} />
      <input type="hidden" name="method" value={method} />
      <div role="radiogroup" aria-label="مدت اشتراک" className="mb-5 inline-flex flex-wrap gap-1 rounded-2xl border border-ink/10 bg-white p-1">
        {monthOptions.map((m) => (
          <button
            type="button"
            key={m}
            role="radio"
            aria-checked={months === m}
            onClick={() => setMonths(m)}
            className={`rounded-xl px-4 py-2 text-xs font-bold transition ${months === m ? "bg-ink text-white" : "text-ink/75 hover:bg-ink/5"}`}
          >
            {fn(m)} ماهه
            {bestOff(m) > 0 && <span className={`mr-1.5 text-xs ${months === m ? "text-mint" : "text-emerald-700"}`}>{fn(bestOff(m))}٪ تخفیف</span>}
          </button>
        ))}
      </div>

      <div role="radiogroup" aria-label="روش پرداخت" className="mb-4 inline-flex flex-wrap gap-1 rounded-2xl border border-ink/10 bg-white p-1">
        <button type="button" role="radio" aria-checked={method === "gateway"} onClick={() => setMethod("gateway")} className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition ${method === "gateway" ? "bg-ink text-white" : "text-ink/75 hover:bg-ink/5"}`}><CreditCard size={14} />پرداخت آنلاین</button>
        <button type="button" role="radio" aria-checked={method === "wallet"} onClick={() => setMethod("wallet")} className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition ${method === "wallet" ? "bg-ink text-white" : "text-ink/75 hover:bg-ink/5"}`}><Wallet size={14} />کیف پول ({fn(walletBalance)} تومان)</button>
      </div>
      {method === "gateway" && <GatewayPicker gateways={gateways} />}

      {state.error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{state.error}</p>}
      {mode === "demo" && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">حالت آزمایشی: درگاه واقعی تنظیم نشده و پرداخت به‌صورت شبیه‌سازی‌شده انجام می‌شود (درگاه واقعی را در «مدیریت پلتفرم ← تجارت و درگاه‌ها» فعال کنید).</p>}
      {mode === "none" && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">درگاه پرداخت هنوز توسط مدیر پلتفرم فعال نشده است.</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((p) => {
          const id = p.id;
          const isCurrent = id === current;
          const base = p.isDefault || p.priceToman === 0;
          const offered = planOffersMonths(p, months);
          const total = planPrice(p, months);
          const off = p.durations[months] ?? 0;
          return (
            <section key={id} className={`relative flex flex-col rounded-3xl border p-6 ${p.highlight ? "border-mint bg-ink text-white shadow-xl" : "border-ink/10 bg-white"}`}>
              {p.highlight && <span className="absolute -top-3 right-6 inline-flex items-center gap-1 rounded-full bg-mint px-3 py-1 text-xs font-black text-ink"><Sparkles size={12} />محبوب‌ترین</span>}
              <h3 className="text-lg font-black">{p.name}</h3>
              <p className={`mt-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>{p.tagline}</p>
              <div className="my-5">
                <b className="text-3xl font-black">{p.priceToman === 0 ? "رایگان" : offered ? fn(total) : fn(p.priceToman)}</b>
                {p.priceToman > 0 && <span className={`mr-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>{offered ? `تومان / ${fn(months)} ماه` : "تومان / ماه"}</span>}
                {p.priceToman > 0 && offered && off > 0 && <span className="mr-2 text-xs font-bold text-emerald-500">{fn(off)}٪ تخفیف</span>}
              </div>
              <ul className="mb-6 flex-1 space-y-2 text-[13px]">
                {planFeatures(p).map((f) => (
                  <li key={f} className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-emerald-500" />{f}</li>
                ))}
              </ul>
              {base ? (
                <span className={`btn-secondary pointer-events-none !min-h-10 opacity-60`}>{isCurrent ? "طرح فعلی شما" : "طرح پایه"}</span>
              ) : (
                <button name="plan" value={id} disabled={!canBuy || pending || !offered || (method === "gateway" && mode === "none")} className={p.highlight ? "btn-mint" : "btn-primary"}>
                  {pending ? <Loader2 size={15} className="animate-spin" /> : null}
                  {!offered ? `بدون گزینه‌ی ${fn(months)} ماهه` : isCurrent ? "تمدید اشتراک" : "ارتقا و پرداخت"}
                </button>
              )}
              <p className={`mt-3 text-center text-xs ${p.highlight ? "text-white/65" : "text-ink/72"}`}>
                {limitLabel(p.contractsPerMonth)} قرارداد/ماه · {limitLabel(p.members)} عضو
              </p>
            </section>
          );
        })}
      </div>
      {!canBuy && <p className="mt-3 text-xs text-ink/75">فقط مالک یا مدیر فضای کاری می‌تواند اشتراک تهیه کند.</p>}
    </form>
  );
}
