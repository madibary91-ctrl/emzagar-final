import { AlertTriangle, Archive, CheckCircle2, Crown, Eye, EyeOff, Gift, Layers, Plus, Star, Users } from "lucide-react";
import Shell from "@/components/Shell";
import PlanDeleteButton from "@/components/PlanDeleteButton";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { listAllPlans, planStats } from "@/modules/billing/catalog";
import { assignPlanAction, createPlanAction, setDefaultPlanAction, updatePlanAction } from "@/modules/billing/plan-actions";
import { durationsToText, limitLabel, type Plan } from "@/modules/billing/plans";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

const SAVED: Record<string, string> = {
  created: "طرح جدید ساخته شد و بلافاصله در سایت اعمال شد.",
  updated: "تغییرات طرح ذخیره شد. قیمت و مدت جدید روی خریدهای بعدی اثر می‌گذارد و سقف‌ها برای همه‌ی مشترکان فوری اعمال می‌شود.",
  default: "طرح پیش‌فرض تغییر کرد؛ فضاهای بدون اشتراک فعال از این پس روی این طرح هستند.",
  deleted: "طرح کاملاً حذف شد.",
  archived: "طرح سابقه‌ی اشتراک/پرداخت داشت؛ بایگانی شد (از فروش خارج شد ولی مشترکان فعلی حفظ شدند).",
  assigned: "طرح به فضای کاری اختصاص یافت.",
  revoked: "اشتراک پولی فضای کاری لغو شد و به طرح پیش‌فرض برگشت.",
};

function Check({ name, label, checked, hint }: { name: string; label: string; checked?: boolean; hint?: string }) {
  return (
    <label className="flex items-start gap-2 text-xs font-bold">
      <input type="checkbox" name={name} defaultChecked={checked} className="mt-0.5" />
      <span>{label}{hint && <span className="mt-0.5 block font-normal text-ink/70">{hint}</span>}</span>
    </label>
  );
}

/** فیلدهای مشترک فرم ساخت و ویرایش طرح */
function PlanFields({ p, k }: { p?: Plan; k: string }) {
  const contractsUnlimited = p ? p.contractsPerMonth < 0 : false;
  const membersUnlimited = p ? p.members < 0 : false;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor={`${k}-name`}>نام طرح</label>
          <input id={`${k}-name`} name="name" required maxLength={40} defaultValue={p?.name} className="input" placeholder="مثلاً استارتر" />
        </div>
        {!p && (
          <div>
            <label className="label" htmlFor={`${k}-id`}>شناسه (لاتین، بعداً تغییر نمی‌کند)</label>
            <input id={`${k}-id`} name="id" required dir="ltr" pattern="[a-z][a-z0-9_\-]{1,29}" className="input" placeholder="starter" />
          </div>
        )}
        <div>
          <label className="label" htmlFor={`${k}-price`}>قیمت ماهانه (تومان)</label>
          <input id={`${k}-price`} name="priceToman" required inputMode="numeric" dir="ltr" defaultValue={p?.priceToman ?? 0} className="input" />
        </div>
        <div>
          <label className="label" htmlFor={`${k}-sort`}>ترتیب نمایش (کوچک‌تر = اول)</label>
          <input id={`${k}-sort`} name="sortOrder" inputMode="numeric" dir="ltr" defaultValue={p?.sortOrder ?? 100} className="input" />
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <label className="label" htmlFor={`${k}-tag`}>توضیح کوتاه</label>
          <input id={`${k}-tag`} name="tagline" maxLength={120} defaultValue={p?.tagline} className="input" placeholder="برای چه کسانی مناسب است؟" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-ink/10 p-3">
          <label className="label" htmlFor={`${k}-contracts`}>سقف قرارداد در ماه</label>
          <input id={`${k}-contracts`} name="contractsPerMonth" inputMode="numeric" dir="ltr" defaultValue={contractsUnlimited ? "" : (p?.contractsPerMonth ?? 10)} className="input" />
          <div className="mt-2"><Check name="contractsUnlimited" label="نامحدود" checked={contractsUnlimited} /></div>
        </div>
        <div className="rounded-2xl border border-ink/10 p-3">
          <label className="label" htmlFor={`${k}-members`}>سقف اعضای تیم</label>
          <input id={`${k}-members`} name="members" inputMode="numeric" dir="ltr" defaultValue={membersUnlimited ? "" : (p?.members ?? 2)} className="input" />
          <div className="mt-2"><Check name="membersUnlimited" label="نامحدود" checked={membersUnlimited} /></div>
        </div>
        <div className="rounded-2xl border border-ink/10 p-3">
          <label className="label" htmlFor={`${k}-ai`}>درخواست هوش مصنوعی در ۲۴ ساعت</label>
          <input id={`${k}-ai`} name="aiPerDay" inputMode="numeric" dir="ltr" defaultValue={p?.aiPerDay ?? 8} className="input" />
          <p className="mt-2 text-xs text-ink/70">۰ = بدون دسترسی به هوش مصنوعی</p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <label className="label" htmlFor={`${k}-dur`}>مدت‌های قابل خرید و تخفیف (ماه:درصد)</label>
          <input id={`${k}-dur`} name="durations" required dir="ltr" defaultValue={p ? durationsToText(p.durations) : "1:0, 3:10, 6:17, 12:25"} className="input" placeholder="1:0, 3:10, 12:25" />
          <p className="mt-1 text-xs leading-6 text-ink/70">هر مدت با ویرگول جدا می‌شود؛ مثلاً «۱:۰ ، ۱۲:۲۵» یعنی ماهانه بدون تخفیف و سالانه با ۲۵٪ تخفیف. هر تعداد ماه (۱ تا ۶۰) ممکن است.</p>
        </div>
        <div>
          <label className="label" htmlFor={`${k}-feat`}>ویژگی‌های نمایشی (هر خط یک مورد)</label>
          <textarea id={`${k}-feat`} name="features" rows={4} defaultValue={p?.features.join("\n")} className="input !h-auto py-3 leading-7" placeholder={"خالی بگذارید تا از روی سقف‌ها خودکار ساخته شود"} />
        </div>
      </div>

      <div className="grid gap-3 rounded-2xl bg-ink/[.035] p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Check name="isPublic" label="عمومی" checked={p?.isPublic ?? true} hint="در صفحه‌ی تعرفه و لندینگ نمایش داده می‌شود و کاربران خودشان می‌خرند. غیرعمومی = فقط با اختصاص دستی." />
        <Check name="isActive" label="فعال (قابل فروش)" checked={p?.isActive ?? true} hint="با برداشتن تیک، طرح بایگانی می‌شود؛ مشترکان فعلی حفظ می‌شوند." />
        <Check name="highlight" label="برجسته (محبوب‌ترین)" checked={p?.highlight ?? false} />
        <Check name="isRewardPlan" label="طرح پاداش دعوت دوستان" checked={p?.isRewardPlan ?? false} hint="روزهای هدیه‌ی دعوت روی این طرح فعال می‌شود (فقط یک طرح)." />
      </div>
    </div>
  );
}

