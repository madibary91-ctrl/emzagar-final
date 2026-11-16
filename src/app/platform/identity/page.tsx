import { CheckCircle2, Fingerprint, ShieldAlert, ShieldCheck } from "lucide-react";
import Shell from "@/components/Shell";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { IDENTITY_MODES, getIdentityConfig } from "@/modules/identity/provider";
import { saveIdentityConfigAction } from "@/modules/identity/actions";
import { identityCounts } from "@/modules/identity/service";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** تنظیمات «احراز هویت اختیاری امضاکننده» (مدیر کل): سرویس استعلام شاهکار + هزینه + آمار */
export default async function PlatformIdentityPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const admin = await requirePlatformAdmin();
  const sp = await searchParams;
  const [cfg, counts] = await Promise.all([getIdentityConfig(), identityCounts()]);
  const ready = cfg.mode === "sandbox" || (cfg.mode === "zibal" && cfg.hasToken);
  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Fingerprint size={22} />احراز هویت اختیاری امضاکننده</h1>
      <p className="mb-5 max-w-3xl text-sm leading-7 text-ink/75">صادرکننده می‌تواند برای هر قرارداد حساس، «تأیید مالکیت شماره‌ی موبایل (شاهکار)» و/یا «مدارک هویتی» را فعال کند. اسناد روزمره همچنان سریع‌اند. سطح «مدارک هویتی» بدون هیچ سرویس بیرونی همیشه کار می‌کند؛ سطح «شاهکار» به یک سرویس استعلام نیاز دارد.</p>
      {sp.saved && <p role="status" className="mb-4 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800">تنظیمات ذخیره شد.</p>}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">امضاکننده‌ی تأییدشده</span><b className="mt-1 block text-xl font-black">{fn(counts.verified)}</b></div>
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">امضای گره‌خورده به هویت</span><b className="mt-1 block text-xl font-black">{fn(counts.sealed)}</b></div>
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">عدم تطابق (سیگنال جعل)</span><b className="mt-1 block text-xl font-black text-rose-700">{fn(counts.mismatch)}</b></div>
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">مدارک منتظر بررسی صادرکننده</span><b className="mt-1 block text-xl font-black">{fn(counts.pendingDocs)}</b></div>
      </div>

      <form action={saveIdentityConfigAction} className="panel-solid max-w-2xl space-y-4 p-5 sm:p-6">
        <h2 className="flex items-center gap-2 font-bold"><ShieldCheck size={18} />سرویس استعلام شاهکار</h2>
        <p className={`flex items-center gap-2 rounded-xl p-3 text-xs font-bold ${ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
          {ready ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
          {ready ? "استعلام خودکار فعال است؛ صادرکننده‌ها می‌توانند سطح «شاهکار» را انتخاب کنند." : "استعلام خودکار غیرفعال است؛ فقط سطح «مدارک هویتی» در دسترس صادرکننده‌هاست."}
        </p>
        <div>
          <label htmlFor="id-mode" className="label">حالت</label>
          <select id="id-mode" name="mode" defaultValue={cfg.mode} className="input">
            {IDENTITY_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <p className="mt-1 text-xs leading-6 text-ink/70">«آزمایشی» تماس بیرونی نمی‌زند و تطبیق را وقتی تأیید می‌کند که رقم آخر موبایل و کد ملی یکی باشد؛ فقط برای آموزش/آزمون است و در شناسنامه‌ی PDF با برچسب «آزمایشی» ثبت می‌شود.</p>
        </div>
        <div>
          <label htmlFor="id-token" className="label">توکن API زیبال (Access Token) {cfg.hasToken && <span className="text-emerald-700">— ذخیره‌شده</span>}</label>
          <input id="id-token" name="token" type="password" dir="ltr" autoComplete="off" placeholder={cfg.hasToken ? "برای تغییر، توکن جدید را وارد کنید" : "توکن را از پنل زیبال ← توسعه‌دهندگان بگیرید"} className="input" />
          <p className="mt-1 text-xs leading-6 text-ink/70">توکن با AES-256-GCM رمزنگاری می‌شود و هرگز به مرورگر برنمی‌گردد. IP سرور را در پنل زیبال مجاز کنید. سرویس: <span dir="ltr" className="font-mono">POST /v1/facility/shahkarInquiry</span></p>
          {cfg.hasToken && <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" name="clearToken" value="1" className="accent-[#102c31]" />حذف توکن ذخیره‌شده</label>}
        </div>
        <div>
          <label htmlFor="id-price" className="label">هزینه‌ی هر استعلام از کیف پول صادرکننده (تومان)</label>
          <input id="id-price" name="price" inputMode="numeric" dir="ltr" defaultValue={cfg.price} className="input max-w-48" />
          <p className="mt-1 text-xs leading-6 text-ink/70">۰ = رایگان. فقط روی استعلام واقعی اعمال می‌شود؛ اگر سرویس خطا بدهد مبلغ خودکار برمی‌گردد و اگر اعتبار کافی نباشد به صادرکننده اعلان می‌رسد.</p>
        </div>
        <button className="btn-primary btn-mint">ذخیره‌ی تنظیمات</button>
      </form>
    </Shell>
  );
}
