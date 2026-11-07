"use client";

import { useActionState, useState } from "react";
import { Check, Loader2, Package, Plus, Sparkles } from "lucide-react";
import GatewayPicker from "@/components/GatewayPicker";
import type { CheckoutGateway } from "@/modules/payments/registry";
import { buyPackAction, topupAction, type WalletState } from "@/modules/wallet/actions";
import { CREDIT_PACKS, TOPUP_MAX, TOPUP_MIN, TOPUP_PRESETS, perContract } from "@/modules/wallet/packs";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** شارژ کیف پول (درگاه‌های چندگانه) و خرید بسته‌های اعتبار قرارداد از موجودی */
export default function WalletPanel({ gateways, canBuy, balance, mode }: { gateways: CheckoutGateway[]; canBuy: boolean; balance: number; mode: "live" | "demo" | "none" }) {
  const [amount, setAmount] = useState<string>(String(TOPUP_PRESETS[1]));
  const [top, topAction, topPending] = useActionState<WalletState, FormData>(topupAction, {});
  const [buy, buyAction, buyPending] = useActionState<WalletState, FormData>(buyPackAction, {});

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="panel-solid p-5" aria-labelledby="topup-h">
        <h2 id="topup-h" className="mb-1 flex items-center gap-2 font-black"><Plus size={18} />شارژ کیف پول</h2>
        <p className="mb-4 text-xs text-ink/72">مبلغ را انتخاب کنید و از طریق یکی از درگاه‌های پرداخت شارژ کنید.</p>
        <form action={topAction}>
          <div className="mb-3 flex flex-wrap gap-2">
            {TOPUP_PRESETS.map((p) => (
              <button type="button" key={p} onClick={() => setAmount(String(p))} className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${amount === String(p) ? "border-ink bg-ink text-white" : "border-ink/12 bg-white hover:border-ink/30"}`}>{fn(p)}</button>
            ))}
          </div>
          <label className="label" htmlFor="topup-amount">مبلغ دلخواه (تومان)</label>
          <input id="topup-amount" name="amount" inputMode="numeric" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} className="input mb-1" required />
          <p className="mb-4 text-xs text-ink/70">حداقل {fn(TOPUP_MIN)} و حداکثر {fn(TOPUP_MAX)} تومان</p>
          {mode === "demo" && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">حالت آزمایشی: پرداخت شبیه‌سازی می‌شود.</p>}
          {mode === "none" && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">درگاه پرداخت هنوز توسط مدیر پلتفرم فعال نشده است.</p>}
          <GatewayPicker gateways={gateways} />
          {top.error && <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{top.error}</p>}
          <button disabled={!canBuy || topPending || mode === "none"} className="btn-primary w-full">
            {topPending && <Loader2 size={15} className="animate-spin" />}
            شارژ و پرداخت
          </button>
          {!canBuy && <p className="mt-2 text-xs text-ink/75">فقط مالک یا مدیر فضای کاری می‌تواند شارژ کند.</p>}
        </form>
      </section>

      <section className="panel-solid p-5" aria-labelledby="packs-h">
        <h2 id="packs-h" className="mb-1 flex items-center gap-2 font-black"><Package size={18} />بسته‌های اعتبار قرارداد</h2>
        <p className="mb-4 text-xs text-ink/72">وقتی سقف ماهانه‌ی طرح پر شد، اعتبار بسته به‌صورت خودکار مصرف می‌شود. اعتبار منقضی نمی‌شود.</p>
        {buy.error && <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{buy.error}</p>}
        {buy.ok && <p role="status" className="mb-3 flex items-center gap-1.5 rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-800"><Check size={14} />{buy.message}</p>}
        <ul className="space-y-3">
          {CREDIT_PACKS.map((p) => (
            <li key={p.id}>
              <form action={buyAction} className={`relative flex items-center justify-between gap-3 rounded-2xl border p-4 ${p.popular ? "border-mint bg-mint/10" : "border-ink/10"}`}>
                <input type="hidden" name="pack" value={p.id} />
                <div>
                  <b className="flex items-center gap-1.5 text-sm">{p.name}{p.popular && <span className="inline-flex items-center gap-1 rounded-full bg-mint px-2 py-0.5 text-[11px] font-black text-ink"><Sparkles size={10} />به‌صرفه‌ترین انتخاب</span>}</b>
                  <span className="text-xs text-ink/72">{fn(p.priceToman)} تومان · هر قرارداد {fn(perContract(p))} تومان</span>
                </div>
                <button disabled={!canBuy || buyPending || balance < p.priceToman} title={balance < p.priceToman ? "موجودی کافی نیست" : undefined} className="btn-primary btn-sm shrink-0">
                  {buyPending ? <Loader2 size={14} className="animate-spin" /> : null}
                  خرید با کیف پول
                </button>
              </form>
            </li>
          ))}
        </ul>
        {balance < CREDIT_PACKS[0].priceToman && <p className="mt-3 text-xs text-ink/72">برای خرید بسته، ابتدا کیف پول را شارژ کنید.</p>}
      </section>
    </div>
  );
}
