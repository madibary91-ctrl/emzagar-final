"use client";

import { useEffect, useState } from "react";
import { Check, Download, FlaskConical, LoaderCircle, PenLine, Send, ShieldCheck, Smartphone } from "lucide-react";
import { SignatureCapture, type SignatureMethod } from "@/components/SignatureCapture";
import { DocFill, type FillField } from "@/components/DocViews";
import type { CollectField } from "@/modules/collect/schema";
import type { PageMeta } from "@/modules/docs/placement";
import { collectSendCodeAction, collectSubmitAction, collectVerifyCodeAction } from "@/modules/collect/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const fd = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const en = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

export interface DocMode {
  pages: PageMeta[];
  fields: FillField[];
  url: string;
}

/** فرم عمومی: نام + موبایل (+ OTP) + فیلدها + امضا؛ بدون ثبت‌نام */
export default function CollectForm({ code, bodyHtml, fields, requireOtp, requireSignature, docMode }: { code: string; bodyHtml: string; fields: CollectField[]; requireOtp: boolean; requireSignature: boolean; docMode: DocMode | null }) {
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [proof, setProof] = useState("");
  const [verifiedFor, setVerifiedFor] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [method, setMethod] = useState<SignatureMethod>("draw");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | "submit" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ receipt: string; key: string; message: string } | null>(null);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const verified = !!proof && verifiedFor === mobile;
  const mobileOk = /^(\+98|0098|98|0)?9\d{9}$/.test(en(mobile).replace(/[\s-]/g, ""));
  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));

  const sendCode = async () => {
    setError("");
    setBusy("send");
    const r = await collectSendCodeAction(code, mobile);
    setBusy(null);
    if (r.seconds) setSeconds(r.seconds);
    if (!r.ok) return setError(r.error || "ارسال کد ناموفق بود");
    setSent(true);
    setDevCode(r.devCode);
    setOtp("");
  };
  const verify = async () => {
    setError("");
    setBusy("verify");
    const r = await collectVerifyCodeAction(code, mobile, otp);
    setBusy(null);
    if (!r.ok || !r.proof) return setError(r.error || "کد نادرست است");
    setProof(r.proof);
    setVerifiedFor(mobile);
  };
  const submit = async () => {
    setError("");
    if (name.trim().length < 3) return setError("نام و نام خانوادگی را کامل وارد کنید");
    if (!mobileOk) return setError("شماره‌ی موبایل را درست وارد کنید (مثل 09123456789)");
    if (requireOtp && !verified) return setError("ابتدا شماره‌ی موبایل خود را با کد پیامکی تأیید کنید");
    if (requireSignature && !signature) return setError("امضای خود را ثبت کنید");
    if (!agree) return setError("تأیید مطالعه و پذیرش الزامی است");
    setBusy("submit");
    const r = await collectSubmitAction(code, { fullName: name, mobile, values, proof, signature: signature ?? undefined, agree });
    setBusy(null);
    if (!r.ok || !r.receipt || !r.key) {
      if (r.error?.includes("تأیید شماره")) setProof("");
      return setError(r.error || "ثبت انجام نشد");
    }
    setDone({ receipt: r.receipt, key: r.key, message: r.message || "امضای شما ثبت شد." });
  };

  if (done) {
    return (
      <div className="card space-y-4 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><Check size={28} /></span>
        <h2 className="text-lg font-black">{done.message}</h2>
        <p className="text-xs leading-7 text-ink/70">کد رسید شما: <b dir="ltr" className="font-mono text-base tracking-widest">{done.receipt}</b><br />این کد را نگه دارید؛ برای استعلام اصالت امضا از آن استفاده می‌شود.</p>
        <div className="flex flex-wrap justify-center gap-3">
          <a href={`/api/collect/receipt/${done.receipt}/pdf?k=${done.key}`} className="btn-primary btn-mint"><Download size={16} />دریافت نسخه‌ی PDF من</a>
          <a href={`/receipt/${done.receipt}`} className="btn-secondary">استعلام رسید</a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {docMode ? (
        <section className="panel-solid p-3 sm:p-5">
          <DocFill url={docMode.url} pages={docMode.pages} fields={docMode.fields} values={values} onChange={setValues} signature={signature} signerName={name.trim() || "نام شما"} />
        </section>
      ) : (
        bodyHtml && <article className="contract-paper contract-body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      )}

      <section className="card space-y-4">
        <h2 className="text-sm font-black">اطلاعات شما</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="cf-name">نام و نام خانوادگی</label><input id="cf-name" className="input" value={name} onChange={(e) => setName(e.target.value.slice(0, 100))} autoComplete="name" /></div>
          <div><label className="label" htmlFor="cf-mobile">شماره‌ی موبایل</label><input id="cf-mobile" className="input text-left" dir="ltr" inputMode="tel" autoComplete="tel" placeholder="09123456789" value={mobile} onChange={(e) => setMobile(e.target.value)} /></div>
        </div>
        {fields.map((f) => (
          <div key={f.key}>
            {f.type === "checkbox" ? (
              <label className="flex items-start gap-2 text-xs leading-6"><input className="mt-1.5 h-4 w-4 accent-[#102c31]" type="checkbox" checked={values[f.key] === "1"} onChange={(e) => set(f.key, e.target.checked ? "1" : "")} />{f.label}{f.required ? " *" : ""}</label>
            ) : f.type === "select" ? (
              <>
                <label className="label" htmlFor={`cf-${f.key}`}>{f.label}{f.required ? " *" : ""}</label>
                <select id={`cf-${f.key}`} className="input" value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)}>
                  <option value="">انتخاب کنید…</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </>
            ) : (
              <>
                <label className="label" htmlFor={`cf-${f.key}`}>{f.label}{f.required ? " *" : ""}</label>
                <input id={`cf-${f.key}`} className="input" value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value.slice(0, 500))} inputMode={["nid", "phone", "number"].includes(f.type) ? "numeric" : undefined} dir={["nid", "phone", "number", "email", "date"].includes(f.type) ? "ltr" : undefined} />
              </>
            )}
          </div>
        ))}
      </section>

      {requireOtp && (
        <section className="space-y-3 rounded-2xl bg-stone-50 p-4">
          <div className="flex items-center gap-2 text-xs font-black"><Smartphone size={16} />تأیید شماره‌ی موبایل</div>
          {verified ? (
            <p className="flex items-center gap-2 text-xs font-bold text-emerald-700"><Check size={15} />شماره‌ی شما تأیید شد</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={sendCode} disabled={busy !== null || seconds > 0 || !mobileOk} className="btn-secondary">
                  {busy === "send" ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}{sent ? "ارسال مجدد کد" : "دریافت کد پیامکی"}
                </button>
                {seconds > 0 && <span className="text-xs text-ink/70">ارسال مجدد تا {fd(seconds)} ثانیه دیگر</span>}
              </div>
              {devCode && <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800"><FlaskConical size={15} className="mt-1 shrink-0" />حالت آزمایشی (پنل پیامک متصل نیست): کد شما <b className="font-mono text-base">{fd(devCode)}</b> است.</p>}
              {sent && (
                <div className="flex gap-2">
                  <input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" maxLength={8} dir="ltr" placeholder="کد تأیید" aria-label="کد تأیید" className="input !w-40 text-center font-mono tracking-widest" />
                  <button type="button" onClick={verify} disabled={busy !== null} className="btn-primary">{busy === "verify" ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}تأیید</button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {requireSignature && (
        <section className="rounded-2xl border border-ink/10 bg-white p-4">
          <div className="mb-3 flex items-center gap-2 text-xs font-black"><PenLine size={16} />امضای شما</div>
          <SignatureCapture onChange={(data, m) => { setSignature(data); setMethod(m); }} />
        </section>
      )}
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1.5 h-4 w-4 accent-[#102c31]" />
        متن بالا را مطالعه کرده‌ام و با آن موافقم.
      </label>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      <button type="button" onClick={submit} disabled={busy !== null} className="btn-primary btn-mint !min-h-[52px] w-full">
        {busy === "submit" ? <LoaderCircle size={17} className="animate-spin" /> : <ShieldCheck size={17} />}امضا و ثبت
      </button>
      <span hidden>{method}</span>
    </div>
  );
}
