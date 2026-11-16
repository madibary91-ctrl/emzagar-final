import Link from "next/link";
import { Coins } from "lucide-react";
import Shell from "@/components/Shell";
import MerchantForm from "@/components/pay/MerchantForm";
import { fa, faTime } from "@/lib/jalali";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { receivables, STATE_LABELS, type ReceivableRow } from "@/modules/contract-pay/service";
import { workspaceGatewayInfos } from "@/modules/payments/workspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "مطالبات و پرداخت‌ها" };

const TONE: Record<ReceivableRow["state"], string> = {
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  overdue: "border-rose-200 bg-rose-50 text-rose-700",
  due_soon: "border-amber-200 bg-amber-50 text-amber-800",
  upcoming: "border-ink/10 bg-stone-50 text-ink/70",
  at_signing: "border-sky-200 bg-sky-50 text-sky-800",
  waiting_sign: "border-ink/10 bg-stone-50 text-ink/70",
  cancelled: "border-ink/10 bg-stone-50 text-ink/50",
};

export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const team = await requireTeam("view");
  const { s } = await searchParams;
  const { rows, totals } = await receivables(team.workspaceId);
  const gws = await workspaceGatewayInfos(team.workspaceId);
  const filtered = s && s in STATE_LABELS ? rows.filter((r) => r.state === s) : rows;
  const fmt = (n: number) => n.toLocaleString("fa-IR");
  const cards = [
    { k: "paid", label: "دریافت‌شده", v: totals.paid, cls: "text-emerald-700" },
    { k: "overdue", label: `سررسید گذشته (${fmt(totals.overdueCount)} مورد)`, v: totals.overdue, cls: "text-rose-600" },
    { k: "due_soon", label: "سررسید تا ۳ روز آینده", v: totals.dueSoon, cls: "text-amber-700" },
    { k: "upcoming", label: "آینده / منتظر امضا", v: totals.upcoming, cls: "text-ink" },
  ];
  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Coins size={22} />مطالبات و پرداخت‌ها</h1>
      <p className="mb-5 max-w-3xl text-xs leading-7 text-ink/72">بیعانه‌ها، اقساط و پرداخت‌های مرحله‌ای همه‌ی قراردادها یک‌جا. سامانه سررسیدها را خودکار با پیامک/ایمیل (همراه لینک پرداخت آنلاین) یادآوری می‌کند. برنامه‌ی پرداخت هر قرارداد را در صفحه‌ی خودش تعریف کنید.</p>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.k} href={`/admin/receivables?s=${c.k}`} className="panel-solid p-4 transition hover:-translate-y-0.5">
            <span className="text-xs text-ink/72">{c.label}</span>
            <b className={`mt-1 block text-xl ${c.cls}`}>{fmt(c.v)} <small className="text-xs font-semibold">تومان</small></b>
          </Link>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Link href="/admin/receivables" className={`badge border ${!s ? "border-ink bg-ink text-white" : "border-ink/10 bg-white"}`}>همه</Link>
        {(Object.keys(STATE_LABELS) as ReceivableRow["state"][]).map((k) => <Link key={k} href={`/admin/receivables?s=${k}`} className={`badge border ${s === k ? "border-ink bg-ink text-white" : TONE[k]}`}>{STATE_LABELS[k]}</Link>)}
      </div>
      <div className="panel-solid mb-6 overflow-x-auto !p-0">
        <table className="w-full min-w-[760px]">
          <thead className="bg-stone-50"><tr><th className="th">قرارداد</th><th className="th">پرداخت‌کننده</th><th className="th">ردیف</th><th className="th">مبلغ (تومان)</th><th className="th">سررسید</th><th className="th">وضعیت</th></tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={6} className="td py-10 text-center text-ink/72">موردی نیست. در صفحه‌ی یک قرارداد (پیش‌نویس یا در انتظار امضا) بخش «امضا و پرداخت» را تکمیل کنید، یا ارسال انبوه را با برنامه‌ی پرداخت اجرا کنید.</td></tr>}
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-ink/[.06]">
                <td className="td"><Link href={`/contracts/${r.contractId}#pay`} className="font-bold hover:underline">{r.contractTitle}</Link><span dir="ltr" className="block font-mono text-xs text-ink/65">{r.number}</span></td>
                <td className="td">{r.payerName}<span dir="ltr" className="block text-xs text-ink/65">{r.payerMobile}</span></td>
                <td className="td">{r.title}{r.gate === "before_sign" && <span className="block text-xs text-sky-700">پیش‌شرط امضا</span>}</td>
                <td className="td whitespace-nowrap font-bold">{fmt(r.amount)}</td>
                <td className="td whitespace-nowrap text-xs">{r.status === "paid" && r.paidAt ? faTime(r.paidAt) : r.dueAt ? fa(r.dueAt) : "هنگام امضا"}</td>
                <td className="td"><span className={`badge border ${TONE[r.state]}`}>{STATE_LABELS[r.state]}{r.status === "paid" && r.method === "manual" ? " (دستی)" : ""}</span>{r.reminderCount > 0 && r.status === "pending" && <span className="block text-[11px] text-ink/60">{fmt(r.reminderCount)} یادآوری</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {can(team.wsRole, "settings") && <MerchantForm gateways={gws} usingPlatform={!gws.some((g) => g.configured)} />}
    </Shell>
  );
}
