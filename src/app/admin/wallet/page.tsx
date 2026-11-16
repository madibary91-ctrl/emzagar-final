import Link from "next/link";
import { redirect } from "next/navigation";
import { FileSignature, Gift, RefreshCw, Wallet, Info } from "lucide-react";
import PaymentResult, { GW_LABEL } from "@/components/PaymentResult";
import { getCurrentUser } from "@/modules/auth/session";
import { loginNextFor, readFlash } from "@/lib/flash";
import { paymentReceipt, recentOpenTopups } from "@/modules/billing/receipt";
import { recheckPaymentAction } from "@/modules/billing/actions";
import Shell from "@/components/Shell";
import WalletPanel from "@/components/WalletPanel";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { getPlan, getUsage } from "@/modules/billing/service";
import { availableGateways, checkoutMode } from "@/modules/payments/registry";
import { getWallet, listWalletTransactions } from "@/modules/wallet/service";
import { TOPUP_MAX, TOPUP_MIN, TX_KIND_LABELS } from "@/modules/wallet/packs";
import { toLatinDigits } from "@/modules/kyc/rules";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** کیف پول فضای کاری: موجودی، اعتبار قرارداد، شارژ، خرید بسته و دفتر تراکنش‌ها */
export default async function WalletPage({ searchParams }: { searchParams: Promise<{ pay?: string; msg?: string; pid?: string; sig?: string; need?: string }> }) {
  const sp = await searchParams;
  if (sp.pay && !(await getCurrentUser())) redirect(loginNextFor("/admin/wallet", sp));
  const team = await requireTeam("settings");
  const flash = readFlash(sp);
  // «کمبود موجودی» از صفحه‌ی خرید اشتراک: مبلغ پیشنهادی شارژ (گرد به بالا تا هزار تومان، در بازه‌ی مجاز)
  const needRaw = Number(toLatinDigits(String(sp.need ?? "")));
  const need = Number.isFinite(needRaw) && needRaw > 0 ? Math.min(TOPUP_MAX, Math.max(TOPUP_MIN, Math.ceil(needRaw / 1000) * 1000)) : null;
  const [wallet, plan, usage, gateways, mode, tx, openTopups, receipt] = await Promise.all([getWallet(team.workspaceId), getPlan(team.workspaceId), getUsage(team.workspaceId), availableGateways(), checkoutMode(), listWalletTransactions(team.workspaceId, 40), recentOpenTopups(team.workspaceId), flash?.pid ? paymentReceipt(team.workspaceId, flash.pid) : Promise.resolve(null)]);
  const left = plan.contractsPerMonth < 0 ? -1 : Math.max(0, plan.contractsPerMonth - usage.contracts);

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Wallet size={22} />کیف پول</h1>
      <p className="mb-5 text-xs text-ink/72">فضای کاری «{team.workspaceName}»</p>

      {flash && <PaymentResult flash={flash} receipt={receipt} from="wallet" />}
      {need && !flash && (
        <p role="status" className="mb-5 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900"><Info size={18} className="mt-0.5 shrink-0" />برای خرید اشتراک با کیف پول، {fn(need)} تومان شارژ لازم است؛ مبلغ پیشنهادی در فرم شارژ پر شده است. پس از پرداخت می‌توانید <Link href="/admin/billing#plans" className="underline">به خرید اشتراک برگردید</Link>.</p>
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

      <WalletPanel initialAmount={need ?? undefined} gateways={gateways} canBuy={can(team.wsRole, "settings")} balance={wallet.balance} mode={mode} />

      {openTopups.length > 0 && (
        <section className="panel-solid mt-5 p-5" aria-labelledby="open-topups">
          <h2 id="open-topups" className="mb-1 font-bold">شارژهای تکمیل‌نشده (۷ روز اخیر)</h2>
          <p className="mb-3 text-xs text-ink/72">اگر پرداخت کرده‌اید ولی به سایت برنگشتید، «بررسی وضعیت» را بزنید تا نتیجه از درگاه گرفته و اعمال شود. شارژ ناتمام هیچ مبلغی از شما کم نمی‌کند.</p>
          <ul className="divide-y divide-ink/[.07]">
            {openTopups.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs">
                <span><b>{fn(t.amount)} تومان</b> · {GW_LABEL[t.gateway] ?? t.gateway} · {faTime(t.createdAt)}</span>
                <span className="flex items-center gap-3">
                  <span className={`badge ${t.phase.cls}`}>{t.phase.label}</span>
                  {t.phase.canRecheck && (
                    <form action={recheckPaymentAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <input type="hidden" name="from" value="wallet" />
                      <button className="inline-flex items-center gap-1 font-bold underline"><RefreshCw size={12} />بررسی وضعیت</button>
                    </form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
