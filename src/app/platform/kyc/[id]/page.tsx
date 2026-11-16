import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowRight, Check, X } from "lucide-react";
import Shell from "@/components/Shell";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { faTime } from "@/lib/jalali";
import { KYC_DOC_LABEL, KYC_STATUS_LABEL } from "@/modules/kyc/rules";
import { getKycForReview } from "@/modules/kyc/service";
import { reviewKycAction } from "@/modules/kyc/actions";

export const dynamic = "force-dynamic";

/** بررسی یک درخواست: مدارک، مشخصات و تصمیم (تایید / رد با دلیل) */
export default async function KycReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const admin = await requirePlatformAdmin();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const data = await getKycForReview(Number(id));
  if (!data) notFound();
  const { s, docs } = data;
  const b = KYC_STATUS_LABEL[s.status] ?? KYC_STATUS_LABEL.pending;
  return (
    <Shell user={admin} wide>
      <Link href="/platform/kyc" className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-ink/75"><ArrowRight size={14} />بازگشت به صف</Link>
      <h1 className="mb-4 flex flex-wrap items-center gap-3 text-2xl font-black">درخواست #{s.id.toLocaleString("fa-IR")} <span className={`badge ${b.cls}`}>{b.label}</span></h1>
      {sp.error && <p role="alert" className="mb-4 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-700">{String(sp.error).slice(0, 200)}</p>}
      {data.duplicateWorkspaces > 0 && <p role="alert" className="mb-4 flex items-center gap-2 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800"><AlertTriangle size={18} />هشدار: همین کد ملی برای {data.duplicateWorkspaces.toLocaleString("fa-IR")} فضای کاری دیگر هم ارسال شده است.</p>}

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <section className="panel-solid h-fit p-5">
          <h2 className="mb-3 font-bold">مشخصات</h2>
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-ink/70">فضای کاری</dt><dd className="font-bold">{data.ws}</dd></div>
            <div><dt className="text-xs text-ink/70">نام متقاضی</dt><dd className="font-bold">{s.fullName}</dd></div>
            <div><dt className="text-xs text-ink/70">کد ملی</dt><dd className="font-mono font-bold" dir="ltr">{data.nationalCode}</dd></div>
            {s.birthDate && <div><dt className="text-xs text-ink/70">تاریخ تولد</dt><dd dir="ltr">{s.birthDate}</dd></div>}
            <div><dt className="text-xs text-ink/70">حساب</dt><dd dir="ltr" className="text-xs">{data.email} · {data.mobile}</dd></div>
            <div><dt className="text-xs text-ink/70">ارسال</dt><dd className="text-xs">{faTime(s.createdAt)}</dd></div>
            {s.reviewedAt && <div><dt className="text-xs text-ink/70">تصمیم</dt><dd className="text-xs">{faTime(s.reviewedAt)}{s.rejectReason ? ` — ${s.rejectReason}` : ""}</dd></div>}
          </dl>
          {s.status === "pending" && (
            <div className="mt-5 space-y-3 border-t border-ink/10 pt-4">
              <form action={reviewKycAction}>
                <input type="hidden" name="id" value={s.id} />
                <input type="hidden" name="decision" value="approve" />
                <button className="btn-mint w-full"><Check size={15} />تایید هویت</button>
              </form>
              <form action={reviewKycAction} className="space-y-2">
                <input type="hidden" name="id" value={s.id} />
                <input type="hidden" name="decision" value="reject" />
                <label className="label" htmlFor="kyc-reason">دلیل رد (برای کاربر نمایش داده می‌شود)</label>
                <textarea id="kyc-reason" name="reason" rows={3} required minLength={5} maxLength={300} className="input" placeholder="مثلاً: تصویر کارت ملی ناخوانا است" />
                <button className="btn-danger w-full"><X size={15} />رد درخواست</button>
              </form>
            </div>
          )}
        </section>

        <section className="panel-solid p-5">
          <h2 className="mb-3 font-bold">مدارک ({docs.length.toLocaleString("fa-IR")})</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {docs.map((d) => (
              <figure key={d.id} className="rounded-2xl border border-ink/10 p-3">
                <figcaption className="mb-2 text-xs font-bold">{KYC_DOC_LABEL[d.kind] ?? d.kind}</figcaption>
                {d.mime === "application/pdf" ? (
                  <a href={`/api/kyc/documents/${d.id}`} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm">باز کردن PDF</a>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={`/api/kyc/documents/${d.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/kyc/documents/${d.id}`} alt={KYC_DOC_LABEL[d.kind] ?? d.kind} className="max-h-72 w-full rounded-xl bg-stone-100 object-contain" /></a>
                )}
                <p className="mt-2 text-[11px] text-ink/60" dir="ltr">SHA-256: {d.sha256.slice(0, 16)}…</p>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </Shell>
  );
}
