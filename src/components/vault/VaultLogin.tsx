"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, FlaskConical, LoaderCircle, Send, Smartphone } from "lucide-react";
import { vaultSendCodeAction, vaultVerifyCodeAction } from "@/modules/vault/actions";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const enDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));

/** ورود به کیف اسناد: فقط شماره‌ی موبایل + کد پیامکی (بدون رمز و ثبت‌نام) */
export default function VaultLogin() {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [devCode, setDevCode] = useState<string | undefined>();
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
    const r = await vaultSendCodeAction(mobile);
    setBusy(null);
    if (r.seconds) setSeconds(r.seconds);
    if (!r.ok) return setError(r.error || "ارسال کد انجام نشد");
    setSent(true);
    setCode("");
    setDevCode(r.devCode);
  };

  const verify = async () => {
    setError("");
    if (!/^\d{5,8}$/.test(code)) return setError("کد تأیید را وارد کنید");
    setBusy("verify");
    const r = await vaultVerifyCodeAction(mobile, code);
    if (!r.ok) {
      setBusy(null);
      return setError(r.error || "کد نادرست است");
    }
    router.refresh();
  };

  return (
    <div className="space-y-5">
      <div>
        <label className="label" htmlFor="v-mobile">شماره‌ی موبایل</label>
        <input
          id="v-mobile"
          dir="ltr"
          inputMode="tel"
          autoComplete="tel"
          value={mobile}
          disabled={sent}
          onChange={(e) => setMobile(enDigits(e.target.value).replace(/[^\d+]/g, "").slice(0, 14))}
          onKeyDown={(e) => e.key === "Enter" && !sent && send()}
          placeholder="09123456789"
          className="input w-full text-left"
        />
        <p className="mt-2 text-xs leading-6 text-ink/72">با همان شماره‌ای وارد شوید که قرارداد را با آن امضا کرده‌اید.</p>
      </div>

      {!sent ? (
        <button type="button" onClick={send} disabled={busy !== null || mobile.length < 10} className="btn-primary btn-mint !min-h-[50px] w-full">
          {busy === "send" ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={17} />}
          دریافت کد تأیید
        </button>
      ) : (
        <div className="space-y-4">
          <p role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800">
            <Smartphone size={15} className="mt-1 shrink-0" />
            <span>اگر این شماره در امضاگیر سندی دارد، کد تأیید پیامک شد.</span>
          </p>
          {devCode && (
            <p role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
              <FlaskConical size={15} className="mt-1 shrink-0" />
              <span>حالت آزمایشی (پنل پیامک متصل نیست): کد شما <b className="font-mono text-base">{faDigits(devCode)}</b> است.</span>
            </p>
          )}
          <div>
            <label className="label" htmlFor="v-otp">کد تأیید</label>
            <input
              id="v-otp"
              value={faDigits(code)}
              onChange={(e) => setCode(enDigits(e.target.value).replace(/\D/g, "").slice(0, 5))}
              onKeyDown={(e) => e.key === "Enter" && verify()}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              dir="ltr"
              placeholder="• • • • •"
              className="input otp-input w-full max-w-64"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={verify} disabled={busy !== null || code.length !== 5} className="btn-primary btn-mint !min-h-[50px] flex-1 sm:flex-none sm:!px-8">
              {busy === "verify" ? <LoaderCircle size={17} className="animate-spin" /> : <Check size={17} />}
              ورود به کیف اسناد
            </button>
            <button type="button" onClick={send} disabled={busy !== null || seconds > 0} className="btn-ghost btn-sm">ارسال مجدد{seconds > 0 ? ` (${faDigits(seconds)})` : ""}</button>
            <button type="button" onClick={() => { setSent(false); setCode(""); setError(""); }} className="btn-ghost btn-sm">تغییر شماره</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
    </div>
  );
}
