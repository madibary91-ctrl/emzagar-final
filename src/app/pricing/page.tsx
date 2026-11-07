import Link from "next/link";
import type { Metadata } from "next";
import { Check } from "lucide-react";
import { Brand } from "@/components/Brand";
import { getBranding } from "@/modules/branding/service";
import { getCurrentUser } from "@/modules/auth/session";
import { MONTH_DISCOUNT, PLANS, PLAN_ORDER, limitLabel } from "@/modules/billing/plans";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "تعرفه‌ها و طرح‌های اشتراک",
  description: "طرح رایگان، حرفه‌ای و سازمانی امضای آنلاین قرارداد؛ با تخفیف پرداخت چندماهه، پیامک تأیید هویت و شناسنامه‌ی دیجیتال.",
  alternates: { canonical: "/pricing" },
  robots: { index: true, follow: true },
};

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** صفحه‌ی عمومی تعرفه‌ها */
export default async function PricingPage() {
  const [b, user] = await Promise.all([getBranding(), getCurrentUser()]);
  return (
    <main className="min-h-screen bg-paper">
      <header className="mx-auto flex h-24 max-w-6xl items-center justify-between px-5">
        <Brand name={b.name} logoUrl={b.logoUrl} tagline={b.tagline} />
        <Link href={user ? "/admin/billing" : "/login"} className="btn-secondary">{user ? "پنل کاربری" : "ورود"}</Link>
      </header>
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h1 className="text-3xl font-black sm:text-4xl">طرحی متناسب با رشد کسب‌وکار شما</h1>
          <p className="mt-3 text-sm leading-8 text-ink/75">شروع رایگان است. با پرداخت ۱۲ ماهه تا {fn(MONTH_DISCOUNT[12])}٪ تخفیف بگیرید؛ هر زمان طرح را ارتقا دهید.</p>
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          {PLAN_ORDER.map((id) => {
            const p = PLANS[id];
            return (
              <article key={id} className={`flex flex-col rounded-3xl border p-7 ${p.highlight ? "border-mint bg-ink text-white shadow-2xl" : "border-ink/10 bg-white"}`}>
                <h2 className="text-xl font-black">{p.name}</h2>
                <p className={`mt-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>{p.tagline}</p>
                <div className="my-6"><b className="text-4xl font-black">{p.priceToman ? fn(p.priceToman) : "رایگان"}</b>{p.priceToman > 0 && <span className={`mr-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>تومان / ماه</span>}</div>
                <ul className="mb-8 flex-1 space-y-3 text-sm">
                  {p.features.map((f) => (<li key={f} className="flex items-start gap-2"><Check size={15} className="mt-1 shrink-0 text-emerald-500" />{f}</li>))}
                </ul>
                <Link href={user ? "/admin/billing" : "/register"} className={p.highlight ? "btn-mint" : "btn-primary"}>{id === "free" ? "شروع رایگان" : "انتخاب طرح"}</Link>
                <p className={`mt-3 text-center text-xs ${p.highlight ? "text-white/65" : "text-ink/72"}`}>{limitLabel(p.contractsPerMonth)} قرارداد در ماه</p>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
