"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FlaskConical, LoaderCircle, Send, ThumbsDown } from "lucide-react";
import { amendDecideAction, amendSendOtpAction } from "@/modules/amendments/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const enDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

type Who = { token: string } | { amendmentId: number };

/** تأیید یا رد الحاقیه با کد پیامکی (OTP) روی شماره‌ی ثبت‌شده‌ی امضاکننده */
export default function AmendmentDecision({ who, maskedMobile }: { who: Who; maskedMobile: string }) {
  const router = useRouter();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [agree, setAgree] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [busy, setBusy] = useState<"send" | "accept" | "reject" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const send = async () => {
    setError("");
    setBusy("send");
    const r = await amendSendOtpAction(who);
    setBusy(null);
    if (r.seconds) setSeconds(r.seconds);
    if (!r.ok) return setError(r.error || "خطا در ارسال کد");
    setSent(true);
    setCode("");
    setDevCode(r.devCode);
  };

  const decide = async (accept: boolean) => {
    setError("");
    if (!/^\d{5,8}$/.test(code)) return setError("کد تأیید را وارد کنید");
    if (accept && !agree) return setError("تأیید مطالعه‌ی الحاقیه را علامت بزنید");
    if (!accept && !confirm("الحاقیه رد شود؟ این کار قابل بازگشت نیست.")) return;
    setBusy(accept ? "accept" : "reject");
    const r = await amendDecideAction(who, { accept, code, agree });
    setBusy(null);
    if (!r.ok) return setError(r.error || "خطا");
    setDone(accept ? (r.completed ? "الحاقیه توسط همه‌ی طرفین تأیید و اجرایی شد." : "تأیید شما ثبت شد؛ منتظر تأیید سایر طرفین هستیم.") : "الحاقیه رد شد.");
    router.refresh();
  };

  if (done) return <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs leading-7 text-emerald-800">{done}</p>;

  return (
    <div className="space-y-4 rounded-2xl border border-ink/10 bg-white p-5">
      <p className="text-xs leading-7 text-ink/75">برای ثبت تصمیم، هویت خود را با کد پیامکی تأیید کنید. کد به شماره‌ی <b dir="ltr" className="font-mono">{faDigits(maskedMobile)}</b> ارسال می‌شود.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={send} disabled={busy !== null || seconds > 0} className="btn-secondary">
          {busy === "send" ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}
          {sent ? "ارسال مجدد کد" : "دریافت کد تأیید"}
        </button>
        {seconds > 0 && <span role="timer" className="text-xs text-ink/72">ارسال مجدد تا {faDigits(seconds)} ثانیه دیگر</span>}
      </div>
      {devCode && (
        <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
          <FlaskConical size={15} className="mt-1 shrink-0" />
          <span>حالت آزمایشی: کد شما <b className="font-mono text-base">{faDigits(devCode)}</b> است.</span>
        </p>
      )}
      {sent && (
        <div className="space-y-3">
          <label className="label" htmlFor="am-otp">کد تأیید</label>
          <input id="am-otp" value={faDigits(code)} onChange={(e) => setCode(enDigits(e.target.value).replace(/\D/g, "").slice(0, 5))} inputMode="numeric" autoComplete="one-time-code" dir="ltr" placeholder="• • • • •" className="input otp-input w-full max-w-64" />
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1.5 h-4 w-4 accent-[#102c31]" />
            متن الحاقیه را مطالعه کرده‌ام و با آن موافقم.
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => decide(true)} disabled={busy !== null} className="btn-primary btn-mint !min-h-[48px]">
              {busy === "accept" ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}
              تأیید الحاقیه
            </button>
            <button type="button" onClick={() => decide(false)} disabled={busy !== null} className="btn-danger !min-h-[48px]">
              {busy === "reject" ? <LoaderCircle size={16} className="animate-spin" /> : <ThumbsDown size={16} />}
              رد الحاقیه
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
    </div>
  );
}
