"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Check, FlaskConical, Gift, LoaderCircle, Send, Sparkles } from "lucide-react";
import { vaultEnterFromTokenAction, vaultTokenSendCodeAction, vaultTokenVerifyCodeAction } from "@/modules/vault/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const enDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

/**
 * کارت «کیف اسناد» روی صفحه‌ی «امضای شما ثبت شد».
 * اگر نشست OTP امضا هنوز معتبر باشد، یک لمس کافی است؛ وگرنه همین‌جا کد پیامکی (به همان موبایل امضا) می‌گیرد.
 */
export default function VaultSignCta({ token, hasSession, giftText }: { token: string; hasSession: boolean; giftText: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"enter" | "send" | "verify" | null>(null);

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  const go = () => router.push("/vault?welcome=1");

  const enter = async () => {
    setError("");
    setBusy("enter");
    const r = await vaultEnterFromTokenAction(token);
    if (!r.ok) {
      setBusy(null);
      return setError(r.error || "ورود انجام نشد");
    }
    go();
  };

  const send = async () => {
    setError("");
    setBusy("send");
    const r = await vaultTokenSendCodeAction(token);
    setBusy(null);
    if (r.seconds) setSeconds(r.seconds);
    if (!r.ok) return setError(r.error || "ارسال کد انجام نشد");
    setStage("code");
    setCode("");
    setDevCode(r.devCode);
  };

  const verify = async () => {
    setError("");
    if (!/^\d{5,8}$/.test(code)) return setError("کد تأیید را وارد کنید");
    setBusy("verify");
    const r = await vaultTokenVerifyCodeAction(token, code);
    if (!r.ok) {
      setBusy(null);
      return setError(r.error || "کد نادرست است");
    }
    go();
  };

  return (
    <section className="mt-4 overflow-hidden rounded-3xl bg-ink p-6 text-white shadow-lg" aria-labelledby="vault-cta-title">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-mint text-ink"><Archive size={21} /></span>
        <div>
          <h2 id="vault-cta-title" className="text-base font-black">همه‌ی قراردادهایتان، یک‌جا و همیشه در دسترس</h2>
          <p className="mt-1 text-xs leading-7 text-white/80">«کیف اسناد» تمام قراردادهایی را که تا امروز امضا کرده‌اید نگه می‌دارد: دانلود PDF رسمی، جستجو، یادداشت و دسترسی به قراردادهای منتظر امضا — بدون رمز عبور.</p>
        </div>
      </div>
      {giftText && (
        <p className="mt-4 flex items-start gap-2 rounded-2xl bg-white/10 p-3 text-xs leading-6 text-mint">
          <Gift size={16} className="mt-0.5 shrink-0" />
          <span>{giftText}</span>
        </p>
      )}

      {stage === "idle" ? (
        <div className="mt-5">
          {hasSession ? (
            <button type="button" onClick={enter} disabled={busy !== null} className="btn-primary btn-mint !min-h-[50px] w-full">
              {busy === "enter" ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}
              ورود به کیف اسناد من
            </button>
          ) : (
            <button type="button" onClick={send} disabled={busy !== null || seconds > 0} className="btn-primary btn-mint !min-h-[50px] w-full">
              {busy === "send" ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={17} />}
              ورود به کیف اسناد با کد پیامکی
            </button>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {devCode && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
              <FlaskConical size={15} className="mt-1 shrink-0" />
              <span>حالت آزمایشی: کد شما <b className="font-mono text-base">{faDigits(devCode)}</b> است.</span>
            </p>
          )}
          <label className="text-xs font-bold text-white/85" htmlFor="vc-otp">کد تأیید ارسال‌شده به موبایل شما</label>
          <input
            id="vc-otp"
            value={faDigits(code)}
            onChange={(e) => setCode(enDigits(e.target.value).replace(/\D/g, "").slice(0, 5))}
            onKeyDown={(e) => e.key === "Enter" && verify()}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            dir="ltr"
            placeholder="• • • • •"
            className="input otp-input w-full max-w-64 !text-ink"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={verify} disabled={busy !== null || code.length !== 5} className="btn-primary btn-mint !min-h-[48px]">
              {busy === "verify" ? <LoaderCircle size={17} className="animate-spin" /> : <Check size={17} />}
              تأیید و ورود
            </button>
            <button type="button" onClick={send} disabled={busy !== null || seconds > 0} className="btn-ghost btn-sm !text-white">ارسال مجدد{seconds > 0 ? ` (${faDigits(seconds)})` : ""}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
    </section>
  );
}
