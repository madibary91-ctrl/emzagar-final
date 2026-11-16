import Link from "next/link";
import { ShieldCheck, Zap } from "lucide-react";
import { Brand } from "@/components/Brand";
import QuickSend from "@/components/QuickSend";
import { getBranding } from "@/modules/branding/service";
import { isQuickEnabled } from "@/modules/quick/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "ارسال سریع قرارداد — بدون ثبت‌نام", description: "قرارداد را آماده کنید یا فایل PDF/Word خود را بارگذاری کنید، امضا کنید و برای طرف مقابل بفرستید. بدون حساب کاربری." };

export default async function QuickPage() {
  const brand = await getBranding(0);
  const enabled = await isQuickEnabled();
  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href="/"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></Link>
          <Link href="/login" className="btn-ghost btn-sm">ورود</Link>
        </div>
        <header className="mb-7 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-ink text-mint"><Zap size={26} /></span>
          <h1 className="mt-4 text-2xl font-black">ارسال سریع قرارداد</h1>
          <p className="mt-2 text-sm leading-7 text-ink/75">بدون ثبت‌نام و بدون یادگیری پنل. سند را آماده کنید، با کد پیامکی امضا کنید و برای طرف مقابل بفرستید.</p>
        </header>
        {enabled ? <QuickSend /> : <div className="card text-center text-sm">ارسال سریع در این سامانه فعلاً غیرفعال است.</div>}
        <p className="mt-6 flex items-center justify-center gap-2 text-center text-xs leading-6 text-ink/65"><ShieldCheck size={15} />هویت هر دو طرف با کد پیامکی تأیید می‌شود و زمان، IP و اثر انگشت سند در گواهی PDF ثبت می‌گردد.</p>
      </div>
    </main>
  );
}
