"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { FlaskConical, LoaderCircle, MailCheck, Send } from "lucide-react";
import { resendVerificationAction, verifyEmailCodeAction, type FormState } from "@/modules/auth/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const enDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

/** فرم تأیید ایمیل: کد ۶ رقمی + ارسال مجدد با شمارنده */
export default function VerifyEmailForm({ maskedEmail, devCode, initialError }: { maskedEmail: string; devCode?: string; initialError?: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(verifyEmailCodeAction, {});
  const [code, setCode] = useState("");
  const [seconds, setSeconds] = useState(devCode || initialError ? 0 : 60);
  const [note, setNote] = useState<FormState | null>(initialError ? { error: "ارسال ایمیل ممکن نشد؛ دوباره تلاش کنید." } : null);
  const [dev, setDev] = useState(devCode);
  const [resending, startResend] = useTransition();

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const resend = () =>
    startResend(async () => {
      const r = await resendVerificationAction();
      setNote(r);
      if (r.seconds) setSeconds(r.seconds);
      if (r.devCode) setDev(r.devCode);
    });

  return (
    <form action={action} className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7 text-ink/75">
        <MailCheck size={18} className="mt-1 shrink-0 text-ink/72" />
        <span>
          کد ۶ رقمی به <b dir="ltr" className="inline-block text-ink">{maskedEmail}</b> ارسال شد. پوشه‌ی اسپم را هم نگاه کنید. کد ۳۰ دقیقه معتبر است.
        </span>
      </div>
      {dev && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
          <FlaskConical size={15} className="mt-1 shrink-0" />
          <span>حالت آزمایشی (SMTP تنظیم نشده): کد شما <b className="font-mono text-base">{faDigits(dev)}</b> است.</span>
        </p>
      )}
      <div>
        <label className="label" htmlFor="code">کد تأیید ایمیل</label>
        <input
          id="code"
          name="code"
          value={faDigits(code)}
          onChange={(e) => setCode(enDigits(e.target.value).replace(/\D/g, "").slice(0, 6))}
          dir="ltr"
          required
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="• • • • • •"
          className="input otp-input"
        />
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      {note?.error && !state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{note.error}</p>}
      {note?.message && !note.error && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{note.message}</p>}
      <button disabled={pending || code.length !== 6} className="btn-primary w-full !min-h-[50px]">
        {pending && <LoaderCircle size={17} className="animate-spin" />}
        {pending ? "در حال بررسی…" : "تأیید ایمیل و ورود"}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink/75">
        <button type="button" onClick={resend} disabled={resending || seconds > 0} className="btn-secondary !min-h-10">
          {resending ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}
          ارسال مجدد کد
        </button>
        {seconds > 0 && <span className="text-xs">تا {faDigits(seconds)} ثانیه دیگر</span>}
        <Link href="/login" className="font-bold text-ink underline">بازگشت به ورود</Link>
      </div>
    </form>
  );
}
