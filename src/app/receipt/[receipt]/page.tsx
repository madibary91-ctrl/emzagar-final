import { timingSafeEqual } from "node:crypto";
import { CheckCircle2, Download, ShieldAlert, TriangleAlert } from "lucide-react";
import { Brand } from "@/components/Brand";
import { getBranding } from "@/modules/branding/service";
import { accessKey, RECEIPT_RE, verifyReceipt } from "@/modules/collect/service";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
export const metadata = { title: "استعلام رسید امضا", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ receipt: string }>; searchParams: Promise<{ k?: string }> }) {
  const { receipt } = await params;
  const { k } = await searchParams;
  const brand = await getBranding(0);
  const r = RECEIPT_RE.test(receipt) ? await verifyReceipt(receipt) : ({ found: false } as const);
  const keyOk = !!k && k.length === 32 && timingSafeEqual(Buffer.from(k), Buffer.from(accessKey(receipt)));
  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {!r.found ? (
          <div className="card !p-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={26} /></span><h1 className="mt-4 text-lg font-black">رسیدی با این کد پیدا نشد</h1><p className="mt-2 text-xs leading-7 text-ink/75">کد رسید را دوباره بررسی کنید.</p></div>
        ) : (
          <div className="card space-y-4 !p-7 text-center">
            <span className={`mx-auto grid h-14 w-14 place-items-center rounded-2xl ${r.intact && !r.voided ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-600"}`}>{r.intact && !r.voided ? <CheckCircle2 size={28} /> : <TriangleAlert size={28} />}</span>
            <h1 className="text-lg font-black">{r.voided ? "این امضا باطل شده است" : r.intact ? "رسید معتبر است" : "هشدار: محتوای سند با اثر انگشت نمی‌خواند"}</h1>
            <dl className="space-y-2 text-right text-xs leading-7">
              <div className="flex justify-between gap-3"><dt className="text-ink/60">سند</dt><dd className="font-bold">{r.title}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">صادرکننده</dt><dd className="font-bold">{r.workspaceName || "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">امضاکننده</dt><dd className="font-bold">{r.maskedName}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">زمان امضا</dt><dd className="font-bold">{faTime(r.signedAt)}</dd></div>
              <div><dt className="text-ink/60">اثر انگشت (SHA-256)</dt><dd dir="ltr" className="break-all text-left font-mono text-[10px] text-ink/70">{r.hash}</dd></div>
            </dl>
            {keyOk && !r.voided && <a href={`/api/collect/receipt/${receipt}/pdf?k=${k}`} className="btn-primary btn-mint w-full justify-center"><Download size={16} />دریافت نسخه‌ی PDF</a>}
            <p className="text-[11px] leading-6 text-ink/60">برای حفظ حریم خصوصی، نام کامل و متن سند نمایش داده نمی‌شود.</p>
          </div>
        )}
      </div>
    </main>
  );
}
