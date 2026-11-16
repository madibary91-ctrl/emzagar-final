"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, CreditCard, Loader2, ShieldCheck, Sparkles, Wallet, X } from "lucide-react";
import { useBfcacheReset } from "@/components/useBfcacheReset";
import { fa } from "@/lib/jalali";
import GatewayPicker from "@/components/GatewayPicker";
import type { CheckoutGateway } from "@/modules/payments/registry";
import { checkoutAction, type CheckoutState } from "@/modules/billing/actions";
import { limitLabel, planDurations, planFeatures, planOffersMonths, planPrice, type Plan, type PlanId } from "@/modules/billing/plans";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** کارت طرح‌ها با انتخاب مدت اشتراک؛ دکمه‌ی هر طرح فرم را با همان طرح ارسال می‌کند */
/** Proration: «طرح ← مدت(ماه) ← مبلغ نهایی/اعتبار/روز هدیه» و خلاصه‌ی اعتبار طرح فعلی (محاسبه‌ی سمت سرور) */
export type PlanProrations = Record<string, Record<string, { payable: number; discount: number; bonusDays: number }>>;
export type CreditSummary = { planName: string; remainingDays: number; value: number };

export default function CheckoutPanel({ plans, current, canBuy, mode, gateways, walletBalance, prorations = {}, credit = null, periodEnd = null }: { periodEnd?: string | null; plans: Plan[]; current: PlanId; canBuy: boolean; mode: "live" | "demo" | "none"; gateways: CheckoutGateway[]; walletBalance: number; prorations?: PlanProrations; credit?: CreditSummary | null }) {
  // مدت‌های قابل انتخاب = اجتماع مدت‌های طرح‌های پولی (هر طرح مدت‌ها و تخفیف خودش را دارد)
  const monthOptions = [...new Set(plans.filter((p) => !p.isDefault && p.priceToman > 0).flatMap((p) => planDurations(p).map(([m]) => m)))].sort((a, b) => a - b);
  const bestOff = (m: number) => Math.max(0, ...plans.filter((p) => !p.isDefault && p.priceToman > 0 && planOffersMonths(p, m)).map((p) => p.durations[m] ?? 0));
  const [months, setMonths] = useState<number>(monthOptions[0] ?? 1);
  const [method, setMethod] = useState<"gateway" | "wallet">("gateway");
  const [state, action, pending] = useActionState<CheckoutState, FormData>(checkoutAction, {});
  const [selected, setSelected] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState(0); // لحظه‌ی باز شدن خلاصه‌ی سفارش (برای برآورد تاریخ پایان؛ بدون فراخوانی ناخالص در رندر)
  const confirmRef = useRef<HTMLButtonElement>(null);
  useBfcacheReset();

  // مرحله‌ی «تأیید سفارش»: پیش از رفتن به درگاه/کسر از کیف پول، خلاصه‌ی دقیق را ببینید
  useEffect(() => {
    if (!selected) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !pending) setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, pending]);

  const quoteOf = (p: Plan) => {
    const pr = p.id !== current ? prorations[p.id]?.[String(months)] : undefined;
    const hasCredit = !!pr && (pr.discount > 0 || pr.bonusDays > 0);
    const list = planPrice(p, months);
    const payable = hasCredit ? pr!.payable : list;
    const bonus = hasCredit ? pr!.bonusDays : 0;
    const now = openedAt;
    const curEnd = periodEnd ? new Date(periodEnd).getTime() : 0;
    const base = p.id === current && curEnd > now ? curEnd : now;
    const endsAt = new Date(base + (months * 30 + bonus) * 86_400_000);
    return { list, payable, discount: hasCredit ? pr!.discount : 0, bonus, endsAt };
  };
  const sel = selected ? plans.find((p) => p.id === selected) ?? null : null;
  const selQuote = sel ? quoteOf(sel) : null;
  const shortfall = selQuote && method === "wallet" ? Math.max(0, selQuote.payable - walletBalance) : 0;

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

      {credit && credit.value > 0 && (
        <p className="mb-4 rounded-xl bg-emerald-50 p-3 text-xs font-semibold text-emerald-800">
          اعتبار باقی‌مانده‌ی طرح «{credit.planName}» ({fn(Math.ceil(credit.remainingDays))} روز) به ارزش {fn(credit.value)} تومان هنگام ارتقا یا تغییر طرح از مبلغ پرداختی کسر می‌شود؛ هیچ روزی از دست نمی‌رود.
        </p>
      )}
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
          const pr = !isCurrent ? prorations[id]?.[String(months)] : undefined;
          const hasCredit = !!pr && (pr.discount > 0 || pr.bonusDays > 0);
          return (
            <section key={id} className={`relative flex flex-col rounded-3xl border p-6 ${p.highlight ? "border-mint bg-ink text-white shadow-xl" : "border-ink/10 bg-white"}`}>
              {p.highlight && <span className="absolute -top-3 right-6 inline-flex items-center gap-1 rounded-full bg-mint px-3 py-1 text-xs font-black text-ink"><Sparkles size={12} />محبوب‌ترین</span>}
              <h3 className="text-lg font-black">{p.name}</h3>
              <p className={`mt-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>{p.tagline}</p>
              <div className="my-5">
                {hasCredit && offered && <span className="ml-2 text-sm line-through opacity-60">{fn(total)}</span>}
                <b className="text-3xl font-black">{p.priceToman === 0 ? "رایگان" : offered ? fn(hasCredit ? pr!.payable : total) : fn(p.priceToman)}</b>
                {p.priceToman > 0 && <span className={`mr-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>{offered ? `تومان / ${fn(months)} ماه` : "تومان / ماه"}</span>}
                {p.priceToman > 0 && offered && off > 0 && <span className="mr-2 text-xs font-bold text-emerald-500">{fn(off)}٪ تخفیف</span>}
              </div>
              {hasCredit && offered && (
                <p className={`-mt-3 mb-4 text-xs font-bold ${p.highlight ? "text-mint" : "text-emerald-700"}`}>
                  {pr!.discount > 0 && <>کسر اعتبار طرح فعلی: {fn(pr!.discount)} تومان</>}
                  {pr!.bonusDays > 0 && <>{pr!.discount > 0 ? " + " : ""}{fn(pr!.bonusDays)} روز تمدید هدیه</>}
                </p>
              )}
              <ul className="mb-6 flex-1 space-y-2 text-[13px]">
                {planFeatures(p).map((f) => (
                  <li key={f} className="flex items-start gap-2"><Check size={14} className="mt-0.5 shrink-0 text-emerald-500" />{f}</li>
                ))}
              </ul>
              {base ? (
                <span className={`btn-secondary pointer-events-none !min-h-10 opacity-60`}>{isCurrent ? "طرح فعلی شما" : "طرح پایه"}</span>
              ) : (
                <button type="button" onClick={() => { setOpenedAt(Date.now()); setSelected(id); }} disabled={!canBuy || pending || !offered || (method === "gateway" && mode === "none")} className={p.highlight ? "btn-mint" : "btn-primary"} data-testid={`buy-${id}`}>
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
      <p className="mt-4 flex items-center gap-1.5 text-xs text-ink/72"><ShieldCheck size={14} />فاکتور رسمی پس از پرداخت صادر می‌شود؛ مالیات بر ارزش افزوده (در صورت اعمال) شامل قیمت است و مبلغی جداگانه از شما نمی‌گیرند.</p>
      {sel && selQuote && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/55 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !pending) setSelected(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="order-title" className="w-full max-w-md rounded-3xl bg-white p-6 text-ink shadow-2xl" data-testid="order-dialog">
            <input type="hidden" name="plan" value={sel.id} />
            <div className="mb-4 flex items-start justify-between gap-3">
              <h2 id="order-title" className="text-lg font-black">تأیید سفارش</h2>
              <button type="button" onClick={() => setSelected(null)} disabled={pending} aria-label="بستن" className="rounded-lg p-1 text-ink/60 hover:bg-ink/5"><X size={18} /></button>
            </div>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-ink/70">طرح</dt><dd className="font-black">{sel.name} — {fn(months)} ماه</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/70">قیمت طرح</dt><dd>{fn(selQuote.list)} تومان</dd></div>
              {selQuote.discount > 0 && <div className="flex justify-between gap-3 text-emerald-700"><dt>کسر اعتبار طرح فعلی</dt><dd>−{fn(selQuote.discount)} تومان</dd></div>}
              {selQuote.bonus > 0 && <div className="flex justify-between gap-3 text-emerald-700"><dt>روز هدیه</dt><dd>+{fn(selQuote.bonus)} روز</dd></div>}
              <div className="flex justify-between gap-3 border-t border-ink/10 pt-2 text-base"><dt className="font-bold">مبلغ قابل پرداخت</dt><dd className="font-black" data-testid="order-payable">{fn(selQuote.payable)} تومان</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/70">روش پرداخت</dt><dd className="font-bold">{method === "wallet" ? `کیف پول (موجودی ${fn(walletBalance)})` : "درگاه بانکی"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/70">اعتبار تا حدود</dt><dd className="font-bold">{fa(selQuote.endsAt)}</dd></div>
            </dl>
            {method === "gateway" && <p className="mt-3 text-xs leading-6 text-ink/70">پس از تأیید به صفحه‌ی امن درگاه می‌روید و پس از پرداخت خودکار به همین صفحه برمی‌گردید.</p>}
            {shortfall > 0 && (
              <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold leading-6 text-amber-900" role="alert">
                موجودی کیف پول کافی نیست؛ {fn(shortfall)} تومان کم دارید.{" "}
                <Link href={`/admin/wallet?need=${shortfall}`} className="font-black underline">شارژ همین مبلغ</Link>
                {" "}یا <button type="button" className="font-black underline" onClick={() => setMethod("gateway")}>پرداخت آنلاین</button>
              </p>
            )}
            {state.error && (
              <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-semibold leading-6 text-red-700">
                {state.error}
                {state.shortfall ? <> <Link href={`/admin/wallet?need=${state.shortfall}`} className="font-black underline">شارژ کیف پول</Link></> : null}
              </p>
            )}
            <div className="mt-5 flex gap-2">
              <button ref={confirmRef} disabled={pending || shortfall > 0} className="btn-primary flex-1" data-testid="order-confirm">
                {pending ? <Loader2 size={15} className="animate-spin" /> : null}
                {method === "wallet" ? "تأیید و پرداخت از کیف پول" : "تأیید و رفتن به درگاه"}
              </button>
              <button type="button" onClick={() => setSelected(null)} disabled={pending} className="btn-secondary">انصراف</button>
            </div>
          </div>
        </div>
      )}
      {!canBuy && <p className="mt-3 text-xs text-ink/75">فقط مالک یا مدیر فضای کاری می‌تواند اشتراک تهیه کند.</p>}
    </form>
  );
}
