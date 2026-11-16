import Link from "next/link";
import QRCode from "qrcode";
import { CheckCircle2, Clock, FileText, ShieldAlert, XCircle } from "lucide-react";
import { Brand } from "@/components/Brand";
import QuickManage from "@/components/QuickManage";
import { getBranding } from "@/modules/branding/service";
import { fa, faTime } from "@/lib/jalali";
import { getQuickStatus } from "@/modules/quick/service";
import { getSource } from "@/modules/docs/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "پیگیری ارسال سریع", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

const STATUS: Record<string, { label: string; tone: string }> = {
  sent: { label: "در انتظار امضای طرف مقابل", tone: "bg-amber-50 text-amber-700" },
  signed: { label: "امضا شد و نهایی است", tone: "bg-emerald-50 text-emerald-700" },
  rejected: { label: "طرف مقابل رد کرد", tone: "bg-rose-50 text-rose-700" },
  cancelled: { label: "لغو شد", tone: "bg-stone-100 text-stone-600" },
  expired: { label: "مهلت تمام شد", tone: "bg-stone-100 text-stone-600" },
};

export default async function QuickStatusPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ new?: string }> }) {
  const { token } = await params;
  const { new: isNew } = await searchParams;
  const brand = await getBranding(0);
  const st = await getQuickStatus(token);
  const frame = (children: React.ReactNode) => (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-6 flex justify-center"><Link href="/quick"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></Link></div>
        {children}
        <p className="mt-6 text-center text-xs leading-6 text-ink/65">همه‌ی اسنادی که امضا کرده‌اید را در <Link href="/vault" className="font-bold underline underline-offset-4">کیف اسناد</Link> ببینید.</p>
      </div>
    </main>
  );
  if (!st) {
    return frame(<div className="card !p-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={26} /></span><h1 className="mt-4 text-lg font-black">لینک پیگیری نامعتبر است</h1><p className="mt-2 text-xs leading-7 text-ink/75">این لینک وجود ندارد یا سند حذف شده است.</p></div>);
  }
  const { contract, signers, quick } = st;
  const s = STATUS[contract.status] ?? STATUS.sent;
  const src = await getSource(contract.id);
  const qr = st.recipientUrl ? await QRCode.toDataURL(st.recipientUrl, { margin: 1, width: 224, errorCorrectionLevel: "M" }) : null;
  const canAct = contract.status === "sent";
  return frame(
    <div className="space-y-4">
      {isNew && (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-7 text-emerald-900">
          <CheckCircle2 className="mt-1 shrink-0" size={20} />
          <div><b>امضا شد و ارسال شد.</b><br />این صفحه «لینک پیگیری» شماست؛ آن را نگه دارید یا بوکمارک کنید. هر زمان آن را باز کنید وضعیت و نسخه‌ی نهایی را می‌بینید.</div>
        </div>
      )}
      <section className="card space-y-4">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><FileText size={20} /></span>
          <div className="min-w-0">
            <h1 className="text-lg font-black">{contract.title}</h1>
            <p className="mt-1 text-xs text-ink/70"><span dir="ltr" className="font-mono">{contract.number}</span> • ارسال: {fa(contract.issuedAt)}{src ? ` • فایل: ${src.originalName}` : ""}</p>
          </div>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${s.tone}`}>{contract.status === "sent" ? <Clock size={13} /> : contract.status === "signed" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}{s.label}</span>
        <ol className="space-y-2">
          {signers.map((sg) => (
            <li key={sg.id} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2.5 text-xs">
              <span><b>{sg.label}</b> — {sg.userName}</span>
              <span className={sg.status === "signed" ? "font-bold text-emerald-700" : sg.status === "rejected" ? "font-bold text-rose-600" : "text-amber-700"}>{sg.status === "signed" ? `امضا شد • ${faTime(sg.signedAt)}` : sg.status === "rejected" ? "رد کرد" : "منتظر امضا"}</span>
            </li>
          ))}
        </ol>
      </section>
      <QuickManage token={token} recipientUrl={st.recipientUrl} recipientName={quick.recipientName} title={contract.title} qr={qr} canAct={canAct} senderUrl={st.senderUrl} complete={contract.status === "signed"} />
      <p className="text-center text-[11px] leading-6 text-ink/60">برای دریافت نسخه‌ی نهایی، کد پیامکی روی موبایل شما ارسال می‌شود. <Link href="/quick" className="font-bold underline">ارسال سند جدید</Link></p>
    </div>,
  );
}
