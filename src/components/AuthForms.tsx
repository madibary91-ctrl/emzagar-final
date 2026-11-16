"use client";

import { useActionState } from "react";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import {
  acceptInviteAction, forgotPasswordAction, registerAction, resetPasswordAction, type FormState,
} from "@/modules/auth/actions";

function Err({ s }: { s: FormState }) {
  return (
    <>
      {s.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{s.error}</p>}
      {s.message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-6 text-emerald-800">{s.message}</p>}
    </>
  );
}

function Submit({ pending, children }: { pending: boolean; children: string }) {
  return (
    <button disabled={pending} className="btn-primary w-full !min-h-[50px]">
      {pending && <LoaderCircle size={17} className="animate-spin" />}
      {children}
    </button>
  );
}

const Field = ({ label, name, type = "text", ltr, hint, ...rest }: { label: string; name: string; type?: string; ltr?: boolean; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
  <div>
    <label className="label" htmlFor={name}>{label}</label>
    <input id={name} name={name} type={type} dir={ltr ? "ltr" : undefined} required className="input" {...rest} />
    {hint && <p className="mt-1 text-xs text-ink/72">{hint}</p>}
  </div>
);

export function RegisterForm({ defaultRef = "" }: { defaultRef?: string }) {
  const [s, action, pending] = useActionState<FormState, FormData>(registerAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="نام کسب‌وکار / فروشگاه" name="workspaceName" maxLength={60} />
      <Field label="نام و نام خانوادگی شما" name="name" maxLength={100} autoComplete="name" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="ایمیل" name="email" type="email" ltr autoComplete="email" />
        <Field label="موبایل" name="mobile" ltr placeholder="09123456789" inputMode="numeric" autoComplete="tel" />
      </div>
      <Field label="رمز عبور" name="password" type="password" ltr minLength={8} autoComplete="new-password" hint="حداقل ۸ نویسه، ترکیب حروف و عدد" />
      <Field label="کد دعوت (اختیاری)" name="ref" ltr required={false} defaultValue={defaultRef} placeholder="EMZXXXXXX" maxLength={14} autoComplete="off" />
      <Err s={s} />
      <Submit pending={pending}>ساخت فضای کاری</Submit>
      <p className="text-center text-xs text-ink/75">حساب دارید؟ <Link href="/login" className="font-bold text-ink underline">وارد شوید</Link></p>
    </form>
  );
}

export function ForgotForm() {
  const [s, action, pending] = useActionState<FormState, FormData>(forgotPasswordAction, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="ایمیل حساب" name="email" type="email" ltr autoComplete="email" />
      <Err s={s} />
      {s.devLink && (
        <p role="status" className="break-all rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">
          حالت آزمایشی (SMTP تنظیم نشده): <Link href={s.devLink} className="font-bold underline" dir="ltr">{s.devLink}</Link>
        </p>
      )}
      <Submit pending={pending}>ارسال لینک بازیابی</Submit>
      <p className="text-center text-xs text-ink/75"><Link href="/login" className="font-bold text-ink underline">بازگشت به ورود</Link></p>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const [s, action, pending] = useActionState<FormState, FormData>(resetPasswordAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <Field label="رمز عبور جدید" name="password" type="password" ltr minLength={8} autoComplete="new-password" hint="حداقل ۸ نویسه، ترکیب حروف و عدد" />
      <Field label="تکرار رمز عبور" name="confirm" type="password" ltr minLength={8} autoComplete="new-password" />
      <Err s={s} />
      <Submit pending={pending}>تعیین رمز</Submit>
    </form>
  );
}

export function InviteForm({ token, existingAccount, loggedIn }: { token: string; existingAccount: boolean; loggedIn: boolean }) {
  const [s, action, pending] = useActionState<FormState, FormData>(acceptInviteAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {!existingAccount && (
        <>
          <Field label="نام و نام خانوادگی" name="name" maxLength={100} />
          <Field label="موبایل" name="mobile" ltr placeholder="09123456789" inputMode="numeric" />
          <Field label="رمز عبور" name="password" type="password" ltr minLength={8} autoComplete="new-password" hint="حداقل ۸ نویسه، ترکیب حروف و عدد" />
        </>
      )}
      {existingAccount && !loggedIn && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-6 text-amber-800">
          برای این ایمیل قبلاً حساب ساخته شده است. ابتدا <Link className="font-bold underline" href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>وارد شوید</Link> و سپس دعوت را بپذیرید.
        </p>
      )}
      <Err s={s} />
      {(!existingAccount || loggedIn) && <Submit pending={pending}>{existingAccount ? "پیوستن به تیم" : "ساخت حساب و پیوستن"}</Submit>}
    </form>
  );
}
