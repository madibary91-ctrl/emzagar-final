import { redirect } from "next/navigation";
import { CreditCard, RefreshCw } from "lucide-react";
import Shell from "@/components/Shell";
import CheckoutPanel from "@/components/CheckoutPanel";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { getPlan, getSubscription, getUsage, listPayments } from "@/modules/billing/service";
import { availableGateways, checkoutMode } from "@/modules/payments/registry";
import { getWallet } from "@/modules/wallet/service";
import Link from "next/link";
import PaymentResult, { GW_LABEL } from "@/components/PaymentResult";
import { getCurrentUser } from "@/modules/auth/session";
import { loginNextFor, readFlash } from "@/lib/flash";
import { paymentPhase } from "@/modules/billing/payment-status";
import { paymentReceipt } from "@/modules/billing/receipt";
import { recheckPaymentAction } from "@/modules/billing/actions";
import { getDefaultPlan, listAllPlans } from "@/modules/billing/catalog";
import { limitLabel } from "@/modules/billing/plans";
import { fa, faTime } from "@/lib/jalali";
import { computeProration, remainingCredit } from "@/modules/billing/proration";
import { listInvoices } from "@/modules/billing/invoices";
import { planOffersMonths, planDurations } from "@/modules/billing/plans";
import { serverNow } from "@/lib/clock";

