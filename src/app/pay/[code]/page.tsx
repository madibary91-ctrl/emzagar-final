import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { Brand } from "@/components/Brand";
import ChatWidget from "@/components/chat/ChatWidget";
import PayInstallments from "@/components/pay/PayInstallments";
import { getBranding } from "@/modules/branding/service";
import { fa, faTime } from "@/lib/jalali";
import { contractGateways } from "@/modules/payments/workspace";
import { getPayContext } from "@/modules/contract-pay/service";
import { toPayItems } from "@/modules/contract-pay/view";

export const dynamic = "force-dynamic";
// کد پرداخت داخل آدرس است: هرگز کش، ایندکس یا ارسال در Referer نشود
export const metadata = { title: "پرداخت قرارداد", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function PayPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ pay?: string; msg?: string }> }) {
  const { code } = await params;
  const sp = await searchParams;
  const ctx = await getPayContext(code);
  const brand = await getBranding(ctx?.contract.workspaceId ?? 0);
  const Frame = ({ children }: { children: React.ReactNode }) => (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-2xl space-y-5">
        <div className="mb-2 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {children}
      </div>
    </main>
  );

  if (!ctx) {
    return (
      <Frame>
        <div className="card !p-7 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={26} /></span>
          <h1 className="mt-4 text-lg font-black">لینک پرداخت نامعتبر است</h1>
          <p className="mt-2 text-xs leading-7 text-ink/75">این لینک وجود ندارد. از صادرکننده‌ی قرارداد بخواهید لینک تازه بفرستد.</p>
        </div>
      </Frame>
    );
  }
  const { contract, payer, all } = ctx;
  const gateways = await contractGateways(contract.workspaceId);
  const open = ["sent", "signed"].includes(contract.status);
  const items = toPayItems(all, contract.status);
  const pending = all.filter((i) => i.status === "pending").length;

  return (
    <Frame>
      <ChatWidget context={{ kind: "pay", ref: code }} />
      {sp.pay && sp.msg && (
        <div role="status" className={`flex items-start gap-3 rounded-2xl border p-4 text-sm font-semibold ${sp.pay === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          {sp.pay === "ok" ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
          <span>{sp.msg.slice(0, 200)}</span>
        </div>
      )}
      <section className="panel-solid p-5 sm:p-6">
        <h1 className="text-lg font-black">{contract.title}</h1>
        <p className="mt-1 text-xs text-ink/72"><span dir="ltr" className="font-mono">{contract.number}</span> • صدور: {fa(contract.issuedAt)}{payer ? <> • پرداخت‌کننده: {payer.name}</> : null}</p>
        {contract.status === "signed" && contract.signedAt && <p className="mt-2 text-xs text-emerald-700">قرارداد در {faTime(contract.signedAt)} امضا و نهایی شده است.</p>}
      </section>
      {open ? (
        <PayInstallments items={items} gateways={gateways.map((g) => ({ id: g.id, label: g.label, blurb: g.blurb, own: g.own }))} intro={pending === 0 ? "همه‌ی تعهدات مالی این قرارداد پرداخت شده است. سپاس از شما." : "مبلغ هر مورد از روی قرارداد خوانده می‌شود و قابل تغییر نیست. پرداخت از درگاه امن بانکی انجام می‌شود و رسید آن در شناسنامه‌ی قرارداد ثبت می‌گردد."} />
      ) : (
        <div className="card !p-6 text-center text-sm text-ink/75">این قرارداد دیگر فعال نیست ({contract.status === "cancelled" ? "لغو شده" : contract.status === "rejected" ? "رد شده" : contract.status === "expired" ? "منقضی شده" : "پیش‌نویس"}) و پرداخت آن ممکن نیست.</div>
      )}
    </Frame>
  );
}
