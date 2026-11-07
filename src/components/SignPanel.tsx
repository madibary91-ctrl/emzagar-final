"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Ban, Check, FlaskConical, LoaderCircle, PenLine, Send, ShieldCheck, Smartphone } from "lucide-react";
import { SignatureCapture, type SignatureMethod } from "@/components/SignatureCapture";
import RejectDialog from "@/components/RejectDialog";
import SignFields from "@/components/SignFields";
import type { FieldDef } from "@/modules/fields";
import { rejectContractAction, sendOtpAction, signContractAction } from "@/modules/signing/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const enDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-ink/10 bg-white p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className={`grid h-8 w-8 place-items-center rounded-full text-[13px] font-black ${done ? "bg-emerald-600 text-white" : "bg-ink text-mint"}`}>
          {done ? <Check size={15} /> : faDigits(n)}
        </span>
        <h3 className="text-sm font-black">{title}</h3>
      </div>
      {children}
    </section>
  );
}

export default function SignPanel({ contractId, signerLabel, maskedMobile, fields = [] }: { contractId: number; signerLabel: string; maskedMobile: string; fields?: FieldDef[] }) {
  const router = useRouter();
  const [signature, setSignature] = useState<string | null>(null);
  const [method, setMethod] = useState<SignatureMethod>("draw");
  const [agree, setAgree] = useState(false);
  const [code, setCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [emailed, setEmailed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const sendOtp = async () => {
    setError("");
    setBusy(true);
    const res = await sendOtpAction(contractId);
    setBusy(false);
    if (res.seconds) setSeconds(res.seconds);
    if (!res.ok) return setError(res.error || "خطا در ارسال کد");
    setOtpSent(true);
    setCode("");
    setDevCode(res.devCode);
    setEmailed(!!res.emailed);
  };

  const sign = async () => {
    setError("");
    const missing = fields.find((f) => f.required && !(fieldValues[f.key] || "").trim());
    if (missing) return setError(`«${missing.label}» را وارد کنید`);
    if (!signature) return setError("ابتدا امضای خود را ترسیم یا آپلود کنید");
    if (!agree) return setError("لطفاً تایید مطالعه‌ی قرارداد را علامت بزنید");
    if (!/^\d{5}$/.test(code)) return setError("کد تایید ۵ رقمی را وارد کنید");
    setBusy(true);
    const res = await signContractAction(contractId, { signature, method, agree, code, fields: fieldValues });
    setBusy(false);
    if (!res.ok) return setError(res.error || "خطا در ثبت امضا");
    router.refresh();
  };

  const reject = async (reason: string) => {
    setBusy(true);
    const res = await rejectContractAction(contractId, reason);
    setBusy(false);
    if (!res.ok) {
      setRejecting(false);
      return setError(res.error || "خطا");
    }
    router.refresh();
  };

  return (
    <motion.section initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="no-print panel-solid space-y-4 p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><PenLine size={22} /></span>
        <div>
          <h2 className="text-lg font-black">امضای قرارداد — {signerLabel}</h2>
          <p className="mt-1 text-xs leading-6 text-ink/72">نوبت امضای شماست. سه مرحله‌ی زیر را تکمیل کنید.</p>
        </div>
      </div>

      <SignFields fields={fields} values={fieldValues} onChange={setFieldValues} />
      <Step n={1} done={Boolean(signature)} title="امضای خود را ثبت کنید">
        <SignatureCapture onChange={(data, m) => { setSignature(data); setMethod(m); }} />
      </Step>

      <Step n={2} done={agree} title="تأیید مطالعه‌ی قرارداد">
        <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1.5 h-4 w-4 accent-[#102c31]" />
          قرارداد را مطالعه کرده‌ام و با مفاد آن موافقم.
        </label>
      </Step>

      <Step n={3} done={/^\d{5}$/.test(code)} title="تأیید هویت با پیامک">
        <div className="flex items-center gap-3 rounded-2xl bg-stone-50 p-4">
          <Smartphone size={18} className="text-ink/72" />
          <div>
            <span className="block text-xs text-ink/72">کد تأیید به این شماره ارسال می‌شود</span>
            <b dir="ltr" className="mt-1 block text-left text-sm">{faDigits(maskedMobile)}</b>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={sendOtp} disabled={busy || seconds > 0} className="btn-secondary">
            {busy && !otpSent ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}
            {otpSent ? "ارسال مجدد کد" : "دریافت کد تأیید"}
          </button>
          {seconds > 0 && <span role="timer" aria-live="off" className="text-xs text-ink/72 tabular">ارسال مجدد تا {faDigits(seconds)} ثانیه دیگر</span>}
        </div>
        <AnimatePresence>
          {emailed && !devCode && (
            <motion.p role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800">
              کد تأیید به ایمیل شما ارسال شد؛ صندوق ورودی (و پوشه‌ی اسپم) را بررسی کنید.
            </motion.p>
          )}
          {devCode && (
            <motion.p role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
              <FlaskConical size={15} className="mt-1 shrink-0" />
              <span>حالت آزمایشی (پنل پیامک متصل نیست): کد شما <b className="font-mono text-base">{faDigits(devCode)}</b> است.</span>
            </motion.p>
          )}
          {otpSent && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-5">
              <label className="label" htmlFor="otp">کد تأیید ۵ رقمی</label>
              <input
                id="otp"
                value={faDigits(code)}
                onChange={(e) => setCode(enDigits(e.target.value).replace(/\D/g, "").slice(0, 5))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                dir="ltr"
                placeholder="• • • • •"
                aria-describedby="otp-help"
                className="input otp-input max-w-64"
              />
              <p id="otp-help" className="mt-2 text-xs text-ink/72">کد پنج‌رقمی ارسال‌شده را وارد کنید؛ ارقام فارسی و انگلیسی پذیرفته می‌شود.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </Step>

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={sign} disabled={busy} className="btn-primary btn-mint !min-h-[50px] flex-1 sm:flex-none sm:!px-8">
          {busy && otpSent ? <LoaderCircle size={17} className="animate-spin" /> : <ShieldCheck size={17} />}
          {busy && otpSent ? "در حال ثبت…" : "امضا و ثبت نهایی"}
        </button>
        <button type="button" onClick={() => setRejecting(true)} disabled={busy} className="btn-danger !min-h-[50px]">
          <Ban size={16} />
          رد قرارداد
        </button>
      </div>
      <RejectDialog open={rejecting} busy={busy} onClose={() => setRejecting(false)} onSubmit={reject} />
    </motion.section>
  );
}
