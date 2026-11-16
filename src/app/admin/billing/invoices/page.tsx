import Link from "next/link";
import { AlertTriangle, Download, FileSpreadsheet, FileText, Search } from "lucide-react";
import Shell from "@/components/Shell";
import { requireTeam } from "@/modules/tenancy/context";
import { invoiceItems, listInvoices } from "@/modules/billing/invoices";
import { INVOICE_ERRORS } from "@/modules/billing/invoice-http";
import { foldSearch, matchesSearch } from "@/lib/search-text";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const STATUS: Record<string, string> = { issued: "صادرشده", partially_refunded: "بازپرداخت جزئی", refunded: "بازپرداخت کامل" };

/** فاکتورهای رسمی اشتراک فضای کاری (دانلود PDF) */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ e?: string; q?: string }> }) {
  const team = await requireTeam("settings");
  const sp = await searchParams;
  const all = await listInvoices(team.workspaceId, 200);
  const q = String(sp.q ?? "").slice(0, 80).trim();
  const rows = q ? all.filter((i) => matchesSearch(foldSearch([i.number, i.trackingCode, i.paymentRef ?? "", invoiceItems(i)[0]?.title ?? ""].join(" ")), q)) : all;
  const err = sp.e && INVOICE_ERRORS[sp.e] ? INVOICE_ERRORS[sp.e] : null;
  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><FileText size={22} />فاکتورها</h1>
      <p className="mb-5 text-xs text-ink/72">فاکتور رسمی هر پرداخت اشتراک (شامل مالیات بر ارزش افزوده و شماره‌ی پیگیری) و اعلامیه‌ی بستانکاری بازپرداخت‌ها. <Link href="/admin/billing" className="font-bold underline">بازگشت به اشتراک و پرداخت</Link></p>
      {err && <p role="alert" className="mb-5 flex items-center gap-2 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700"><AlertTriangle size={18} />{err}</p>}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <form className="flex flex-1 items-center gap-2" role="search">
          <label htmlFor="inv-q" className="sr-only">جستجوی فاکتور</label>
          <input id="inv-q" name="q" defaultValue={q} placeholder="جستجوی شماره‌ی فاکتور، پیگیری یا شرح" className="input !min-h-10 max-w-sm" />
          <button className="btn-secondary btn-sm inline-flex items-center gap-1.5"><Search size={14} />جستجو</button>
          {q && <Link href="/admin/billing/invoices" className="text-xs font-bold underline">پاک‌کردن</Link>}
        </form>
        {all.length > 0 && <a href="/api/billing/invoices/export" className="btn-secondary btn-sm inline-flex items-center gap-1.5"><FileSpreadsheet size={14} />خروجی Excel (CSV)</a>}
      </div>
      <section className="panel-solid overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead><tr><th className="th">شماره</th><th className="th">تاریخ</th><th className="th">شرح</th><th className="th">مالیات (تومان)</th><th className="th">مبلغ کل (تومان)</th><th className="th">وضعیت</th><th className="th">شماره‌ی پیگیری</th><th className="th">PDF</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="border-t border-ink/[.07]">
                <td className="td font-mono text-xs" dir="ltr">{i.number}</td>
                <td className="td whitespace-nowrap text-xs">{faTime(i.issuedAt)}</td>
                <td className="td text-xs">{invoiceItems(i)[0]?.title ?? "—"}{i.test && <span className="badge mr-1 bg-amber-50 text-amber-700">آزمایشی</span>}</td>
                <td className="td">{fn(i.taxAmount)}</td>
                <td className={`td font-bold ${i.total < 0 ? "text-rose-600" : ""}`}>{fn(i.total)}</td>
                <td className="td text-xs">{i.kind === "credit_note" ? "اعلامیه‌ی بستانکاری" : STATUS[i.status] ?? i.status}</td>
                <td className="td font-mono text-xs" dir="ltr">{i.trackingCode}</td>
                <td className="td"><a href={`/api/billing/invoices/${i.id}/pdf`} className="inline-flex items-center gap-1 text-xs font-bold underline" aria-label={`دانلود ${i.number}`}><Download size={14} />دانلود</a></td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={8} className="py-10 text-center text-xs leading-7 text-ink/72">
                {q ? <>فاکتوری با «{q}» پیدا نشد. <Link href="/admin/billing/invoices" className="font-bold underline">پاک‌کردن جستجو</Link></> : <>هنوز فاکتوری صادر نشده است. پس از اولین پرداخت اشتراک، فاکتور رسمی اینجا نمایش داده می‌شود.<br />شارژ کیف پول پیش‌دریافت است و فاکتور ندارد؛ فاکتور هنگام خرید اشتراک صادر می‌شود. <Link href="/admin/billing" className="font-bold underline">خرید اشتراک</Link></>}
              </td></tr>
            )}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
