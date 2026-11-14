import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileSignature, Gift, Wallet } from "lucide-react";
import Shell from "@/components/Shell";
import WalletPanel from "@/components/WalletPanel";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { getPlan, getUsage } from "@/modules/billing/service";
import { availableGateways, checkoutMode } from "@/modules/payments/registry";
import { getWallet, listWalletTransactions } from "@/modules/wallet/service";
import { TX_KIND_LABELS } from "@/modules/wallet/packs";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** کیف پول فضای کاری: موجودی، اعتبار قرارداد، شارژ، خرید بسته و دفتر تراکنش‌ها */
export default async function WalletPage({ searchParams }: { searchParams: Promise<{ pay?: string; msg?: string }> }) {
  const team = await requireTeam("settings");
  const sp = await searchParams;
  const [wallet, plan, usage, gateways, mode, tx] = await Promise.all([getWallet(team.workspaceId), getPlan(team.workspaceId), getUsage(team.workspaceId), availableGateways(), checkoutMode(), listWalletTransactions(team.workspaceId, 40)]);
  const left = plan.contractsPerMonth < 0 ? -1 : Math.max(0, plan.contractsPerMonth - usage.contracts);

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Wallet size={22} />کیف پول</h1>
      <p className="mb-5 text-xs text-ink/72">فضای کاری «{team.workspaceName}»</p>

      {sp.pay && (
        <div role="status" className={`mb-5 flex items-center gap-2 rounded-2xl p-4 text-sm font-bold ${sp.pay === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {sp.pay === "ok" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          {String(sp.msg || "").slice(0, 200)}
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="panel-solid p-5">
          <span className="text-xs font-semibold text-ink/72">موجودی کیف پول</span>
          <b className="mt-1 block text-2xl font-black" data-testid="wallet-balance">{fn(wallet.balance)} <span className="text-sm font-bold text-ink/70">تومان</span></b>
        </div>
        <div className="panel-solid p-5">
          <span className="text-xs font-semibold text-ink/72">اعتبار قرارداد (بسته‌ای)</span>
          <b className="mt-1 block text-2xl font-black" data-testid="wallet-credits">{fn(wallet.credits)} <span className="text-sm font-bold text-ink/70">قرارداد</span></b>
        </div>
        <div className="panel-solid p-5">
          <span className="flex items-center gap-1 text-xs font-semibold text-ink/72"><FileSignature size={13} />سهمیه‌ی باقی‌مانده‌ی این ماه</span>
          <b className="mt-1 block text-2xl font-black">{left < 0 ? "نامحدود" : fn(left)} <span className="text-sm font-bold text-ink/70">از {left < 0 ? "∞" : fn(plan.contractsPerMonth)}</span></b>
        </div>
      </div>

      <WalletPanel gateways={gateways} canBuy={can(team.wsRole, "settings")} balance={wallet.balance} mode={mode} />

      <p className="mt-5 flex items-center gap-2 rounded-2xl bg-mint/15 p-4 text-xs font-semibold">
        <Gift size={16} className="shrink-0" />
        بدون پرداخت هم می‌توانید اعتبار بگیرید: دوستانتان را دعوت کنید و برای هر دعوت موفق پاداش بگیرید.
        <Link href="/admin/referrals" className="mr-auto rounded-lg bg-ink px-3 py-1.5 text-xs font-bold text-white">دعوت دوستان</Link>
      </p>

      <section className="panel-solid mt-8 overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">دفتر تراکنش‌ها</h2>
        <table className="w-full min-w-[620px]">
          <thead><tr><th className="th">تاریخ</th><th className="th">نوع</th><th className="th">شرح</th><th className="th">تغییر</th><th className="th">مانده</th></tr></thead>
          <tbody>
            {tx.map((t) => {
              const unit = t.asset === "credits" ? "قرارداد" : "تومان";
              return (
                <tr key={t.id} className="border-t border-ink/[.07]">
                  <td className="td text-xs">{faTime(t.createdAt)}</td>
                  <td className="td text-xs font-bold">{TX_KIND_LABELS[t.kind] ?? t.kind}</td>
                  <td className="td text-xs text-ink/75">{t.description || "—"}</td>
                  <td className={`td font-bold ${t.amount >= 0 ? "text-emerald-700" : "text-red-700"}`} dir="ltr">{t.amount >= 0 ? "+" : "−"}{fn(Math.abs(t.amount))} <span className="text-xs font-medium text-ink/70">{unit}</span></td>
                  <td className="td text-xs" dir="ltr">{fn(t.balanceAfter)} {unit}</td>
                </tr>
              );
            })}
            {tx.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-xs text-ink/72">هنوز تراکنشی ثبت نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
