import Link from "next/link";
import { AlertTriangle, CheckCircle2, Gift, Landmark, ShieldCheck, Wallet } from "lucide-react";
import Shell from "@/components/Shell";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { listGatewayStatuses } from "@/modules/payments/registry";
import { gatewayStats } from "@/modules/payments/service";
import { saveGatewaysAction, saveReferralConfigAction } from "@/modules/payments/actions";
import { saveKycThresholdAction } from "@/modules/kyc/actions";
import { getKycThreshold, kycCounts } from "@/modules/kyc/service";
import { getReferralConfig, platformReferralOverview } from "@/modules/referral/service";
import { walletTotals } from "@/modules/wallet/service";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const SOURCE: Record<string, string> = { panel: "ذخیره‌شده در پنل", env: "از متغیر محیطی", sim: "شبیه‌ساز", none: "تنظیم نشده" };

function Num({ name, label, value, hint }: { name: string; label: string; value: number; hint?: string }) {
  return (
    <div>
      <label className="label" htmlFor={`rc-${name}`}>{label}</label>
      <input id={`rc-${name}`} name={name} type="number" min={0} defaultValue={value} dir="ltr" className="input" />
      {hint && <p className="mt-1 text-xs text-ink/70">{hint}</p>}
    </div>
  );
}

