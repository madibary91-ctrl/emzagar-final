import Link from "next/link";
import { Repeat2 } from "lucide-react";
import Shell from "@/components/Shell";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { listRenewals, RENEWAL_LABELS, type RenewalState } from "@/modules/renewals/service";
import { renewContractAction } from "@/modules/renewals/actions";
import { fa } from "@/lib/jalali";

export const dynamic = "force-dynamic";
export const metadata = { title: "تمدید قراردادها" };

const TONE: Record<RenewalState, string> = {
  none: "border-ink/10 bg-stone-50 text-ink/70",
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
  due: "border-amber-200 bg-amber-50 text-amber-800",
  ended: "border-rose-200 bg-rose-50 text-rose-700",
  renewed: "border-sky-200 bg-sky-50 text-sky-800",
};

export default async function RenewalsPage() {
  const admin = await requireTeam("view");
  const rows = await listRenewals(admin.workspaceId);
  const canWrite = can(admin.wsRole, "write");
  const count = (s: RenewalState) => rows.filter((r) => r.state === s).length;

  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Repeat2 size={22} />تمدید قراردادها</h1>
      <p className="mb-5 text-xs leading-7 text-ink/72">قراردادهای امضاشده‌ای که پایان مدت دارند. سامانه پیش از موعد اعلان و ایمیل می‌فرستد و می‌توانید با یک کلیک پیش‌نویس تمدید بسازید. برای هر قرارداد، زمان پایان را در صفحه‌ی خودش تنظیم کنید.</p>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["due", "ended", "ok", "renewed"] as RenewalState[]).map((s) => (
          <div key={s} className="panel-solid p-4">
            <span className="text-xs text-ink/72">{RENEWAL_LABELS[s]}</span>
            <b className="mt-1 block text-2xl">{count(s).toLocaleString("fa-IR")}</b>
          </div>
        ))}
      </div>
      <div className="panel-solid overflow-x-auto !p-0">
        <table className="w-full">
          <thead className="bg-stone-50">
            <tr><th className="th">قرارداد</th><th className="th">مشتری</th><th className="th">پایان مدت</th><th className="th">وضعیت</th><th className="th" /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="td py-10 text-center text-ink/72">هنوز قراردادی زمان‌بندی تمدید ندارد. هنگام صدور از طریق API پارامتر termDays را بدهید یا در صفحه‌ی یک قرارداد امضاشده «زمان‌بندی تمدید» را تنظیم کنید.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-ink/[.06]">
                <td className="td"><Link href={`/contracts/${r.id}#renewal`} className="font-bold hover:underline">{r.title}</Link><span dir="ltr" className="block font-mono text-xs text-ink/72">{r.number}</span></td>
                <td className="td">{r.customerName}</td>
                <td className="td whitespace-nowrap text-xs">{fa(r.termEndsAt)}</td>
                <td className="td"><span className={`badge border ${TONE[r.state]}`}>{RENEWAL_LABELS[r.state]}</span></td>
                <td className="td text-left">
                  {r.renewedTo ? (
                    <Link href={`/contracts/${r.renewedTo}`} className="btn-secondary btn-sm">مشاهده‌ی تمدید</Link>
                  ) : (
                    canWrite && (
                      <form action={renewContractAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className={r.state === "due" || r.state === "ended" ? "btn-primary btn-mint btn-sm" : "btn-secondary btn-sm"}>تمدید</button>
                      </form>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
