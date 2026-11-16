import { and, desc, eq, gt, lte, ne, sql } from "drizzle-orm";
import { AlertTriangle, BellRing, CheckCircle2, FileText, Receipt, Undo2 } from "lucide-react";
import Shell from "@/components/Shell";
import { db } from "@/db";
import { invoices, payments, refunds, subscriptionNotices, subscriptions, users, workspaces } from "@/db/schema";
import { faTime, fa } from "@/lib/jalali";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { listAllPlans, pickDefault } from "@/modules/billing/catalog";
import { getInvoiceSettings } from "@/modules/billing/invoices";
import { suggestedRefund } from "@/modules/billing/refunds";
import { refundAction, saveInvoiceSettingsAction } from "@/modules/billing/refund-actions";
import { serverDate } from "@/lib/clock";

export const dynamic = "force-dynamic";
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const STAGE: Record<string, string> = { d7: "۷ روز", d3: "۳ روز", d1: "۱ روز", expired: "انقضا" };

/** مالی: فاکتورها و مالیات، بازپرداخت (Refund) و پایش انقضای اشتراک — فقط مدیر کل */
export default async function FinancePage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; refunded?: string }> }) {
  const admin = await requirePlatformAdmin();
  const sp = await searchParams;
  const plans = await listAllPlans();
  const def = pickDefault(plans);
  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? id;

  const [settings, [kpi], recent, creditNotes, expiring] = await Promise.all([
    getInvoiceSettings(),
    db
      .select({
        gross: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.status} = 'paid' and not ${payments.test} and ${payments.gateway} <> 'wallet' and ${payments.kind} <> 'contract'), 0)::bigint`,
        refunded: sql<number>`coalesce(sum(${payments.refundedAmount}) filter (where ${payments.status} = 'paid' and not ${payments.test} and ${payments.gateway} <> 'wallet' and ${payments.kind} <> 'contract'), 0)::bigint`,
      })
      .from(payments),
    db
      .select({ p: payments, ws: workspaces.name, email: users.email })
      .from(payments)
      .innerJoin(workspaces, eq(workspaces.id, payments.workspaceId))
      .innerJoin(users, eq(users.id, payments.userId))
      .where(and(eq(payments.kind, "subscription"), eq(payments.status, "paid")))
      .orderBy(desc(payments.paidAt), desc(payments.id))
      .limit(40),
    db
      .select({ r: refunds, ws: workspaces.name, number: invoices.number, invoiceId: invoices.id })
      .from(refunds)
      .innerJoin(workspaces, eq(workspaces.id, refunds.workspaceId))
      .leftJoin(invoices, eq(invoices.id, refunds.creditNoteId))
      .orderBy(desc(refunds.createdAt))
      .limit(15),
    db
      .select({ s: subscriptions, ws: workspaces.name })
      .from(subscriptions)
      .innerJoin(workspaces, eq(workspaces.id, subscriptions.workspaceId))
      .where(and(ne(subscriptions.plan, def.id), gt(subscriptions.currentPeriodEnd, serverDate()), lte(subscriptions.currentPeriodEnd, serverDate(14 * 86_400_000))))
      .orderBy(subscriptions.currentPeriodEnd)
      .limit(30),
  ]);
  const [tax] = await db
    .select({ month: sql<number>`coalesce(sum(${invoices.taxAmount}), 0)::bigint`, count: sql<number>`count(*) filter (where ${invoices.kind} = 'invoice')::int` })
    .from(invoices)
    .where(and(eq(invoices.test, false), sql`${invoices.issuedAt} >= date_trunc('month', now())`));
  const noticeRows = expiring.length
    ? await db.select().from(subscriptionNotices).where(sql`${subscriptionNotices.workspaceId} in (${sql.join(expiring.map((e) => sql`${e.s.workspaceId}`), sql`, `)})`)
    : [];
  const suggestions = new Map<number, number>();
  await Promise.all(recent.filter((r) => r.p.amount > r.p.refundedAmount).map(async (r) => suggestions.set(r.p.id, (await suggestedRefund(r.p.id)).amount)));
  const gross = Number(kpi?.gross ?? 0);
  const refunded = Number(kpi?.refunded ?? 0);

  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Receipt size={22} />مالی: فاکتور، مالیات و بازپرداخت</h1>
      <p className="mb-5 text-xs text-ink/72">فاکتور رسمی همه‌ی پرداخت‌های اشتراک، بازپرداخت (Refund) با اعلامیه‌ی بستانکاری و پایش انقضای اشتراک‌ها</p>

      {sp.saved && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 size={18} />تنظیمات ذخیره شد.</p>}
      {sp.refunded && <p role="status" className="mb-4 flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><CheckCircle2 size={18} />{String(sp.refunded).slice(0, 200)}</p>}
      {sp.error && <p role="alert" className="mb-4 flex items-center gap-2 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700"><AlertTriangle size={18} />{String(sp.error).slice(0, 200)}</p>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">درآمد ناخالص</span><b className="mt-1 block text-xl font-black">{fn(gross)} تومان</b></div>
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">بازپرداخت‌شده</span><b className="mt-1 block text-xl font-black text-rose-600">{fn(refunded)} تومان</b></div>
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">درآمد خالص</span><b className="mt-1 block text-xl font-black">{fn(gross - refunded)} تومان</b></div>
        <div className="panel-solid p-5"><span className="text-xs font-semibold text-ink/72">مالیات این ماه (خالص)</span><b className="mt-1 block text-xl font-black">{fn(Number(tax?.month ?? 0))} تومان</b><span className="text-xs text-ink/70">{fn(tax?.count ?? 0)} فاکتور این ماه</span></div>
      </div>

      <section className="panel-solid mb-6 p-5">
        <h2 className="mb-1 flex items-center gap-2 font-bold"><FileText size={16} />مشخصات فروشنده و نرخ مالیات</h2>
        <p className="mb-4 text-xs text-ink/72">روی همه‌ی فاکتورهای بعدی درج می‌شود (فاکتورهای صادرشده تغییر نمی‌کنند). قیمت طرح‌ها «شامل مالیات» است؛ نرخ ۰ یعنی بدون مالیات.</p>
        <form action={saveInvoiceSettingsAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><label className="label" htmlFor="f-tax">نرخ مالیات بر ارزش افزوده (٪)</label><input id="f-tax" name="taxPercent" type="text" inputMode="numeric" defaultValue={settings.taxPercent} dir="ltr" className="input" /></div>
          <div><label className="label" htmlFor="f-name">نام فروشنده</label><input id="f-name" name="sellerName" defaultValue={settings.sellerName} className="input" maxLength={120} /></div>
          <div><label className="label" htmlFor="f-eco">کد اقتصادی</label><input id="f-eco" name="economicCode" defaultValue={settings.economicCode} dir="ltr" className="input" maxLength={30} /></div>
          <div><label className="label" htmlFor="f-nid">شناسه‌ی ملی / ثبت</label><input id="f-nid" name="nationalId" defaultValue={settings.nationalId} dir="ltr" className="input" maxLength={30} /></div>
          <div><label className="label" htmlFor="f-phone">تلفن</label><input id="f-phone" name="phone" defaultValue={settings.phone} dir="ltr" className="input" maxLength={30} /></div>
          <div><label className="label" htmlFor="f-addr">نشانی</label><input id="f-addr" name="address" defaultValue={settings.address} className="input" maxLength={300} /></div>
          <div className="sm:col-span-2 lg:col-span-3"><label className="label" htmlFor="f-note">یادداشت پایین فاکتور (اختیاری)</label><input id="f-note" name="footerNote" defaultValue={settings.footerNote} className="input" maxLength={300} /></div>
          <div className="sm:col-span-2 lg:col-span-3"><button className="btn-primary">ذخیره</button></div>
        </form>
      </section>

      <section className="panel-solid mb-6 overflow-x-auto">
        <h2 className="flex items-center gap-2 px-5 pt-5 font-bold"><BellRing size={16} />اشتراک‌های در آستانه‌ی انقضا (۱۴ روز آینده)</h2>
        <p className="px-5 pb-2 text-xs text-ink/72">یادآوری خودکار ۷، ۳ و ۱ روز مانده (اعلان درون‌برنامه، پیام‌رسان و ایمیل به مالک/مدیران) و پس از انقضا.</p>
        <table className="w-full min-w-[640px]">
          <thead><tr><th className="th">فضای کاری</th><th className="th">طرح</th><th className="th">پایان اعتبار</th><th className="th">یادآوری‌های ارسال‌شده</th></tr></thead>
          <tbody>
            {expiring.map((e) => (
              <tr key={e.s.workspaceId} className="border-t border-ink/[.07]">
                <td className="td font-bold">{e.ws}</td>
                <td className="td text-xs">{planName(e.s.plan)}</td>
                <td className="td text-xs">{fa(e.s.currentPeriodEnd)}</td>
                <td className="td text-xs">{noticeRows.filter((n) => n.workspaceId === e.s.workspaceId && n.periodEnd.getTime() === e.s.currentPeriodEnd?.getTime()).map((n) => STAGE[n.stage] ?? n.stage).join("، ") || "—"}</td>
              </tr>
            ))}
            {expiring.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-xs text-ink/72">اشتراکی در آستانه‌ی انقضا نیست.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel-solid mb-6 overflow-x-auto">
        <h2 className="flex items-center gap-2 px-5 pt-5 font-bold"><Undo2 size={16} />پرداخت‌های اشتراک و بازپرداخت</h2>
        <p className="px-5 pb-2 text-xs text-ink/72">بازپرداخت «کیف پول» آنی است؛ «دستی» فقط ثبت می‌شود (واریز را خودتان از پنل درگاه انجام دهید). هر بازپرداخت یک اعلامیه‌ی بستانکاری صادر می‌کند.</p>
        <table className="w-full min-w-[900px]">
          <thead><tr><th className="th">تاریخ</th><th className="th">فضای کاری</th><th className="th">طرح</th><th className="th">مبلغ</th><th className="th">مسترد</th><th className="th">فاکتور</th><th className="th">بازپرداخت</th></tr></thead>
          <tbody>
            {recent.map(({ p, ws, email }) => {
              const left = p.amount - p.refundedAmount;
              const sug = suggestions.get(p.id) ?? 0;
              return (
                <tr key={p.id} className="border-t border-ink/[.07] align-top">
                  <td className="td whitespace-nowrap text-xs">{faTime(p.paidAt)}</td>
                  <td className="td text-xs"><b>{ws}</b><span className="block font-mono text-[11px] text-ink/60" dir="ltr">{email}</span></td>
                  <td className="td text-xs">{planName(p.plan)} — {fn(p.months)} ماه{p.gateway === "wallet" && <span className="badge mr-1 bg-stone-100 text-stone-700">کیف پول</span>}{(p.test || p.gateway === "sandbox") && <span className="badge mr-1 bg-amber-50 text-amber-700">آزمایشی</span>}</td>
                  <td className="td">{fn(p.amount)}</td>
                  <td className="td text-rose-600">{p.refundedAmount > 0 ? fn(p.refundedAmount) : "—"}</td>
                  <td className="td text-xs"><InvoiceLink paymentId={p.id} /></td>
                  <td className="td">
                    {left > 0 ? (
                      <details>
                        <summary className="cursor-pointer text-xs font-bold underline">بازپرداخت…</summary>
                        <form action={refundAction} className="mt-2 grid w-64 gap-2 rounded-2xl border border-ink/10 bg-white p-3">
                          <input type="hidden" name="paymentId" value={p.id} />
                          <label className="text-xs font-bold" htmlFor={`rf-a-${p.id}`}>مبلغ (تومان) — حداکثر {fn(left)}</label>
                          <input id={`rf-a-${p.id}`} name="amount" defaultValue={left} dir="ltr" className="input" inputMode="numeric" />
                          {sug > 0 && sug < left && <p className="text-[11px] text-ink/70">پیشنهاد به نسبت روزهای باقی‌مانده: <b>{fn(sug)}</b> تومان</p>}
                          <label className="text-xs font-bold" htmlFor={`rf-r-${p.id}`}>دلیل (الزامی)</label>
                          <input id={`rf-r-${p.id}`} name="reason" required maxLength={200} className="input" />
                          <label className="text-xs font-bold" htmlFor={`rf-m-${p.id}`}>روش</label>
                          <select id={`rf-m-${p.id}`} name="method" className="input" defaultValue={p.gateway === "wallet" ? "wallet" : "manual"}>
                            <option value="wallet" disabled={(p.test || p.gateway === "sandbox") && p.gateway !== "wallet"}>کیف پول فضای کاری (آنی)</option>
                            <option value="manual" disabled={p.gateway === "wallet"}>دستی / بانکی (فقط ثبت)</option>
                          </select>
                          <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="revoke" />لغو فوری اشتراک (بازگشت به طرح پایه)</label>
                          <button className="btn-primary !min-h-9">ثبت بازپرداخت</button>
                        </form>
                      </details>
                    ) : <span className="text-xs text-ink/60">تسویه‌شده</span>}
                  </td>
                </tr>
              );
            })}
            {recent.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-xs text-ink/72">هنوز پرداخت موفقی ثبت نشده است.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="panel-solid overflow-x-auto">
        <h2 className="px-5 pt-5 font-bold">آخرین بازپرداخت‌ها</h2>
        <table className="w-full min-w-[700px]">
          <thead><tr><th className="th">تاریخ</th><th className="th">فضای کاری</th><th className="th">مبلغ</th><th className="th">روش</th><th className="th">دلیل</th><th className="th">اعلامیه</th></tr></thead>
          <tbody>
            {creditNotes.map(({ r, ws, number, invoiceId }) => (
              <tr key={r.id} className="border-t border-ink/[.07]">
                <td className="td whitespace-nowrap text-xs">{faTime(r.createdAt)}</td>
                <td className="td text-xs">{ws}</td>
                <td className="td text-rose-600">{fn(r.amount)}</td>
                <td className="td text-xs">{r.method === "wallet" ? "کیف پول" : "دستی"}{r.revoked && " • اشتراک لغو شد"}</td>
                <td className="td text-xs">{r.reason}</td>
                <td className="td text-xs">{invoiceId ? <a className="font-bold underline" href={`/api/billing/invoices/${invoiceId}/pdf`}>{number}</a> : "—"}</td>
              </tr>
            ))}
            {creditNotes.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-xs text-ink/72">بازپرداختی ثبت نشده است.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}

async function InvoiceLink({ paymentId }: { paymentId: number }) {
  const [inv] = await db.select({ id: invoices.id, number: invoices.number }).from(invoices).where(and(eq(invoices.paymentId, paymentId), eq(invoices.kind, "invoice")));
  return inv ? <a className="font-bold underline" href={`/api/billing/invoices/${inv.id}/pdf`}>{inv.number}</a> : <span className="text-ink/60">—</span>;
}
