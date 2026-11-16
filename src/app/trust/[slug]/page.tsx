import Link from "next/link";
import type { Metadata } from "next";
import { BadgeCheck, Clock, FileCheck2, Globe, SearchX, ShieldCheck } from "lucide-react";
import AuthFrame from "@/components/AuthFrame";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { faTime } from "@/lib/jalali";
import { trustProfile } from "@/modules/hub/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "پروفایل اعتماد کسب‌وکار", robots: { index: false, follow: false } };

const fa = (n: number) => n.toLocaleString("fa-IR");

/** صفحه‌ی عمومی «نشان اعتماد»: فقط آمار کلی؛ نام مشتریان و متن قراردادها هرگز نمایش داده نمی‌شود */
export default async function TrustPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ip } = await getRequestInfo();
  if (!rateLimit(`trust:${ip}`, 60, 60_000).ok) {
    return <AuthFrame title="درخواست‌های زیاد" subtitle="لطفاً چند دقیقه بعد دوباره تلاش کنید."><Link href="/verify" className="btn-secondary">استعلام اصالت سند</Link></AuthFrame>;
  }
  const p = await trustProfile(slug.toLowerCase());
  if (!p) {
    return (
      <AuthFrame title="کسب‌وکاری با این نشانی یافت نشد" subtitle="ممکن است نشانی اشتباه باشد یا این کسب‌وکار دیگر از امضاگیر استفاده نکند.">
        <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-red-50 text-red-600"><SearchX size={26} /></div>
        <Link href="/verify" className="btn-primary">استعلام اصالت سند</Link>
      </AuthFrame>
    );
  }

  const stats: [typeof FileCheck2, string, string][] = [
    [FileCheck2, "قرارداد امضاشده و مستند", fa(p.signed)],
    [ShieldCheck, "امضاشده در ۹۰ روز اخیر", fa(p.signed90)],
    [BadgeCheck, "نرخ تکمیل قراردادها", `${fa(p.rate)}٪`],
    [Clock, "میانه‌ی زمان امضا", p.medianHours === null ? "—" : `${fa(p.medianHours)} ساعت`],
  ];

  return (
    <AuthFrame title={p.name} subtitle="قراردادهای این کسب‌وکار با امضای الکترونیک، احراز هویت پیامکی و اثر انگشت ضددستکاری ثبت می‌شود.">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><BadgeCheck size={28} /></span>
        <div>
          <b className="block text-sm">کسب‌وکار تاییدشده در امضاگیر</b>
          <span className="text-xs text-ink/72">عضو از {faTime(p.since)}</span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        {stats.map(([Icon, label, value]) => (
          <div key={label} className="rounded-2xl bg-stone-50 p-3">
            <Icon size={16} className="text-emerald-700" />
            <dd className="mt-2 text-lg font-black">{value}</dd>
            <dt className="text-[11px] leading-5 text-ink/72">{label}</dt>
          </div>
        ))}
      </dl>
      {p.verifiedSites.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-2 text-xs font-bold text-ink/75">دامنه‌های تاییدشده</h2>
          <ul className="space-y-2">
            {p.verifiedSites.map((h) => (
              <li key={h} className="flex items-center gap-2 rounded-xl bg-stone-50 px-3 py-2 text-[13px]" dir="ltr"><Globe size={14} className="text-emerald-700" /> {h}</li>
            ))}
          </ul>
        </div>
      )}
      {p.last && <p className="mt-4 text-[11px] text-ink/72">آخرین امضا: {faTime(p.last)}</p>}
      <Link href="/verify" className="btn-secondary mt-6 inline-flex">استعلام اصالت یک سند</Link>
    </AuthFrame>
  );
}
