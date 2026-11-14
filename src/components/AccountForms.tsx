"use client";

import { useActionState } from "react";
import { Check, Download, KeyRound, LoaderCircle, LockKeyhole, Save, ShieldCheck, ShieldOff } from "lucide-react";
import CopyButton from "@/components/CopyButton";
import ConfirmButton from "@/components/ConfirmButton";
import {
  changePasswordAction, confirmTotpAction, disableTotpAction, regenerateRecoveryAction, updateProfileAction, type AccountState,
} from "@/modules/account/actions";

function Result({ s }: { s: AccountState }) {
  return (
    <>
      {s.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs leading-6 text-rose-700">{s.error}</p>}
      {s.ok && s.message && (
        <p role="status" className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800"><Check size={15} />{s.message}</p>
      )}
    </>
  );
}

function Busy({ pending, icon, children }: { pending: boolean; icon: React.ReactNode; children: string }) {
  return (
    <button disabled={pending} className="btn-primary">
      {pending ? <LoaderCircle size={16} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function ProfileForm({ name, email, mobile }: { name: string; email: string; mobile: string }) {
  const [s, action, pending] = useActionState<AccountState, FormData>(updateProfileAction, {});
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="acc-name">نام و نام خانوادگی</label>
          <input id="acc-name" name="name" defaultValue={name} required maxLength={100} className="input" autoComplete="name" />
        </div>
        <div>
          <label className="label" htmlFor="acc-email">ایمیل (غیرقابل تغییر)</label>
          <input id="acc-email" value={email} readOnly dir="ltr" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="acc-mobile">موبایل (دریافت کد تأیید امضا)</label>
          <input id="acc-mobile" name="mobile" defaultValue={mobile} required dir="ltr" inputMode="numeric" placeholder="09123456789" className="input" autoComplete="tel" />
        </div>
        <div>
          <label className="label" htmlFor="acc-mobile-pw">رمز فعلی (فقط هنگام تغییر موبایل)</label>
          <input id="acc-mobile-pw" name="currentPassword" type="password" dir="ltr" className="input" autoComplete="current-password" />
        </div>
      </div>
      <Result s={s} />
      <Busy pending={pending} icon={<Save size={16} />}>ذخیره‌ی مشخصات</Busy>
    </form>
  );
}

export function PasswordForm() {
  const [s, action, pending] = useActionState<AccountState, FormData>(changePasswordAction, {});
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="pw-cur">رمز فعلی</label>
          <input id="pw-cur" name="currentPassword" type="password" dir="ltr" required className="input" autoComplete="current-password" />
        </div>
        <div>
          <label className="label" htmlFor="pw-new">رمز جدید</label>
          <input id="pw-new" name="newPassword" type="password" dir="ltr" required minLength={8} className="input" autoComplete="new-password" />
        </div>
        <div>
          <label className="label" htmlFor="pw-confirm">تکرار رمز جدید</label>
          <input id="pw-confirm" name="confirm" type="password" dir="ltr" required minLength={8} className="input" autoComplete="new-password" />
        </div>
      </div>
      <p className="text-xs leading-6 text-ink/72">حداقل ۸ نویسه، ترکیب حروف و عدد. پس از تغییر، ورودهای دیگر (سایر دستگاه‌ها) خارج می‌شوند.</p>
      <Result s={s} />
      <Busy pending={pending} icon={<LockKeyhole size={16} />}>تغییر رمز عبور</Busy>
    </form>
  );
}

/** کدهای بازیابی: فقط یک بار نمایش داده می‌شوند */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const text = codes.join("\n");
  const download = () => {
    const blob = new Blob([`کدهای بازیابی ورود دومرحله‌ای\n(هر کد فقط یک بار قابل استفاده است)\n\n${text}\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <b className="text-xs text-amber-900">کدهای بازیابی را همین حالا ذخیره کنید؛ دیگر نمایش داده نمی‌شوند.</b>
      <p className="mt-1 text-xs leading-6 text-amber-800">اگر گوشی خود را گم کردید، با هر کد می‌توانید یک بار وارد شوید.</p>
      <ul dir="ltr" className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-4">
        {codes.map((c) => <li key={c} className="rounded-lg bg-white px-3 py-2 text-center tracking-wider">{c}</li>)}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <CopyButton text={text} label="کپی همه" />
        <button type="button" onClick={download} className="btn-secondary btn-sm"><Download size={14} />دانلود فایل</button>
      </div>
    </div>
  );
}

/** تأیید کد اول و فعال‌سازی */
export function TotpConfirmForm() {
  const [s, action, pending] = useActionState<AccountState, FormData>(confirmTotpAction, {});
  if (s.ok && s.codes) {
    return (
      <div className="space-y-3">
        <Result s={s} />
        <RecoveryCodes codes={s.codes} />
        <p className="text-xs text-ink/72">پس از ذخیره‌ی کدها، صفحه را دوباره باز کنید تا وضعیت به‌روز نمایش داده شود.</p>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <label className="label" htmlFor="totp-code">کد ۶ رقمی نمایش‌داده‌شده در اپ</label>
      <div className="flex flex-wrap items-start gap-3">
        <input id="totp-code" name="code" dir="ltr" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="input otp-input !w-48" />
        <Busy pending={pending} icon={<ShieldCheck size={16} />}>تأیید و فعال‌سازی</Busy>
      </div>
      <Result s={s} />
    </form>
  );
}

/** مدیریت وقتی فعال است: ساخت دوباره‌ی کدهای بازیابی و غیرفعال‌سازی */
export function TotpManage() {
  const [rs, rAction, rPending] = useActionState<AccountState, FormData>(regenerateRecoveryAction, {});
  const [ds, dAction, dPending] = useActionState<AccountState, FormData>(disableTotpAction, {});
  const fields = (id: string) => (
    <div className="grid gap-3 sm:grid-cols-2">
      <input name="currentPassword" type="password" dir="ltr" required placeholder="رمز فعلی" aria-label="رمز فعلی" className="input" autoComplete="current-password" id={`${id}-pw`} />
      <input name="code" dir="ltr" required placeholder="کد اپ یا کد بازیابی" aria-label="کد تأیید" className="input" autoComplete="one-time-code" id={`${id}-code`} />
    </div>
  );
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <form action={rAction} className="space-y-3 rounded-2xl border border-ink/10 p-4">
        <b className="flex items-center gap-2 text-xs"><KeyRound size={15} />ساخت دوباره‌ی کدهای بازیابی</b>
        <p className="text-xs leading-6 text-ink/72">کدهای قبلی باطل می‌شوند.</p>
        {fields("regen")}
        <Result s={rs} />
        {rs.codes && <RecoveryCodes codes={rs.codes} />}
        <Busy pending={rPending} icon={<KeyRound size={16} />}>ساخت کدهای جدید</Busy>
      </form>
      <form action={dAction} className="space-y-3 rounded-2xl border border-rose-200 p-4">
        <b className="flex items-center gap-2 text-xs text-rose-700"><ShieldOff size={15} />غیرفعال‌سازی ورود دومرحله‌ای</b>
        <p className="text-xs leading-6 text-ink/72">امنیت حساب شما کاهش می‌یابد.</p>
        {fields("off")}
        <Result s={ds} />
        <ConfirmButton message="ورود دومرحله‌ای غیرفعال شود؟" disabled={dPending} className="btn-danger">{dPending ? "در حال انجام…" : "غیرفعال‌سازی"}</ConfirmButton>
      </form>
    </div>
  );
}