/** تجارت و درگاه‌ها: چنددرگاهی با اولویت و Failover، پاداش دعوت از دوستان، کیف پول و آستانه‌ی KYC */
export default async function CommercePage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const admin = await requirePlatformAdmin();
  const sp = await searchParams;
  const [gws, stats, refCfg, refOv, wt, kyc, threshold] = await Promise.all([listGatewayStatuses(), gatewayStats(), getReferralConfig(), platformReferralOverview(), walletTotals(), kycCounts(), getKycThreshold()]);
  const statOf = (id: string) => stats.find((s) => s.gateway === id);

  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 text-2xl font-black">تجارت و درگاه‌ها</h1>
      <p className="mb-5 text-xs text-ink/72">درگاه‌های پرداخت، پاداش دعوت از دوستان، کیف پول کاربران و الزام احراز هویت</p>

      {sp.saved && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 size={18} />تنظیمات ذخیره شد.</p>}
      {sp.error && <p role="alert" className="mb-4 flex items-center gap-2 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700"><AlertTriangle size={18} />{String(sp.error).slice(0, 200)}</p>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><Wallet size={14} />موجودی کیف پول کاربران</span><b className="mt-1 block text-xl font-black">{fn(wt.balance)} تومان</b><span className="text-xs text-ink/70">{fn(wt.credits)} قرارداد اعتبار · {fn(wt.wallets)} کیف پول</span></div>
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><Gift size={14} />دعوت‌های موفق</span><b className="mt-1 block text-xl font-black">{fn(refOv.qualified)} از {fn(refOv.total)}</b><span className="text-xs text-ink/70">پاداش پرداختی: {fn(refOv.wallet)} تومان</span></div>
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><ShieldCheck size={14} />احراز هویت در انتظار</span><b className="mt-1 block text-xl font-black">{fn(kyc.pending)}</b><Link href="/platform/kyc" className="text-xs font-bold underline">رفتن به صف بررسی</Link></div>
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><Landmark size={14} />درگاه‌های فعال</span><b className="mt-1 block text-xl font-black">{fn(gws.filter((g) => g.configured && g.enabled).length)} از {fn(gws.length)}</b></div>
      </div>

      <form action={saveGatewaysAction} className="panel-solid mb-6 p-5">
        <h2 className="mb-1 flex items-center gap-2 font-bold"><Landmark size={18} />درگاه‌های پرداخت</h2>
        <p className="mb-4 text-xs leading-6 text-ink/72">کاربر درگاه موردنظرش را انتخاب می‌کند. اگر درگاهی پاسخ ندهد، همان پرداخت خودکار با درگاه بعدی (به ترتیب اولویت) دوباره تلاش می‌شود و درگاهی که ۳ خطای پشت‌سرهم داشته باشد ۳ دقیقه از انتخاب خودکار کنار می‌رود. کلیدها رمزنگاری‌شده ذخیره می‌شوند؛ برای حفظ مقدار فعلی، فیلد را خالی بگذارید.</p>
        <div className="space-y-3">
          {gws.map((g) => {
            const st = statOf(g.id);
            const total = (st?.paid ?? 0) + (st?.failed ?? 0);
            return (
              <div key={g.id} className="rounded-2xl border border-ink/10 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <b>{g.label}</b>
                  <span className={`badge ${g.configured ? "bg-emerald-50 text-emerald-700" : "bg-stone-100 text-ink/75"}`}>{SOURCE[g.source]}</span>
                  {g.degraded && <span className="badge bg-amber-50 text-amber-800" title={g.lastError}>ناپایدار — تلاش مجدد تا {fn(g.retryInSec)} ثانیه‌ی دیگر</span>}
                  <span className="text-xs text-ink/70">{g.blurb}</span>
                  <span className="mr-auto text-xs text-ink/70">۳۰ روز اخیر: {fn(st?.paid ?? 0)} موفق · {fn(st?.failed ?? 0)} ناموفق{total > 0 ? ` (${fn(Math.round(((st?.paid ?? 0) / total) * 100))}٪ موفقیت)` : ""} · {fn(st?.sum ?? 0)} تومان</span>
                </div>
                <div className="grid items-end gap-3 sm:grid-cols-[90px_1fr_auto_auto]">
                  <div><label className="label" htmlFor={`gp-${g.id}`}>اولویت</label><input id={`gp-${g.id}`} name={`priority_${g.id}`} type="number" min={1} max={9} defaultValue={g.priority} dir="ltr" className="input" /></div>
                  <div><label className="label" htmlFor={`gc-${g.id}`}>{g.credentialLabel}</label><input id={`gc-${g.id}`} name={`cred_${g.id}`} type="password" autoComplete="off" dir="ltr" className="input" placeholder={g.configured ? "••••••••  (بدون تغییر)" : g.envVar} /></div>
                  <label className="flex items-center gap-2 pb-3 text-xs font-bold"><input type="checkbox" name={`enabled_${g.id}`} defaultChecked={g.enabled} />فعال</label>
                  <label className="flex items-center gap-2 pb-3 text-xs text-ink/75"><input type="checkbox" name={`clear_${g.id}`} />حذف کلید</label>
                </div>
              </div>
            );
          })}
        </div>
        <button className="btn-primary mt-4">ذخیره‌ی درگاه‌ها</button>
      </form>

      <div className="grid gap-6 lg:grid-cols-2">
        <form action={saveReferralConfigAction} className="panel-solid p-5">
          <h2 className="mb-1 flex items-center gap-2 font-bold"><Gift size={18} />پاداش دعوت از دوستان</h2>
          <p className="mb-4 text-xs leading-6 text-ink/72">پاداش پس از «اولین قرارداد واقعی» دوست و تایید ایمیل او پرداخت می‌شود (ضد ثبت‌نام ساختگی).</p>
          <label className="mb-4 flex items-center gap-2 text-sm font-bold"><input type="checkbox" name="enabled" defaultChecked={refCfg.enabled} />برنامه‌ی دعوت فعال باشد</label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Num name="referrerWallet" label="پاداش دعوت‌کننده (تومان)" value={refCfg.referrerWallet} />
            <Num name="referrerCredits" label="پاداش دعوت‌کننده (اعتبار قرارداد)" value={refCfg.referrerCredits} />
            <Num name="referredWallet" label="هدیه‌ی دوست (تومان)" value={refCfg.referredWallet} />
            <Num name="referredCredits" label="هدیه‌ی دوست (اعتبار قرارداد)" value={refCfg.referredCredits} />
            <Num name="milestoneEvery" label="اشتراک رایگان به‌ازای هر … دعوت" value={refCfg.milestoneEvery} hint="۰ = غیرفعال" />
            <Num name="milestoneDays" label="مدت اشتراک رایگان (روز)" value={refCfg.milestoneDays} />
            <Num name="maxRewarded" label="سقف دعوت پاداش‌دار هر کاربر" value={refCfg.maxRewarded} />
          </div>
          <button className="btn-primary mt-4">ذخیره‌ی پاداش‌ها</button>
          {refOv.top.length > 0 && (
            <div className="mt-5 border-t border-ink/10 pt-4">
              <h3 className="mb-2 text-xs font-bold">برترین دعوت‌کنندگان</h3>
              <ul className="space-y-1 text-xs">
                {refOv.top.map((t) => <li key={t.userId} className="flex justify-between"><span>{t.name} <span className="text-ink/60" dir="ltr">{t.email}</span></span><b>{fn(t.n)} موفق / {fn(t.all)}</b></li>)}
              </ul>
            </div>
          )}
        </form>

        <form action={saveKycThresholdAction} className="panel-solid h-fit p-5">
          <h2 className="mb-1 flex items-center gap-2 font-bold"><ShieldCheck size={18} />الزام احراز هویت (KYC)</h2>
          <p className="mb-4 text-xs leading-6 text-ink/72">قراردادی که ارزش آن برابر یا بیشتر از این مبلغ باشد فقط برای فضای کاری با هویت تاییدشده صادر می‌شود. ۰ = غیرفعال.</p>
          <label className="label" htmlFor="kyc-th">آستانه‌ی ارزش قرارداد (تومان)</label>
          <input id="kyc-th" name="threshold" inputMode="numeric" dir="ltr" defaultValue={threshold} className="input" />
          <button className="btn-primary mt-4">ذخیره‌ی آستانه</button>
          <p className="mt-3 text-xs text-ink/70">تایید شده: {fn(kyc.approved)} · رد شده: {fn(kyc.rejected)} · در انتظار: {fn(kyc.pending)}</p>
        </form>
      </div>
    </Shell>
  );
}
