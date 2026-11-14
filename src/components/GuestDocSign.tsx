"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, LoaderCircle, PenLine, ShieldCheck } from "lucide-react";
import { SignatureCapture, type SignatureMethod } from "@/components/SignatureCapture";
import RejectDialog from "@/components/RejectDialog";
import { DocFill, type FillField } from "@/components/DocViews";
import type { PageMeta } from "@/modules/docs/placement";
import { guestRejectAction, guestSignAction } from "@/modules/signing/guest-actions";
import EvidenceStep, { type EvidenceNeeds, type EvidenceValue } from "@/components/EvidenceStep";

/** امضا روی خودِ فایل: مطالعه‌ی صفحه‌ها، پر کردن فیلدها روی صفحه، ثبت امضا */
export default function GuestDocSign({ token, signerLabel, signerName, pages, fields, evidence }: { token: string; signerLabel: string; signerName: string; pages: PageMeta[]; fields: FillField[]; evidence?: EvidenceNeeds }) {
  const router = useRouter();
  const needEvidence = !!evidence && (evidence.sealRequired || evidence.legal || evidence.initialsRequired);
  const [ev, setEv] = useState<EvidenceValue>({ seal: null, initials: null });
  const [signature, setSignature] = useState<string | null>(null);
  const [method, setMethod] = useState<SignatureMethod>("draw");
  const [agree, setAgree] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const sign = async () => {
    setError("");
    for (const f of fields.filter((x) => x.mine && x.required && (x.kind === "text" || x.kind === "checkbox"))) {
      if (!(values[f.key] || "").trim()) return setError(f.kind === "checkbox" ? `تیک «${f.label || "تأیید"}» الزامی است` : `فیلد «${f.label || "متن"}» را (روی صفحه‌ی فایل) پر کنید`);
    }
    if (!signature) return setError("ابتدا امضای خود را ترسیم یا آپلود کنید");
    if (evidence?.sealRequired && !ev.seal) return setError("مهر شرکتی الزامی است؛ تصویر مهر را بارگذاری کنید");
    if (evidence?.initialsRequired && !ev.initials) return setError("پاراف الزامی است؛ پاراف خود را بکشید");
    if (!agree) return setError("لطفاً تأیید مطالعه‌ی سند را علامت بزنید");
    setBusy(true);
    const r = await guestSignAction(token, { signature, method, agree, fields: values, seal: ev.seal, initials: ev.initials });
    setBusy(false);
    if (!r.ok) return setError(r.error || "خطا در ثبت امضا");
    router.refresh();
  };

  const reject = async (reason: string) => {
    setBusy(true);
    const r = await guestRejectAction(token, reason);
    setBusy(false);
    if (!r.ok) {
      setRejecting(false);
      return setError(r.error || "خطا");
    }
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <section className="panel-solid p-3 sm:p-5">
        <DocFill url={`/api/sign/${token}/source`} pages={pages} fields={fields} values={values} onChange={setValues} signature={signature} signerName={signerName} />
      </section>
      <section className="panel-solid space-y-4 p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><PenLine size={22} /></span>
          <div>
            <h2 className="text-lg font-black">امضای شما — {signerLabel}</h2>
            <p className="mt-1 text-xs leading-6 text-ink/75">امضا را اینجا بکشید؛ در همه‌ی جاهای «امضا» روی فایل درج می‌شود. کادرهای زردرنگ روی فایل را هم پر کنید.</p>
          </div>
        </div>
        <section className="rounded-2xl border border-ink/10 bg-white p-5">
          <SignatureCapture onChange={(data, m) => { setSignature(data); setMethod(m); }} />
        </section>
        {needEvidence && evidence && (
          <>
            {evidence.initialsRequired && <p className="rounded-xl bg-emerald-50 p-3 text-xs leading-7 text-emerald-900">این فایل {pages.length.toLocaleString("fa-IR")} صفحه دارد؛ پاراف شما روی هر {pages.length.toLocaleString("fa-IR")} صفحه درج می‌شود.</p>}
            <EvidenceStep needs={evidence} onChange={setEv} />
          </>
        )}
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1.5 h-4 w-4 accent-[#102c31]" />
          فایل را مطالعه کرده‌ام و با مفاد آن موافقم.
        </label>
        {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={sign} disabled={busy} className="btn-primary btn-mint !min-h-[50px] flex-1 sm:flex-none sm:!px-8">
            {busy ? <LoaderCircle size={17} className="animate-spin" /> : <ShieldCheck size={17} />}{busy ? "در حال ثبت…" : "امضا و ثبت نهایی"}
          </button>
          <button type="button" onClick={() => setRejecting(true)} disabled={busy} className="btn-danger !min-h-[50px]"><Ban size={16} />رد سند</button>
        </div>
        <RejectDialog open={rejecting} busy={busy} onClose={() => setRejecting(false)} onSubmit={reject} />
      </section>
    </div>
  );
}
