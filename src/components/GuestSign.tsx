"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Ban, Check, FlaskConical, LoaderCircle, PenLine, Send, ShieldCheck, Smartphone } from "lucide-react";
import { SignatureCapture, type SignatureMethod } from "@/components/SignatureCapture";
import RejectDialog from "@/components/RejectDialog";
import SignFields from "@/components/SignFields";
import type { FieldDef } from "@/modules/fields";
import EvidenceStep, { type EvidenceNeeds, type EvidenceValue } from "@/components/EvidenceStep";
import { guestRejectAction, guestSendOtpAction, guestSendReceiptOtpAction, guestSignAction, guestVerifyOtpAction, guestVerifyReceiptOtpAction } from "@/modules/signing/guest-actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const enDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

/** گام ۱: تأیید هویت با OTP پیامکی (نیازی به ثبت‌نام یا رمز نیست) */
export function GuestIdentity({ token, maskedMobile, signerName, mode = "sign" }: { token: string; maskedMobile: string; signerName: string; mode?: "sign" | "receipt" }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [emailed, setEmailed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const send = async () => {
    setError("");
    setBusy("send");
    const r = mode === "receipt" ? await guestSendReceiptOtpAction(token) : await guestSendOtpAction(token);
    setBusy(null);
    if (r.seconds) setSeconds(r.seconds);
    if (!r.ok) return setError(r.error || "خطا در ارسال کد");
    setSent(true);
    setCode("");
    setDevCode(r.devCode);
    setEmailed(!!r.emailed);
  };

  const verify = async () => {
    setError("");
    if (!/^\d{5,8}$/.test(code)) return setError("کد تأیید را وارد کنید");
    setBusy("verify");
    const r = mode === "receipt" ? await guestVerifyReceiptOtpAction(token, code) : await guestVerifyOtpAction(token, code);
    if (!r.ok) {
      setBusy(null);
      return setError(r.error || "کد نادرست است");
    }
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <p className="text-xs leading-7 text-ink/75">
        {mode === "receipt"
          ? `${signerName} عزیز، برای دریافت نسخه‌ی نهایی (PDF) فقط کافی است هویت خود را با کد پیامکی تأیید کنید.`
          : `${signerName} عزیز، برای مشاهده و امضای قرارداد فقط کافی است هویت خود را با کد پیامکی تأیید کنید؛ ثبت‌نام یا رمز عبور لازم نیست.`}
      </p>
      <div className="flex items-center gap-3 rounded-2xl bg-stone-50 p-4">
        <Smartphone size={18} className="text-ink/72" />
        <div>
          <span className="block text-xs text-ink/72">کد تأیید به این شماره ارسال می‌شود</span>
          <b dir="ltr" className="mt-1 block text-left text-sm">{faDigits(maskedMobile)}</b>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={send} disabled={busy !== null || seconds > 0} className="btn-secondary">
          {busy === "send" ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}
          {sent ? "ارسال مجدد کد" : "دریافت کد تأیید"}
        </button>
        {seconds > 0 && <span role="timer" aria-live="off" className="text-xs text-ink/72 tabular">ارسال مجدد تا {faDigits(seconds)} ثانیه دیگر</span>}
      </div>
      <AnimatePresence>
        {emailed && !devCode && (
          <motion.p role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800">
            کد تأیید به ایمیل شما هم ارسال شد.
          </motion.p>
        )}
        {devCode && (
          <motion.p role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
            <FlaskConical size={15} className="mt-1 shrink-0" />
            <span>حالت آزمایشی (پنل پیامک متصل نیست): کد شما <b className="font-mono text-base">{faDigits(devCode)}</b> است.</span>
          </motion.p>
        )}
        {sent && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
            <label className="label" htmlFor="g-otp">کد تأیید</label>
            <input
              id="g-otp"
              value={faDigits(code)}
              onChange={(e) => setCode(enDigits(e.target.value).replace(/\D/g, "").slice(0, 5))}
              onKeyDown={(e) => e.key === "Enter" && verify()}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              dir="ltr"
              placeholder="• • • • •"
              aria-describedby="g-otp-help"
              className="input otp-input w-full max-w-64"
            />
            <p id="g-otp-help" className="text-xs text-ink/72">کد ارسال‌شده را وارد کنید؛ ارقام فارسی و انگلیسی پذیرفته می‌شود.</p>
            <button type="button" onClick={verify} disabled={busy !== null || code.length !== 5} className="btn-primary btn-mint !min-h-[50px] w-full sm:w-auto sm:!px-8">
              {busy === "verify" ? <LoaderCircle size={17} className="animate-spin" /> : <Check size={17} />}
              {mode === "receipt" ? "تأیید و دریافت نسخه‌ی نهایی" : "تأیید و مشاهده‌ی قرارداد"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
    </div>
  );
}

/** گام ۲: امضا (پس از تأیید OTP) */
export function GuestSignPanel({ token, signerLabel, fields = [], evidence, role, parallelWith }: { token: string; signerLabel: string; fields?: FieldDef[]; evidence?: EvidenceNeeds; role?: string; parallelWith?: string[] }) {
  const needEvidence = !!evidence && (evidence.sealRequired || evidence.legal || evidence.initialsRequired);
  const [ev, setEv] = useState<EvidenceValue>({ seal: null, initials: null });
  const isWitness = role === "witness";
  const router = useRouter();
  const [signature, setSignature] = useState<string | null>(null);
  const [method, setMethod] = useState<SignatureMethod>("draw");
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const sign = async () => {
    setError("");
    const missing = fields.find((f) => f.required && !(fieldValues[f.key] || "").trim());
    if (missing) return setError(`«${missing.label}» را وارد کنید`);
    if (!signature) return setError("ابتدا امضای خود را ترسیم یا آپلود کنید");
    if (evidence?.sealRequired && !ev.seal) return setError("مهر شرکتی الزامی است؛ تصویر مهر را بارگذاری کنید");
    if (evidence?.initialsRequired && !ev.initials) return setError("پاراف الزامی است؛ پاراف خود را بکشید");
    if (!agree) return setError("لطفاً تایید مطالعه‌ی قرارداد را علامت بزنید");
    setBusy(true);
    const r = await guestSignAction(token, { signature, method, agree, fields: fieldValues, seal: ev.seal, initials: ev.initials });
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
    <motion.section initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} className="panel-solid space-y-4 p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><PenLine size={22} /></span>
        <div>
          <h2 className="text-lg font-black">{isWitness ? "گواهی شاهد" : "امضای قرارداد"} — {signerLabel}</h2>
          <p className="mt-1 text-xs leading-6 text-ink/75">هویت شما تأیید شد. {isWitness ? "شما به‌عنوان «شاهد» دعوت شده‌اید؛ امضای شما فقط گواهی بر امضای طرفین است. " : ""}متن را مطالعه و امضا کنید.</p>
          {parallelWith && parallelWith.length > 0 && (
            <p role="note" className="mt-2 rounded-xl bg-sky-50 p-2 text-xs leading-6 text-sky-900">امضای این سند «هم‌زمان» است: {parallelWith.join("، ")} نیز همین حالا می‌توانند امضا کنند و ترتیب مهم نیست.</p>
          )}
        </div>
      </div>
      <SignFields fields={fields} values={fieldValues} onChange={setFieldValues} />
      <section className="rounded-2xl border border-ink/10 bg-white p-5">
        <h3 className="mb-4 text-sm font-black">امضای خود را ثبت کنید</h3>
        <SignatureCapture onChange={(data, m) => { setSignature(data); setMethod(m); }} />
      </section>
      {needEvidence && evidence && <EvidenceStep needs={evidence} onChange={setEv} />}
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7">
        <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1.5 h-4 w-4 accent-[#102c31]" />
        قرارداد را مطالعه کرده‌ام و با مفاد آن موافقم.
      </label>
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={sign} disabled={busy} className="btn-primary btn-mint !min-h-[50px] flex-1 sm:flex-none sm:!px-8">
          {busy ? <LoaderCircle size={17} className="animate-spin" /> : <ShieldCheck size={17} />}
          {busy ? "در حال ثبت…" : "امضا و ثبت نهایی"}
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