export const dynamic = "force-dynamic";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit < 0 ? Math.min(100, used > 0 ? 8 : 0) : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
  const hot = limit >= 0 && pct >= 90;
  return (
    <div className="panel-solid p-5">
      <div className="mb-2 flex items-baseline justify-between text-xs">
        <span className="font-bold text-ink/75">{label}</span>
        <span className="font-black">{fn(used)} <span className="font-medium text-ink/72">/ {limitLabel(limit)}</span></span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit < 0 ? undefined : limit} aria-label={label}>
        <div className={`h-full rounded-full ${hot ? "bg-coral" : "bg-mint"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** اشتراک و پرداخت: طرح فعلی، مصرف و ارتقا */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ pay?: string; msg?: string; pid?: string; sig?: string; all?: string }> }) {
  const sp = await searchParams;
  // بازگشت از درگاه با نشست تمام‌شده: پس از ورود، همان نتیجه نمایش داده شود (نه صفحه‌ی خالی/پنل)
  if (sp.pay && !(await getCurrentUser())) redirect(loginNextFor("/admin/billing", sp));
  const team = await requireTeam("settings");
  const flash = readFlash(sp);
  const showAll = sp.all === "1";
  const [sub, plan, usage, history, gateways, mode, wallet, catalog, base] = await Promise.all([getSubscription(team.workspaceId), getPlan(team.workspaceId), getUsage(team.workspaceId), listPayments(team.workspaceId, showAll ? 200 : 20), availableGateways(), checkoutMode(), getWallet(team.workspaceId), listAllPlans(), getDefaultPlan()]);
  // نمایش به مشتری: طرح‌های فعالِ عمومی + طرح فعلی خود فضا (حتی اگر خصوصی باشد تا بتواند تمدید کند)
  const offered = catalog.filter((p) => p.isActive && (p.isPublic || p.id === plan.id));
  const nameOf = (id: string) => catalog.find((p) => p.id === id)?.name ?? id;
  const canBuy = can(team.wsRole, "settings");

  // Proration: اعتبار روزهای باقی‌مانده‌ی طرح فعلی ← قیمت نهایی هر طرح/مدت (فقط نمایش؛ مبلغ واقعی هنگام پرداخت دوباره در سرور محاسبه می‌شود)
  const cur = await remainingCredit(team.workspaceId);
  const prorations: Record<string, Record<string, { payable: number; discount: number; bonusDays: number }>> = {};
  if (cur && cur.value > 0) {
    for (const p of offered) {
      if (p.isDefault || p.priceToman <= 0 || p.id === cur.planId) continue;
      for (const [m] of planDurations(p)) {
        if (!planOffersMonths(p, m)) continue;
        const r = await computeProration(team.workspaceId, p, m);
        (prorations[p.id] ??= {})[String(m)] = { payable: r.payable, discount: r.discount, bonusDays: r.bonusDays };
      }
    }
  }
  const [invoiceRows] = await Promise.all([listInvoices(team.workspaceId, 200)]);
  const invoiceOf = new Map(invoiceRows.filter((i) => i.kind === "invoice" && i.paymentId).map((i) => [i.paymentId as number, i]));
  const receipt = flash?.pid ? await paymentReceipt(team.workspaceId, flash.pid) : null;
  const daysLeft = sub.periodEnd ? Math.ceil((sub.periodEnd.getTime() - serverNow()) / 86_400_000) : null;

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><CreditCard size={22} />اشتراک و پرداخت</h1>
      <p className="mb-5 text-xs text-ink/72">طرح فضای کاری «{team.workspaceName}»</p>

      {flash && <PaymentResult flash={flash} receipt={receipt} from="billing" />}
      {daysLeft !== null && daysLeft <= 7 && (
        <div role="status" className="mb-5 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800">اشتراک شما {daysLeft <= 0 ? "امروز" : `${fn(daysLeft)} روز دیگر`} منقضی می‌شود؛ برای جلوگیری از بازگشت به طرح پایه، همین حالا تمدید کنید.</div>
      )}
      {sub.expired && <div className="mb-5 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800">اشتراک شما منقضی شده و فضای کاری به طرح پایه («{base.name}») بازگشته است.</div>}

      <section className="panel-solid mb-5 flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <span className="text-xs font-semibold text-ink/72">طرح فعلی</span>
          <b className="block text-2xl font-black">{plan.name}</b>
        </div>
        <div className="text-left text-xs text-ink/75 max-sm:text-right">
          {sub.periodEnd ? <>اعتبار تا <b className="text-ink">{fa(sub.periodEnd)}</b></> : "بدون محدودیت زمانی"}
        </div>
      </section>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Meter label="قرارداد این ماه" used={usage.contracts} limit={plan.contractsPerMonth} />
        <Meter label="اعضای تیم" used={usage.members} limit={plan.members} />
        <Meter label="هوش مصنوعی (۲۴ ساعت اخیر)" used={usage.ai} limit={plan.aiPerDay} />
      </div>

      <div id="plans" className="scroll-mt-24" />
      <CheckoutPanel periodEnd={sub.periodEnd ? sub.periodEnd.toISOString() : null} plans={offered} current={plan.id} canBuy={canBuy} mode={mode} gateways={gateways} walletBalance={wallet.balance} prorations={prorations} credit={cur && cur.value > 0 ? { planName: nameOf(cur.planId), remainingDays: cur.remainingDays, value: cur.value } : null} />
      <p className="mt-3 text-xs text-ink/75">سقف ماهانه کم آمد؟ بدون ارتقای طرح، از <Link href="/admin/wallet" className="font-bold text-ink underline">کیف پول</Link> بسته‌ی اعتباری قرارداد بخرید ({wallet.credits.toLocaleString("fa-IR")} قرارداد اعتبار دارید).</p>

      <section className="panel-solid mt-8 overflow-x-auto">
        <div className="flex items-center justify-between px-5 pt-5"><h2 className="font-bold">تاریخچه‌ی پرداخت‌ها</h2><Link href="/admin/billing/invoices" className="text-xs font-bold text-ink underline">همه‌ی فاکتورها</Link></div>
        <table className="w-full min-w-[640px]">
          <thead><tr><th className="th">تاریخ</th><th className="th">طرح</th><th className="th">مدت</th><th className="th">مبلغ (تومان)</th><th className="th">روش</th><th className="th">وضعیت</th><th className="th">کد پیگیری</th><th className="th">فاکتور</th></tr></thead>
          <tbody>
            {history.map((p) => {
              const st = paymentPhase(p);
              const inv = invoiceOf.get(p.id);
              return (
                <tr key={p.id} className="border-t border-ink/[.07] align-top">
                  <td className="td text-xs">{faTime(p.createdAt)}</td>
                  <td className="td font-bold">{p.kind === "topup" ? "شارژ کیف پول" : nameOf(p.plan)}</td>
                  <td className="td">{p.kind === "topup" ? "—" : `${fn(p.months)} ماه`}</td>
                  <td className="td">{fn(p.amount)}</td>
                  <td className="td text-xs">{GW_LABEL[p.gateway] ?? p.gateway}</td>
                  <td className="td">
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {p.refundedAmount > 0 && st.phase !== "refunded" && <span className="badge mr-1 bg-stone-100 text-stone-700">{fn(p.refundedAmount)} مسترد</span>}
                    {st.hint && <p className="mt-1 max-w-[260px] text-[11px] leading-5 text-ink/70">{st.hint}</p>}
                    {(st.canRecheck || st.canRetry) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        {st.canRecheck && (
                          <form action={recheckPaymentAction}>
                            <input type="hidden" name="id" value={p.id} />
                            <button className="inline-flex items-center gap-1 text-[11px] font-bold underline"><RefreshCw size={11} />بررسی وضعیت</button>
                          </form>
                        )}
                        {st.canRetry && p.kind !== "topup" && <a href="#plans" className="text-[11px] font-bold underline">پرداخت دوباره</a>}
                        {st.canRetry && p.kind === "topup" && <Link href="/admin/wallet" className="text-[11px] font-bold underline">شارژ دوباره</Link>}
                      </div>
                    )}
                  </td>
                  <td className="td font-mono text-xs" dir="ltr">{p.refId || "—"}</td>
                  <td className="td text-xs">
                    {inv ? <a className="font-bold underline" href={`/api/billing/invoices/${inv.id}/pdf`}>{inv.number}</a>
                      : st.phase === "paid" && p.kind === "subscription" ? <span className="text-ink/70">در حال صدور</span>
                      : p.kind === "topup" && st.phase === "paid" ? <span className="text-ink/60" title="فاکتور رسمی هنگام خرید اشتراک با این اعتبار صادر می‌شود">پیش‌دریافت</span> : "—"}
                  </td>
                </tr>
              );
            })}
            {history.length === 0 && <tr><td colSpan={8} className="py-10 text-center text-xs text-ink/72">هنوز پرداختی ثبت نشده است.</td></tr>}
          </tbody>
        </table>
        {!showAll && history.length >= 20 && <div className="border-t border-ink/[.07] px-5 py-3 text-center"><Link href="/admin/billing?all=1" className="text-xs font-bold underline">نمایش همه‌ی پرداخت‌ها</Link></div>}
      </section>
    </Shell>
  );
}
