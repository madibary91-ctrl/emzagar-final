import { CreditCard, CheckCircle2, AlertTriangle } from "lucide-react";
import Shell from "@/components/Shell";
import CheckoutPanel from "@/components/CheckoutPanel";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { getPlan, getSubscription, getUsage, listPayments } from "@/modules/billing/service";
import { availableGateways, checkoutMode } from "@/modules/payments/registry";
import { getWallet } from "@/modules/wallet/service";
import Link from "next/link";
import { getDefaultPlan, listAllPlans } from "@/modules/billing/catalog";
import { limitLabel } from "@/modules/billing/plans";
import { fa, faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const GW_LABEL: Record<string, string> = { zarinpal: "زرین‌پال", zibal: "زیبال", idpay: "آیدی‌پی", payir: "Pay.ir", sandbox: "آزمایشی", wallet: "کیف پول" };
const PAY_STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: "موفق", cls: "bg-emerald-50 text-emerald-700" },
  pending: { label: "در انتظار", cls: "bg-amber-50 text-amber-700" },
  failed: { label: "ناموفق", cls: "bg-red-50 text-red-700" },
};

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
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ pay?: string; msg?: string }> }) {
  const team = await requireTeam("settings");
  const sp = await searchParams;
  const [sub, plan, usage, history, gateways, mode, wallet, catalog, base] = await Promise.all([getSubscription(team.workspaceId), getPlan(team.workspaceId), getUsage(team.workspaceId), listPayments(team.workspaceId), availableGateways(), checkoutMode(), getWallet(team.workspaceId), listAllPlans(), getDefaultPlan()]);
  // نمایش به مشتری: طرح‌های فعالِ عمومی + طرح فعلی خود فضا (حتی اگر خصوصی باشد تا بتواند تمدید کند)
  const offered = catalog.filter((p) => p.isActive && (p.isPublic || p.id === plan.id));
  const nameOf = (id: string) => catalog.find((p) => p.id === id)?.name ?? id;
  const canBuy = can(team.wsRole, "settings");

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><CreditCard size={22} />اشتراک و پرداخت</h1>
      <p className="mb-5 text-xs text-ink/72">طرح فضای کاری «{team.workspaceName}»</p>

      {sp.pay && (
        <div role="status" className={`mb-5 flex items-center gap-2 rounded-2xl p-4 text-sm font-bold ${sp.pay === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {sp.pay === "ok" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          {String(sp.msg || "").slice(0, 200)}
        </div>
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

      <CheckoutPanel plans={offered} current={plan.id} canBuy={canBuy} mode={mode} gateways={gateways} walletBalance={wallet.balance} />
      <p className="mt-3 text-xs text-ink/75">سقف ماهانه کم آمد؟ بدون ارتقای طرح، از <Link href="/admin/wallet" className="font-bold text-ink underline">کیف پول</Link> بسته‌ی اعتباری قرارداد بخرید ({wallet.credits.toLocaleString("fa-IR")} قرارداد اعتبار دارید).</p>

      <section className="panel-solid mt-8 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">تاریخچه‌ی پرداخت‌ها</h2>
        <table className="w-full min-w-[640px]">
          <thead><tr><th className="th">تاریخ</th><th className="th">طرح</th><th className="th">مدت</th><th className="th">مبلغ (تومان)</th><th className="th">روش</th><th className="th">وضعیت</th><th className="th">کد پیگیری</th></tr></thead>
          <tbody>
            {history.map((p) => {
              const st = PAY_STATUS[p.status] ?? PAY_STATUS.pending;
              return (
                <tr key={p.id} className="border-t border-ink/[.07]">
                  <td className="td text-xs">{faTime(p.createdAt)}</td>
                  <td className="td font-bold">{p.kind === "topup" ? "شارژ کیف پول" : nameOf(p.plan)}</td>
                  <td className="td">{fn(p.months)} ماه</td>
                  <td className="td">{fn(p.amount)}</td>
                  <td className="td text-xs">{GW_LABEL[p.gateway] ?? p.gateway}</td>
                  <td className="td"><span className={`badge ${st.cls}`}>{st.label}</span></td>
                  <td className="td font-mono text-xs" dir="ltr">{p.refId || "—"}</td>
                </tr>
              );
            })}
            {history.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-xs text-ink/72">هنوز پرداختی ثبت نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
