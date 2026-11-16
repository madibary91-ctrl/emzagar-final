import { redirect } from "next/navigation";
import { devFlag } from "@/lib/dev-flags";
import { Fingerprint, LockKeyhole, ShieldCheck } from "lucide-react";
import LoginForm from "@/components/LoginForm";
import { Brand } from "@/components/Brand";
import { getCurrentUser } from "@/modules/auth/session";
import { getBranding } from "@/modules/branding/service";
import { ensureSeed } from "@/modules/seed";
import { homeFor } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string; sso?: string; verified?: string }> }) {
  await ensureSeed();
  const { next, reset, sso, verified } = await searchParams;
  const brand = await getBranding();
  const user = await getCurrentUser();
  if (user) redirect(await homeFor(user.id));
  return (
    <main className="grid min-h-screen lg:grid-cols-[1.05fr_.95fr]">
      <section className="relative hidden overflow-hidden bg-ink p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="hero-grid absolute inset-0 opacity-60" />
        <div className="soft-pulse absolute -left-24 -top-24 h-96 w-96 rounded-full bg-mint/15 blur-[90px]" />
        <div className="noise absolute inset-0" />
        <div className="relative"><Brand light name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        <div className="relative max-w-lg">
          <span className="badge border border-white/10 bg-white/5 text-mint">امضای دیجیتال با تأیید هویت پیامکی</span>
          <h1 className="mt-6 text-5xl font-black leading-[1.3] tracking-tight">
            قرارداد را امضا کنید؛<br />
            <span className="text-mint">با اطمینان کامل.</span>
          </h1>
          <p className="mt-5 text-sm leading-8 text-white/75">
            هر امضا با کد یکبارمصرف پیامکی تأیید می‌شود و زمان، IP و اثر انگشت سند در شناسنامه‌ی دیجیتال قرارداد ثبت می‌شود.
          </p>
          <div className="mt-10 grid gap-3">
            {[
              [Fingerprint, "تأیید هویت با OTP", "کد ۶ رقمی هش‌شده با انقضا و محدودیت تلاش"],
              [ShieldCheck, "ردپای دیجیتال", "IP، User-Agent و SHA-256 برای هر سند"],
              [LockKeyhole, "ذخیره‌ی خصوصی", "امضاها خارج از دسترس عمومی نگهداری می‌شوند"],
            ].map(([Icon, title, text]) => {
              const I = Icon as typeof Fingerprint;
              return (
                <div key={title as string} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[.04] p-4">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-mint/15 text-mint"><I size={18} /></span>
                  <div>
                    <b className="block text-sm">{title as string}</b>
                    <span className="text-xs text-white/65">{text as string}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <p className="relative text-xs text-white/65">EMZAGAR © ۲۰۲۶</p>
      </section>

      <section className="grid place-items-center px-5 py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
          <div className="panel-solid p-7 sm:p-9">
            <h2 className="text-2xl font-black">ورود به حساب</h2>
            <p className="mt-2 text-xs leading-7 text-ink/75">برای مشاهده و امضای قراردادها وارد شوید.</p>
            {verified && <p role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">ایمیل شما تأیید شد؛ اکنون وارد شوید.</p>}
            {reset && <p role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">رمز عبور با موفقیت تعیین شد؛ اکنون وارد شوید.</p>}
            {sso && <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-7 text-amber-800">لینک ورود از وردپرس منقضی شده است. به وردپرس برگردید و دوباره روی «باز کردن پنل امضاگیر» بزنید، یا با ایمیل و رمز وارد شوید (اگر رمز ندارید «فراموشی رمز» را بزنید).</p>}
            <div className="mt-7"><LoginForm next={next} showDemo={devFlag("SEED_DEMO")} /></div>
          </div>
        </div>
      </section>
    </main>
  );
}
