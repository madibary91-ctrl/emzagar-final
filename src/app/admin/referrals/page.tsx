import { Gift, Trophy, Users } from "lucide-react";
import Shell from "@/components/Shell";
import ReferralShare from "@/components/ReferralShare";
import { requireTeam } from "@/modules/tenancy/context";
import { getOrigin } from "@/lib/request";
import { faTime } from "@/lib/jalali";
import { REFERRAL_STATUS } from "@/modules/referral/config";
import { getOrCreateCode, getReferralConfig, referralOverview } from "@/modules/referral/service";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** دعوت از دوستان: لینک اختصاصی، قوانین پاداش، پیشرفت تا جایزه‌ی بعدی و فهرست دعوت‌ها */
export default async function ReferralsPage() {
  const team = await requireTeam("view");
  const [code, cfg, ov, origin] = await Promise.all([getOrCreateCode(team.id), getReferralConfig(), referralOverview(team.id), getOrigin()]);
  const link = `${origin}/r/${code}`;
  const rules: string[] = [];
  if (cfg.referrerWallet > 0) rules.push(`${fn(cfg.referrerWallet)} تومان اعتبار کیف پول`);
  if (cfg.referrerCredits > 0) rules.push(`${fn(cfg.referrerCredits)} قرارداد اعتبار`);
  const progress = cfg.milestoneEvery > 0 ? ((ov.qualified % cfg.milestoneEvery) / cfg.milestoneEvery) * 100 : 0;

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Gift size={22} />دعوت از دوستان</h1>
      <p className="mb-5 text-xs text-ink/72">دوستانتان را دعوت کنید؛ هر دو طرف هدیه می‌گیرید.</p>

      {!cfg.enabled && <div className="mb-5 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800">برنامه‌ی دعوت از دوستان فعلاً توسط مدیر پلتفرم غیرفعال شده است.</div>}

      <section className="panel-solid mb-5 p-5">
        <h2 className="mb-3 font-bold">لینک اختصاصی شما</h2>
        <ReferralShare link={link} code={code} text="با امضاگیر قراردادهایت را آنلاین و معتبر امضا کن 👇" />
      </section>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        {[
          { label: "دعوت‌شده", value: fn(ov.invited), icon: Users },
          { label: "در انتظار اولین قرارداد", value: fn(ov.pending), icon: Users },
          { label: "دعوت موفق", value: fn(ov.qualified), icon: Trophy },
          { label: "پاداش دریافتی", value: `${fn(ov.earnedWallet)} تومان`, icon: Gift, hint: `${fn(ov.earnedCredits)} قرارداد · ${fn(ov.earnedDays)} روز اشتراک` },
        ].map((c) => (
          <div key={c.label} className="panel-solid p-5">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><c.icon size={14} />{c.label}</span>
            <b className="mt-1 block text-xl font-black">{c.value}</b>
            {"hint" in c && c.hint && <span className="text-xs text-ink/70">{c.hint}</span>}
          </div>
        ))}
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <section className="panel-solid p-5">
          <h2 className="mb-3 font-bold">قوانین پاداش</h2>
          <ul className="space-y-2 text-sm leading-7">
            <li>🎁 شما: برای هر دوستی که ثبت‌نام کند و <b>اولین قرارداد واقعی</b> را صادر کند، {rules.join(" و ") || "—"}.</li>
            <li>🤝 دوست شما: {cfg.referredWallet > 0 ? `${fn(cfg.referredWallet)} تومان` : ""}{cfg.referredWallet > 0 && cfg.referredCredits > 0 ? " و " : ""}{cfg.referredCredits > 0 ? `${fn(cfg.referredCredits)} قرارداد` : ""} هدیه‌ی خوشامد.</li>
            {cfg.milestoneEvery > 0 && cfg.milestoneDays > 0 && <li>🏆 به‌ازای هر {fn(cfg.milestoneEvery)} دعوت موفق، <b>{fn(cfg.milestoneDays)} روز اشتراک رایگان</b> (حرفه‌ای) هدیه می‌گیرید.</li>}
            <li className="text-xs text-ink/70">ثبت‌نام با موبایل یکسان یا چند ثبت‌نام از یک شبکه پاداش نمی‌گیرد؛ سقف پاداش هر کاربر {fn(cfg.maxRewarded)} دعوت است.</li>
          </ul>
          {cfg.milestoneEvery > 0 && cfg.milestoneDays > 0 && (
            <div className="mt-4">
              <div className="mb-1 flex justify-between text-xs font-bold"><span>تا جایزه‌ی بعدی</span><span>{fn(ov.toNextMilestone)} دعوت دیگر</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-label="پیشرفت تا اشتراک رایگان" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><div className="h-full rounded-full bg-mint" style={{ width: `${progress}%` }} /></div>
            </div>
          )}
        </section>

        <section className="panel-solid overflow-x-auto">
          <h2 className="px-5 pt-5 font-bold">دعوت‌های شما</h2>
          <table className="w-full min-w-[420px]">
            <thead><tr><th className="th">دوست</th><th className="th">تاریخ</th><th className="th">وضعیت</th><th className="th">پاداش</th></tr></thead>
            <tbody>
              {ov.list.map((r) => {
                const st = REFERRAL_STATUS[r.status] ?? REFERRAL_STATUS.pending;
                return (
                  <tr key={r.id} className="border-t border-ink/[.07]">
                    <td className="td font-bold">{r.name}</td>
                    <td className="td text-xs">{faTime(r.createdAt)}</td>
                    <td className="td"><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    <td className="td text-xs">{r.status === "qualified" ? `${fn(r.wallet)} تومان${r.credits ? ` + ${fn(r.credits)} قرارداد` : ""}${r.days ? ` + ${fn(r.days)} روز` : ""}` : "—"}</td>
                  </tr>
                );
              })}
              {ov.list.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-xs text-ink/72">هنوز کسی با لینک شما ثبت‌نام نکرده است.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </Shell>
  );
}