/** مدیریت پویای طرح‌های اشتراک: ایجاد، ویرایش، حذف، پیش‌فرض/عمومی و اختصاص دستی (فقط مدیر کل) */
export default async function PlansPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; plan?: string }> }) {
  const admin = await requirePlatformAdmin();
  const sp = await searchParams;
  const [plans, stats] = await Promise.all([listAllPlans(), planStats()]);
  const live = plans.filter((p) => p.isActive);
  const paidPlans = plans.filter((p) => !p.isDefault);
  const totalActive = Object.values(stats).reduce((a, s) => a + s.activeSubscribers, 0);

  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Layers size={22} />طرح‌های اشتراک</h1>
      <p className="mb-5 text-xs leading-6 text-ink/72">قیمت، مدت، سقف‌ها و نمایش طرح‌ها را اینجا مدیریت کنید؛ هر تغییر بدون دست‌زدن به کد و بلافاصله در صفحه‌ی تعرفه، لندینگ، پرداخت و محدودیت‌ها اعمال می‌شود.</p>

      {sp.saved && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 size={18} className="shrink-0" />{SAVED[sp.saved] ?? "ذخیره شد."}</p>}
      {sp.error && <p role="alert" className="mb-4 flex items-center gap-2 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700"><AlertTriangle size={18} className="shrink-0" />{String(sp.error).slice(0, 300)}</p>}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><Layers size={14} />طرح‌های فعال</span><b className="mt-1 block text-xl font-black">{fn(live.length)} از {fn(plans.length)}</b></div>
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><Eye size={14} />نمایش عمومی</span><b className="mt-1 block text-xl font-black">{fn(live.filter((p) => p.isPublic).length)} طرح</b></div>
        <div className="panel-solid p-5"><span className="flex items-center gap-1.5 text-xs font-semibold text-ink/72"><Users size={14} />مشترک پولی فعال</span><b className="mt-1 block text-xl font-black">{fn(totalActive)}</b></div>
      </div>

      <details className="panel-solid mb-6 p-5">
        <summary className="flex cursor-pointer items-center gap-2 font-bold"><Plus size={18} />ساخت طرح جدید</summary>
        <form action={createPlanAction} className="mt-5">
          <PlanFields k="new" />
          <button className="btn-primary mt-5"><Plus size={15} />ایجاد طرح</button>
        </form>
      </details>

      <div className="space-y-4">
        {plans.map((p) => {
          const st = stats[p.id] ?? { activeSubscribers: 0, totalSubscribers: 0, payments: 0 };
          const hasHistory = st.totalSubscribers + st.payments > 0;
          return (
            <details key={p.id} className="panel-solid p-5" open={sp.plan === p.id ? true : undefined}>
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <b className="text-lg font-black">{p.name}</b>
                <code className="rounded bg-ink/5 px-1.5 py-0.5 text-xs" dir="ltr">{p.id}</code>
                {p.isDefault && <span className="badge bg-mint/30 text-ink"><Crown size={12} />پیش‌فرض</span>}
                {!p.isActive && <span className="badge bg-stone-200 text-ink/75"><Archive size={12} />بایگانی</span>}
                {p.isActive && (p.isPublic ? <span className="badge bg-emerald-50 text-emerald-700"><Eye size={12} />عمومی</span> : <span className="badge bg-amber-50 text-amber-800"><EyeOff size={12} />خصوصی</span>)}
                {p.highlight && <span className="badge bg-violet-50 text-violet-700"><Star size={12} />برجسته</span>}
                {p.isRewardPlan && <span className="badge bg-sky-50 text-sky-700"><Gift size={12} />پاداش دعوت</span>}
                <span className="mr-auto text-xs text-ink/72">
                  {p.priceToman ? `${fn(p.priceToman)} تومان / ماه` : "رایگان"} · {limitLabel(p.contractsPerMonth)} قرارداد · {limitLabel(p.members)} عضو · {fn(st.activeSubscribers)} مشترک فعال
                </span>
              </summary>

              <form action={updatePlanAction} className="mt-5">
                <input type="hidden" name="id" value={p.id} />
                <PlanFields p={p} k={`p-${p.id}`} />
                <button className="btn-primary mt-5">ذخیره‌ی تغییرات</button>
              </form>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink/10 pt-4">
                {!p.isDefault && p.isActive && (
                  <form action={setDefaultPlanAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <button className="btn-secondary btn-sm" disabled={p.priceToman !== 0} title={p.priceToman !== 0 ? "طرح پیش‌فرض باید رایگان باشد" : undefined}><Crown size={13} />پیش‌فرض کردن</button>
                  </form>
                )}
                {!p.isDefault && <PlanDeleteButton id={p.id} name={p.name} hasHistory={hasHistory} />}
                {p.isDefault && <span className="text-xs text-ink/70">طرح پیش‌فرض حذف نمی‌شود؛ برای حذف آن ابتدا طرح رایگان دیگری را پیش‌فرض کنید.</span>}
                <span className="mr-auto text-xs text-ink/70">{fn(st.totalSubscribers)} اشتراک ثبت‌شده · {fn(st.payments)} پرداخت</span>
              </div>
            </details>
          );
        })}
      </div>

      <form action={assignPlanAction} className="panel-solid mt-8 p-5">
        <h2 className="mb-1 flex items-center gap-2 font-bold"><Users size={18} />اختصاص دستی طرح به یک فضای کاری</h2>
        <p className="mb-4 text-xs leading-6 text-ink/72">برای طرح‌های خصوصی/قراردادی یا هدیه‌ی ویژه: بدون پرداخت، طرح را برای چند ماه فعال کنید. اگر فضای کاری همین الان همین طرح را دارد، مدت به انتهای دوره‌ی فعلی اضافه می‌شود.</p>
        <div className="grid items-end gap-3 sm:grid-cols-[140px_1fr_120px_auto_auto]">
          <div><label className="label" htmlFor="as-ws">شناسه‌ی فضای کاری</label><input id="as-ws" name="workspaceId" required inputMode="numeric" dir="ltr" className="input" placeholder="12" /></div>
          <div>
            <label className="label" htmlFor="as-plan">طرح</label>
            <select id="as-plan" name="plan" className="input" defaultValue={paidPlans[0]?.id}>
              {paidPlans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isActive ? "" : " (بایگانی)"}{p.isPublic ? "" : " — خصوصی"}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="as-months">مدت (ماه)</label><input id="as-months" name="months" inputMode="numeric" dir="ltr" defaultValue={1} className="input" /></div>
          <button name="intent" value="assign" className="btn-primary" disabled={paidPlans.length === 0}>اختصاص طرح</button>
          <button name="intent" value="revoke" formNoValidate className="btn-danger" title="فقط شناسه‌ی فضای کاری لازم است">لغو اشتراک پولی</button>
        </div>
      </form>
    </Shell>
  );
}
