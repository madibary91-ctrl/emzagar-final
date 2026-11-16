import { AlertTriangle, BadgeCheck, Clock, ShieldCheck } from "lucide-react";
import Shell from "@/components/Shell";
import KycForm from "@/components/KycForm";
import { requireTeam } from "@/modules/tenancy/context";
import { faTime } from "@/lib/jalali";
import { KYC_STATUS_LABEL, maskNationalCode } from "@/modules/kyc/rules";
import { getKycState, getKycThreshold } from "@/modules/kyc/service";
import { decryptSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

/** احراز هویت فضای کاری برای صدور قراردادهای پرمبلغ */
export default async function KycPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const team = await requireTeam("settings");
  const sp = await searchParams;
  const [st, threshold] = await Promise.all([getKycState(team.workspaceId), getKycThreshold()]);
  const badge = KYC_STATUS_LABEL[st.status];
  const sub = st.submission;

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><ShieldCheck size={22} />احراز هویت</h1>
      <p className="mb-5 text-xs text-ink/72">{threshold > 0 ? `صدور قرارداد با ارزش ${threshold.toLocaleString("fa-IR")} تومان و بیشتر نیازمند احراز هویت است.` : "الزام احراز هویت فعلاً غیرفعال است."}</p>

      {sp.required && st.status !== "approved" && (
        <div role="alert" data-persist="true" className="mb-5 flex items-center gap-2 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800"><AlertTriangle size={18} />برای ثبت این ارزش قرارداد ابتدا احراز هویت را کامل کنید.</div>
      )}

      <section className="panel-solid mb-5 flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <span className="text-xs font-semibold text-ink/72">وضعیت فضای کاری «{team.workspaceName}»</span>
          <b className="mt-1 flex items-center gap-2 text-xl font-black" data-testid="kyc-status"><span className={`badge ${badge.cls}`}>{badge.label}</span></b>
        </div>
        {sub && <div className="text-xs text-ink/75">{sub.fullName} · کد ملی {maskNationalCode(decryptSecret(sub.nationalCodeEnc))} · ارسال: {faTime(sub.createdAt)}</div>}
      </section>

      {st.status === "approved" && <p className="flex items-center gap-2 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800"><BadgeCheck size={18} />هویت شما تایید شده است و می‌توانید قراردادهای پرمبلغ صادر کنید.</p>}
      {st.status === "pending" && <p className="flex items-center gap-2 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800"><Clock size={18} />مدارک شما در صف بررسی مدیر است؛ نتیجه با اعلان به شما اطلاع داده می‌شود.</p>}
      {st.status === "rejected" && sub && (
        <div role="alert" data-persist="true" className="mb-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800"><b className="mb-1 block">درخواست قبلی رد شد</b>{sub.rejectReason || "مدارک نامعتبر بود."}<span className="mt-1 block text-xs">لطفاً مدارک را اصلاح و دوباره ارسال کنید.</span></div>
      )}
      {(st.status === "none" || st.status === "rejected") && (
        <section className="panel-solid p-5">
          <h2 className="mb-4 font-bold">ارسال مدارک هویتی</h2>
          <KycForm defaultName={team.name} />
        </section>
      )}
    </Shell>
  );
}
