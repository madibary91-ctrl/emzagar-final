"use client";

import { useActionState } from "react";
import Link from "next/link";
import { KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { loginAction, loginTotpAction, type LoginState } from "@/modules/auth/actions";

const DEMO = [
  { label: "مدیر", email: "admin@example.com", password: "admin123" },
  { label: "کاربر ۱", email: "ali@example.com", password: "user123" },
  { label: "کاربر ۲", email: "sara@example.com", password: "user123" },
];

/** مرحله‌ی دوم ورود: کد اپ احراز هویت (۶ رقم) یا کد بازیابی */
function TotpStep({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginTotpAction, { step: "totp" });
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : "/login";
  return (
    <form action={action} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div className="flex items-start gap-3 rounded-2xl bg-stone-50 p-4 text-xs leading-7 text-ink/75">
        <KeyRound size={18} className="mt-1 shrink-0 text-ink/72" />
        <span>ورود دومرحله‌ای فعال است. کد ۶ رقمی اپ احراز هویت خود را وارد کنید؛ اگر به گوشی دسترسی ندارید یکی از کدهای بازیابی را بنویسید.</span>
      </div>
      <div>
        <label className="label" htmlFor="code">کد تأیید</label>
        <input id="code" name="code" dir="ltr" required autoFocus autoComplete="one-time-code" inputMode="text" className="input otp-input" placeholder="123456" maxLength={12} />
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      <button disabled={pending || state.expired} className="btn-primary w-full !min-h-[50px]">
        {pending ? <LoaderCircle size={17} className="animate-spin" /> : <LogIn size={17} />}
        {pending ? "در حال بررسی…" : "تأیید و ورود"}
      </button>
      <p className="text-center text-xs text-ink/75"><a href={loginHref} className="font-bold text-ink underline">بازگشت به ورود</a></p>
    </form>
  );
}

export default function LoginForm({ next, showDemo }: { next?: string; showDemo?: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  if (state.step === "totp") return <TotpStep next={next} />;
  return (
    <form action={action} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <label className="label" htmlFor="email">ایمیل</label>
        <input id="email" name="email" type="email" dir="ltr" required className="input" placeholder="you@example.com" />
      </div>
      <div>
        <div className="flex items-center justify-between"><label className="label" htmlFor="password">رمز عبور</label><Link href="/forgot" className="mb-1 text-xs font-semibold text-ink/75 hover:text-ink">رمز را فراموش کرده‌اید؟</Link></div>
        <input id="password" name="password" type="password" dir="ltr" required className="input" />
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full !min-h-[50px]">
        {pending ? <LoaderCircle size={17} className="animate-spin" /> : <LogIn size={17} />}
        {pending ? "در حال ورود…" : "ورود"}
      </button>
      <p className="text-center text-xs text-ink/75">فروشنده یا صاحب کسب‌وکار هستید؟ <Link href="/register" className="font-bold text-ink underline">فضای کاری بسازید</Link></p>
      {showDemo && (
      <div className="rounded-2xl bg-stone-50 p-4 text-xs text-ink/75">
        <div className="mb-2 font-bold text-ink/70">حساب‌های نمایشی</div>
        <div className="space-y-1.5">
          {DEMO.map((d) => (
            <div key={d.email} className="flex items-center justify-between gap-2">
              <span>{d.label}</span>
              <span dir="ltr" className="font-mono text-xs">{d.email} / {d.password}</span>
            </div>
          ))}
        </div>
      </div>
      )}
    </form>
  );
}
