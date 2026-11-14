"use client";

import { useActionState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { DELETE_PHRASE_TEXT } from "@/modules/account/constants";
import { deleteAccountAction, type AccountState } from "@/modules/account/actions";

/** حذف حساب: رمز فعلی + نوشتن عبارت تأیید (جلوگیری از کلیک اشتباهی) */
export function DeleteAccountForm() {
  const [s, action, pending] = useActionState<AccountState, FormData>(deleteAccountAction, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm("حساب شما برای همیشه ناشناس‌سازی و حذف می‌شود. ادامه می‌دهید؟")) e.preventDefault();
      }}
      className="space-y-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="del-pw">رمز عبور فعلی</label>
          <input id="del-pw" name="currentPassword" type="password" dir="ltr" required autoComplete="current-password" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="del-confirm">برای تأیید بنویسید: «{DELETE_PHRASE_TEXT}»</label>
          <input id="del-confirm" name="confirm" required autoComplete="off" className="input" placeholder={DELETE_PHRASE_TEXT} />
        </div>
      </div>
      {s.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs leading-6 text-rose-700">{s.error}</p>}
      <button disabled={pending} className="btn-danger">
        {pending ? <LoaderCircle size={16} className="animate-spin" /> : <Trash2 size={16} />}
        حذف دائمی حساب من
      </button>
    </form>
  );
}
