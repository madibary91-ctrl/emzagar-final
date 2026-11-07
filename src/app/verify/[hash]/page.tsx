import Link from "next/link";
import type { Metadata } from "next";
import { BadgeCheck, ShieldAlert, SearchX } from "lucide-react";
import AuthFrame from "@/components/AuthFrame";
import { rateLimit } from "@/lib/rate-limit";
import { getRequestInfo } from "@/lib/request";
import { faTime } from "@/lib/jalali";
import { verifyDocument } from "@/modules/verify/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "استعلام اصالت سند", robots: { index: false, follow: false } };

/** صفحه‌ی عمومی استعلام اصالت: با اسکن QR روی نسخه‌ی چاپی قرارداد باز می‌شود */
export default async function VerifyPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const { ip } = await getRequestInfo();
  if (!rateLimit(`verify:${ip}`, 40, 60_000).ok) {
    return <AuthFrame title="درخواست‌های زیاد" subtitle="لطفاً چند دقیقه بعد دوباره تلاش کنید."><Link href="/verify" className="btn-secondary">بازگشت</Link></AuthFrame>;
  }
  const r = await verifyDocument(hash.toLowerCase());

  if (!r.found) {
    return (
      <AuthFrame title="سندی با این اثر انگشت یافت نشد" subtitle="ممکن است اثر انگشت اشتباه وارد شده یا سند هنوز کامل امضا نشده باشد. هیچ سندی با این شناسه در سامانه ثبت نشده است.">
        <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-red-50 text-red-600"><SearchX size={26} /></div>
        <Link href="/verify" className="btn-primary">استعلام دوباره</Link>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title={r.intact ? "سند معتبر است" : "هشدار: سند دستکاری شده است"} subtitle={r.intact ? "متن قرارداد و امضاها دقیقاً مطابق لحظه‌ی امضا هستند." : "اثر انگشت ثبت‌شده با محتوای فعلی سند مطابقت ندارد. به این سند اعتماد نکنید و با صادرکننده تماس بگیرید."}>
      <div className={`mb-5 grid h-14 w-14 place-items-center rounded-2xl ${r.intact ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
        {r.intact ? <BadgeCheck size={28} /> : <ShieldAlert size={28} />}
      </div>
      <dl className="space-y-3 text-sm">
        <div className="flex justify-between gap-4"><dt className="text-ink/75">شماره سند</dt><dd className="font-mono font-bold" dir="ltr">{r.number}</dd></div>
        <div className="flex justify-between gap-4"><dt className="text-ink/75">عنوان</dt><dd className="font-bold">{r.title}</dd></div>
        {r.workspaceName && <div className="flex justify-between gap-4"><dt className="text-ink/75">صادرکننده</dt><dd className="font-bold">{r.workspaceName}</dd></div>}
        <div className="flex justify-between gap-4"><dt className="text-ink/75">تکمیل امضا</dt><dd className="font-bold">{faTime(r.signedAt)}</dd></div>
      </dl>
      <h2 className="mb-2 mt-6 text-xs font-bold text-ink/75">امضاکنندگان</h2>
      <ul className="space-y-2">
        {r.signers.map((s, i) => (
          <li key={i} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2 text-[13px]">
            <span><b>{s.label}</b> — {s.name}</span>
            <span className="text-ink/72">{faTime(s.signedAt)}</span>
          </li>
        ))}
      </ul>
      {r.amendments.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-xs font-bold text-ink/75">نسخه‌ی {r.version.toLocaleString("fa-IR")} — الحاقیه‌های تأییدشده</h2>
          <ul className="space-y-2">
            {r.amendments.map((a) => (
              <li key={a.seq} className="rounded-xl bg-stone-50 px-3 py-2 text-[13px]">
                <div className="flex items-center justify-between gap-3"><span><b>الحاقیه‌ی {a.seq.toLocaleString("fa-IR")}</b> — {a.title}</span><span className="text-ink/72">{faTime(a.signedAt)}</span></div>
                <span dir="ltr" className="mt-1 block break-all font-mono text-[10px] text-ink/72">{a.hash}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-5 break-all rounded-xl bg-stone-50 p-3 font-mono text-xs text-ink/72" dir="ltr">SHA-256: {hash.toLowerCase()}</p>
    </AuthFrame>
  );
}
