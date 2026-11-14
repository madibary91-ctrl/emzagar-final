import Link from "next/link";
import { Archive, CheckCircle2, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/Brand";
import VaultDashboard from "@/components/vault/VaultDashboard";
import VaultGrowth from "@/components/vault/VaultGrowth";
import VaultLogin from "@/components/vault/VaultLogin";
import { getBranding } from "@/modules/branding/service";
import { vaultLogoutAction } from "@/modules/vault/actions";
import { getGrowthOffer } from "@/modules/vault/growth";
import { isVaultEnabled, listVaultDocs, vaultDisplayName, vaultStats } from "@/modules/vault/service";
import { readVaultSession } from "@/modules/vault/session";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "کیف اسناد من",
  description: "همه‌ی قراردادهایی که امضا کرده‌اید، یک‌جا: دانلود PDF رسمی، جستجو، یادداشت و ادامه‌ی امضا — فقط با کد پیامکی.",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

const ERRORS: Record<string, string> = {
  rate: "درخواست‌های زیاد بود؛ کمی بعد دوباره تلاش کنید.",
  nodoc: "این سند پیدا نشد یا دیگر منتظر امضای شما نیست.",
  closed: "این قرارداد دیگر قابل امضا نیست (لغو، رد یا منقضی شده است).",
};

const maskMobile = (m: string) => `${m.slice(0, 4)}***${m.slice(-4)}`;

export default async function VaultPage({ searchParams }: { searchParams: Promise<{ welcome?: string; e?: string }> }) {
  const { welcome, e } = await searchParams;
  const brand = await getBranding(0);
  const enabled = await isVaultEnabled();
  const mobile = enabled ? await readVaultSession() : null;

  const header = (right?: React.ReactNode) => (
    <div className="mb-7 flex items-center justify-between gap-3">
      <Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} />
      {right}
    </div>
  );

  if (!enabled) {
    return (
      <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
        <div className="mx-auto w-full max-w-md">
          {header()}
          <div className="card !p-7 text-center text-sm">کیف اسناد در این سامانه فعلاً غیرفعال است.</div>
        </div>
      </main>
    );
  }

  if (!mobile) {
    return (
      <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
        <div className="mx-auto w-full max-w-md">
          {header(<Link href="/login" className="btn-ghost btn-sm">ورود به پنل</Link>)}
          <header className="mb-6 text-center">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-ink text-mint"><Archive size={26} /></span>
            <h1 className="mt-4 text-2xl font-black">کیف اسناد من</h1>
            <p className="mt-2 text-sm leading-7 text-ink/75">همه‌ی قراردادهایی که تا امروز امضا کرده‌اید، یک‌جا. بدون رمز عبور و بدون ثبت‌نام؛ فقط با کد پیامکی.</p>
          </header>
          <div className="card !p-6 sm:!p-7">
            <VaultLogin />
          </div>
          <p className="mt-5 flex items-center justify-center gap-2 text-center text-xs leading-6 text-ink/65"><LockKeyhole size={15} />فقط صاحب شماره‌ی موبایل با کد پیامکی وارد می‌شود. اسناد شما برای هیچ فرستنده‌ی دیگری نمایش داده نمی‌شود.</p>
        </div>
      </main>
    );
  }

  const docs = await listVaultDocs(mobile);
  const stats = vaultStats(docs);
  const offer = await getGrowthOffer(mobile);
  const name = await vaultDisplayName(mobile);

  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        {header(
          <form action={vaultLogoutAction}>
            <button type="submit" className="btn-ghost btn-sm"><LogOut size={15} />خروج</button>
          </form>,
        )}
        <header className="mb-6">
          <h1 className="text-2xl font-black">{name ? `${name} عزیز، ` : ""}به کیف اسناد خود خوش آمدید</h1>
          <p className="mt-1 text-xs text-ink/70"><span dir="ltr" className="font-mono">{maskMobile(mobile)}</span> • ورود شما با کد پیامکی تأیید شده است</p>
        </header>

        {welcome && (
          <p role="status" className="mb-4 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-7 text-emerald-900">
            <CheckCircle2 className="mt-1 shrink-0" size={20} />
            <span><b>امضای شما ثبت شد.</b> از این پس هر قراردادی که با این شماره امضا کنید، خودکار در همین کیف جمع می‌شود.</span>
          </p>
        )}
        {e && ERRORS[e] && <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{ERRORS[e]}</p>}

        <div className="space-y-6">
          <VaultDashboard docs={docs} stats={stats} />
          <VaultGrowth offer={{ ...offer, signedCount: stats.signed }} defaultName={name} />
        </div>

        <p className="mt-8 flex items-center justify-center gap-2 text-center text-xs leading-6 text-ink/65"><ShieldCheck size={15} />PDFها همان نسخه‌ی رسمی با هش امنیتی و گواهی امضا هستند. نشست شما ۳ روز معتبر است.</p>
      </div>
    </main>
  );
}
