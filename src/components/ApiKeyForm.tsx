"use client";

import { useActionState } from "react";
import CopyButton from "@/components/CopyButton";
import { createKeyAction, type KeyState } from "@/modules/api/actions";
import { API_SCOPES, DEFAULT_KEY_LIFETIME_DAYS, DEFAULT_NEW_KEY_SCOPES, MAX_KEY_LIFETIME_DAYS, SENSITIVE_SCOPES, type ApiScope } from "@/modules/api/scopes";

export default function ApiKeyForm() {
  const [state, action, pending] = useActionState<KeyState, FormData>(createKeyAction, {});
  return (
    <form action={action} className="card space-y-3">
      <h2 className="font-bold">ساخت کلید جدید</h2>
      <div className="flex flex-wrap gap-2">
        <input name="name" className="input max-w-xs" placeholder="نام کلید (مثلاً سایت فروشگاه)" required />
        <button disabled={pending} className="btn-primary">ساخت کلید</button>
      </div>
      <fieldset className="space-y-2 rounded-2xl border border-ink/10 p-3">
        <legend className="px-1 text-xs font-bold">دسترسی‌ها (حداقل دسترسی لازم را انتخاب کنید)</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {(Object.keys(API_SCOPES) as ApiScope[]).map((sc) => (
            <label key={sc} className="flex items-start gap-2 text-xs leading-6">
              <input type="checkbox" name="scope" value={sc} defaultChecked={DEFAULT_NEW_KEY_SCOPES.includes(sc)} className="mt-1.5" />
              <span><code dir="ltr" className="font-mono">{sc}</code>{SENSITIVE_SCOPES.includes(sc) && <b className="mr-1 text-rose-700"> ⚠ حساس</b>} — {API_SCOPES[sc]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">اعتبار (روز، حداکثر {MAX_KEY_LIFETIME_DAYS})
          <input name="expiryDays" type="number" min={1} max={MAX_KEY_LIFETIME_DAYS} defaultValue={DEFAULT_KEY_LIFETIME_DAYS} className="input mt-1 !w-32" dir="ltr" />
        </label>
        <label className="min-w-[16rem] flex-1 text-xs">IPهای مجاز (اختیاری؛ با ویرگول، پشتیبانی CIDR)
          <input name="allowedIps" className="input mt-1" dir="ltr" placeholder="203.0.113.7, 198.51.100.0/24" />
        </label>
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      {state.plain && (
        <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 text-xs font-bold text-amber-800">این کلید فقط همین یک‌بار نمایش داده می‌شود؛ همین حالا آن را ذخیره کنید.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 break-all text-xs">{state.plain}</code>
            <CopyButton text={state.plain} />
          </div>
        </div>
      )}
    </form>
  );
}
