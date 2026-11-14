import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { Brand } from "@/components/Brand";
import AmendmentDecision from "@/components/AmendmentDecision";
import { getBranding } from "@/modules/branding/service";
import { sanitizeHtml } from "@/lib/html";
import { fa } from "@/lib/jalali";
import { AMENDMENT_STATUS_LABELS, resolveAmendToken } from "@/modules/amendments/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "تأیید الحاقیه", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

/** صفحه‌ی تأیید الحاقیه با لینک اختصاصی + OTP پیامکی (بدون نیاز به ثبت‌نام) */
export default async function AmendPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await resolveAmendToken(token);
  const brand = await getBranding(ctx?.contract.workspaceId ?? 0);
  const frame = (children: React.ReactNode) => (
    <main className="min-h-screen bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-7 flex justify-center"><Brand name={brand.name} logoUrl={brand.logoUrl} tagline={brand.tagline} /></div>
        {children}
      </div>
    </main>
  );
  if (!ctx) {
    return frame(
      <div className="card !p-7 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-rose-50 text-rose-500"><ShieldAlert size={26} /></span>
        <h1 className="mt-4 text-lg font-black">لینک نامعتبر است</h1>
        <p className="mt-2 text-xs leading-7 text-ink/75">این لینک وجود ندارد یا جایگزین شده است. از فرستنده‌ی الحاقیه لینک جدید بخواهید.</p>
      </div>,
    );
  }
  const { amendment, amSigner, contract, signer, user } = ctx;
  const mobile = signer.mobile || user.mobile;
  const masked = mobile.length >= 8 ? `${mobile.slice(0, 4)}***${mobile.slice(-4)}` : "";
  const pending = amendment.status === "sent" && amSigner.status === "pending";

  return frame(
    <div className="space-y-5">
      <section className="panel-solid p-5 sm:p-7">
        <p className="text-xs text-ink/72">الحاقیه‌ی {amendment.seq.toLocaleString("fa-IR")} به قرارداد <span dir="ltr" className="font-mono">{contract.number}</span> — «{contract.title}»</p>
        <h1 className="mt-1 text-xl font-black">{amendment.title}</h1>
        <p className="mt-1 text-xs text-ink/72">ثبت: {fa(amendment.createdAt)} • وضعیت: {AMENDMENT_STATUS_LABELS[amendment.status] ?? amendment.status}</p>
        <article className="contract-paper contract-body mt-5" dangerouslySetInnerHTML={{ __html: sanitizeHtml(amendment.bodyHtml) }} />
      </section>
      {pending && <AmendmentDecision who={{ token }} maskedMobile={masked} />}
      {!pending && (
        <div className="card !p-6 text-center">
          {amSigner.status === "accepted" ? <CheckCircle2 className="mx-auto text-emerald-700" size={30} /> : <XCircle className="mx-auto text-rose-500" size={30} />}
          <p className="mt-3 text-sm font-bold">
            {amSigner.status === "accepted" ? "تأیید شما ثبت شده است." : amSigner.status === "rejected" ? "شما این الحاقیه را رد کرده‌اید." : "این الحاقیه دیگر در انتظار تصمیم شما نیست."}
          </p>
        </div>
      )}
    </div>,
  );
}
