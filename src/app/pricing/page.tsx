import Link from "next/link";
import type { Metadata } from "next";
import { Check } from "lucide-react";
import { Brand } from "@/components/Brand";
import ChatWidget from "@/components/chat/ChatWidget";
import { getBranding } from "@/modules/branding/service";
import { getCurrentUser } from "@/modules/auth/session";
import { listPublicPlans } from "@/modules/billing/catalog";
import { limitLabel, maxDiscount, planFeatures } from "@/modules/billing/plans";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "تعرفه‌ها و طرح‌های اشتراک",
  description: "تعرفه و طرح‌های اشتراک امضای آنلاین قرارداد؛ با تخفیف پرداخت چندماهه، پیامک تأیید هویت و شناسنامه‌ی دیجیتال.",
  alternates: { canonical: "/pricing" },
  robots: { index: true, follow: true },
};

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** صفحه‌ی عمومی تعرفه‌ها */
export default async function PricingPage() {
  const [b, user, plans] = await Promise.all([getBranding(), getCurrentUser(), listPublicPlans()]);
  const off = maxDiscount(plans);
  const cols = plans.length >= 4 ? "md:grid-cols-2 xl:grid-cols-4" : plans.length === 3 ? "lg:grid-cols-3" : plans.length === 2 ? "md:grid-cols-2 md:mx-auto md:max-w-3xl" : "mx-auto max-w-md";
  return (
    <main className="min-h-screen bg-paper">
      <header className="mx-auto flex h-24 max-w-6xl items-center justify-between px-5">
        <Brand name={b.name} logoUrl={b.logoUrl} tagline={b.tagline} />
        <Link href={user ? "/admin/billing" : "/login"} className="btn-secondary">{user ? "پنل کاربری" : "ورود"}</Link>
      </header>
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <h1 className="text-3xl font-black sm:text-4xl">طرحی متناسب با رشد کسب‌وکار شما</h1>
          <p className="mt-3 text-sm leading-8 text-ink/75">{plans.some((p) => p.priceToman === 0) ? "شروع رایگان است. " : ""}{off > 0 ? `با پرداخت بلندمدت تا ${fn(off)}٪ تخفیف بگیرید؛ ` : ""}هر زمان طرح را ارتقا دهید.</p>
        </div>
        <div className={`grid gap-5 ${cols}`}>
          {plans.map((p) => {
            const free = p.priceToman === 0;
            return (
              <article key={p.id} className={`flex flex-col rounded-3xl border p-7 ${p.highlight ? "border-mint bg-ink text-white shadow-2xl" : "border-ink/10 bg-white"}`}>
                <h2 className="text-xl font-black">{p.name}</h2>
                <p className={`mt-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>{p.tagline}</p>
                <div className="my-6"><b className="text-4xl font-black">{free ? "رایگان" : fn(p.priceToman)}</b>{!free && <span className={`mr-1 text-xs ${p.highlight ? "text-white/75" : "text-ink/72"}`}>تومان / ماه</span>}</div>
                <ul className="mb-8 flex-1 space-y-3 text-sm">
                  {planFeatures(p).map((f) => (<li key={f} className="flex items-start gap-2"><Check size={15} className="mt-1 shrink-0 text-emerald-500" />{f}</li>))}
                </ul>
                <Link href={user ? "/admin/billing" : "/register"} className={p.highlight ? "btn-mint" : "btn-primary"}>{free ? "شروع رایگان" : "انتخاب طرح"}</Link>
                <p className={`mt-3 text-center text-xs ${p.highlight ? "text-white/65" : "text-ink/72"}`}>{limitLabel(p.contractsPerMonth)} قرارداد در ماه</p>
              </article>
            );
          })}
        </div>
      </section>
          {/* پیش‌فروش: مشتری بالقوه بدون ثبت‌نام می‌پرسد؛ کاربر واردشده با حساب خودش */}
      <ChatWidget context={{ kind: user ? "panel" : "site" }} />
    </main>
  );
}
