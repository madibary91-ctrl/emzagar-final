import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import Shell from "@/components/Shell";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { faTime } from "@/lib/jalali";
import { KYC_STATUS_LABEL } from "@/modules/kyc/rules";
import { kycCounts, listKyc } from "@/modules/kyc/service";

export const dynamic = "force-dynamic";

/** صف بررسی احراز هویت‌ها (مدیر کل) */
export default async function PlatformKycPage({ searchParams }: { searchParams: Promise<{ status?: string; done?: string }> }) {
  const admin = await requirePlatformAdmin();
  const sp = await searchParams;
  const filter = ["pending", "approved", "rejected"].includes(sp.status || "") ? sp.status : undefined;
  const [rows, counts] = await Promise.all([listKyc(filter), kycCounts()]);
  const tabs = [{ k: undefined, label: "همه" }, { k: "pending", label: `در انتظار (${counts.pending.toLocaleString("fa-IR")})` }, { k: "approved", label: "تایید شده" }, { k: "rejected", label: "رد شده" }];
  return (
    <Shell user={admin} wide>
      <h1 className="mb-4 flex items-center gap-2 text-2xl font-black"><ShieldCheck size={22} />احراز هویت مدارک</h1>
      {sp.done && <p role="status" className="mb-4 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800">{sp.done === "approve" ? "درخواست تایید شد." : "درخواست رد شد و دلیل برای کاربر ارسال شد."}</p>}
      <nav aria-label="فیلتر وضعیت" className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Link key={t.label} href={t.k ? `/platform/kyc?status=${t.k}` : "/platform/kyc"} className={`rounded-xl px-4 py-2 text-xs font-bold ${filter === t.k ? "bg-ink text-white" : "border border-ink/12 bg-white"}`}>{t.label}</Link>
        ))}
      </nav>
      <section className="panel-solid overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead><tr><th className="th">#</th><th className="th">فضای کاری</th><th className="th">متقاضی</th><th className="th">ایمیل</th><th className="th">تاریخ</th><th className="th">وضعیت</th><th className="th" /></tr></thead>
          <tbody>
            {rows.map(({ s, ws, email }) => {
              const b = KYC_STATUS_LABEL[s.status] ?? KYC_STATUS_LABEL.pending;
              return (
                <tr key={s.id} className="border-t border-ink/[.07]">
                  <td className="td font-mono text-xs">{s.id.toLocaleString("fa-IR")}</td>
                  <td className="td font-bold">{ws}</td>
                  <td className="td">{s.fullName}</td>
                  <td className="td text-xs" dir="ltr">{email}</td>
                  <td className="td text-xs">{faTime(s.createdAt)}</td>
                  <td className="td"><span className={`badge ${b.cls}`}>{b.label}</span></td>
                  <td className="td"><Link href={`/platform/kyc/${s.id}`} className="btn-secondary btn-sm">{s.status === "pending" ? "بررسی" : "مشاهده"}</Link></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-xs text-ink/72">موردی یافت نشد.</td></tr>}
          </tbody>
        </table>
      </section>
    </Shell>
  );
}
