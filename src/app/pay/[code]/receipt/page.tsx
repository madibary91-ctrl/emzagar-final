import Link from "next/link";
import { BadgeCheck, Clock, ShieldAlert } from "lucide-react";
import { Brand } from "@/components/Brand";
import PrintButton from "@/components/PrintButton";
import { getBranding } from "@/modules/branding/service";
import { getPayContext } from "@/modules/contract-pay/service";
import { KIND_LABELS, type InstallmentKind } from "@/modules/contract-pay/schedule";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
// کد پرداخت داخل آدرس است: هرگز کش، ایندکس یا ارسال در Referer نشود
export const metadata = { title: "رسید پرداخت", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/**
 * رسید قابل‌چاپ/ذخیره‌ی PDF برای پرداخت بیعانه/قسط (با همان «کد پرداخت» غیرقابل‌حدس).
 * پیش‌تر پرداخت‌کننده‌ی مهمان پس از پرداخت هیچ سندی برای نگهداری نداشت جز یک کد پیگیری کوتاه.
 */
export default async function PayReceiptPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ctx = await getPayContext(code);
  const brand = await getBranding(ctx?.contract.workspaceId ?? 0);
  const inst = ctx?.inst;
  const paid = inst?.status === "paid";
  return (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {!ctx || !inst ? (
          <div className="card !p-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={26} /></span><h1 className="mt-4 text-lg font-black">لینک رسید نامعتبر است</h1><p className="mt-2 text-xs leading-7 text-ink/75">از صادرکننده‌ی قرارداد بخواهید لینک تازه بفرستد.</p></div>
        ) : !paid ? (
          <div className="card !p-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-50 text-amber-600"><Clock size={26} /></span><h1 className="mt-4 text-lg font-black">این مورد هنوز پرداخت نشده است</h1><p className="mt-2 text-xs leading-7 text-ink/75">پس از پرداخت موفق، رسید همین‌جا در دسترس است.</p><Link href={`/pay/${code}`} className="btn-primary mt-4 inline-flex">رفتن به صفحه‌ی پرداخت</Link></div>
        ) : (
          <article className="card space-y-4 !p-7" data-testid="pay-receipt">
            <div className="text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><BadgeCheck size={28} /></span>
              <h1 className="mt-3 text-lg font-black">رسید پرداخت</h1>
            </div>
            <dl className="space-y-2 text-xs leading-7">
              <div className="flex justify-between gap-3"><dt className="text-ink/60">بابت</dt><dd className="font-bold">{inst.title} ({KIND_LABELS[inst.kind as InstallmentKind] ?? "پرداخت"})</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">قرارداد</dt><dd className="font-bold">{ctx.contract.title}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">شماره‌ی قرارداد</dt><dd className="font-mono font-bold" dir="ltr">{ctx.contract.number}</dd></div>
              {ctx.payer && <div className="flex justify-between gap-3"><dt className="text-ink/60">پرداخت‌کننده</dt><dd className="font-bold">{ctx.payer.name}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-ink/60">دریافت‌کننده</dt><dd className="font-bold">{brand.name}</dd></div>
              <div className="flex justify-between gap-3 border-t border-ink/10 pt-2 text-sm"><dt className="font-bold">مبلغ</dt><dd className="font-black">{fn(inst.amount)} تومان</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">زمان پرداخت</dt><dd className="font-bold">{faTime(inst.paidAt)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-ink/60">روش</dt><dd className="font-bold">{inst.method === "manual" ? "ثبت دستی توسط صادرکننده" : "درگاه پرداخت آنلاین"}</dd></div>
              {inst.refId && <div className="flex justify-between gap-3"><dt className="text-ink/60">کد پیگیری</dt><dd className="font-mono font-bold" dir="ltr" data-testid="receipt-ref">{inst.refId}</dd></div>}
              {inst.method === "manual" && inst.note && <div className="flex justify-between gap-3"><dt className="text-ink/60">توضیح</dt><dd className="font-bold">{inst.note}</dd></div>}
            </dl>
            <div className="flex flex-wrap justify-center gap-2 pt-1"><PrintButton /><Link href={`/pay/${code}`} className="btn btn-secondary no-print">بازگشت</Link></div>
          </article>
        )}
      </div>
    </main>
  );
}
