import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Download, FileText, RefreshCw } from "lucide-react";
import { recheckPaymentAction } from "@/modules/billing/actions";
import type { PaymentReceipt } from "@/modules/billing/receipt";
import type { Flash } from "@/lib/flash";
import { faTime } from "@/lib/jalali";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
export const GW_LABEL: Record<string, string> = { zarinpal: "زرین‌پال", zibal: "زیبال", idpay: "آیدی‌پی", payir: "Pay.ir", sandbox: "آزمایشی", wallet: "کیف پول" };

/**
 * نتیجه‌ی پرداخت: بنر (پیام امضاشده‌ی سرور) + «رسید» از دیتابیس (کد پیگیری، مبلغ، فاکتور) + گام بعدیِ مناسب.
 * پیش‌تر فقط یک نوار سبز/قرمز بود: کاربر نه کد پیگیری می‌دید، نه فاکتور، و بعد از خطا هم راهی نبود جز جست‌وجوی خودش.
 */
export default function PaymentResult({ flash, receipt, from }: { flash: Flash; receipt: PaymentReceipt | null; from: "billing" | "wallet" }) {
  const ok = flash.pay === "ok";
  const pending = receipt && (receipt.phase.phase === "processing" || receipt.phase.phase === "waiting");
  const tone = ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : pending ? "border-sky-200 bg-sky-50 text-sky-900" : "border-red-200 bg-red-50 text-red-800";
  return (
    <section role="status" aria-live="polite" data-testid="pay-result" className={`mb-5 rounded-2xl border p-4 text-sm ${tone}`}>
      <p className="flex items-start gap-2 font-bold">
        {ok ? <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> : pending ? <Clock size={18} className="mt-0.5 shrink-0" /> : <AlertTriangle size={18} className="mt-0.5 shrink-0" />}
        <span>{flash.msg}</span>
      </p>
      {receipt && (
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-3"><dt className="opacity-70">شرح</dt><dd className="font-bold">{receipt.title}{receipt.kind === "subscription" ? ` — ${fn(receipt.months)} ماه` : ""}</dd></div>
          <div className="flex justify-between gap-3"><dt className="opacity-70">مبلغ</dt><dd className="font-bold">{fn(receipt.amount)} تومان</dd></div>
          <div className="flex justify-between gap-3"><dt className="opacity-70">درگاه</dt><dd className="font-bold">{GW_LABEL[receipt.gateway] ?? receipt.gateway}</dd></div>
          <div className="flex justify-between gap-3"><dt className="opacity-70">وضعیت</dt><dd className="font-bold">{receipt.phase.label}</dd></div>
          {receipt.refId && <div className="flex justify-between gap-3"><dt className="opacity-70">کد پیگیری</dt><dd className="font-mono font-bold" dir="ltr" data-testid="pay-ref">{receipt.refId}</dd></div>}
          <div className="flex justify-between gap-3"><dt className="opacity-70">زمان</dt><dd className="font-bold">{faTime(receipt.paidAt ?? receipt.createdAt)}</dd></div>
        </dl>
      )}
      {receipt?.phase.hint && !ok && <p className="mt-2 text-xs opacity-80">{receipt.phase.hint}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {receipt?.invoice && (
          <a href={`/api/billing/invoices/${receipt.invoice.id}/pdf`} className="btn-primary btn-sm inline-flex items-center gap-1.5"><Download size={14} />دانلود فاکتور {receipt.invoice.number}</a>
        )}
        {ok && receipt?.kind === "subscription" && !receipt.invoice && receipt.phase.phase === "paid" && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold opacity-80"><FileText size={14} />فاکتور رسمی تا چند دقیقه‌ی دیگر در «فاکتورها» صادر می‌شود.</span>
        )}
        {ok && receipt?.kind === "topup" && from === "wallet" && <Link href="/admin/billing" className="btn-secondary btn-sm">ادامه‌ی خرید اشتراک</Link>}
        {ok && receipt?.kind === "subscription" && <Link href="/admin" className="btn-secondary btn-sm">بازگشت به پنل</Link>}
        {pending && receipt?.phase.canRecheck && (
          <form action={recheckPaymentAction}>
            <input type="hidden" name="id" value={receipt.id} />
            <input type="hidden" name="from" value={from} />
            <button className="btn-secondary btn-sm inline-flex items-center gap-1.5"><RefreshCw size={14} />بررسی وضعیت از درگاه</button>
          </form>
        )}
        {!ok && !pending && <Link href={from === "wallet" ? "/admin/wallet#topup" : "/admin/billing#plans"} className="btn-secondary btn-sm">پرداخت دوباره</Link>}
        {!ok && <Link href="/support" className="text-xs font-bold underline">تماس با پشتیبانی</Link>}
      </div>
    </section>
  );
}
