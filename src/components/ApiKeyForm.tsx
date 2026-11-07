"use client";

import { useActionState } from "react";
import CopyButton from "@/components/CopyButton";
import { createKeyAction, type KeyState } from "@/modules/api/actions";

export default function ApiKeyForm() {
  const [state, action, pending] = useActionState<KeyState, FormData>(createKeyAction, {});
  return (
    <form action={action} className="card space-y-3">
      <h2 className="font-bold">ساخت کلید جدید</h2>
      <div className="flex flex-wrap gap-2">
        <input name="name" className="input max-w-xs" placeholder="نام کلید (مثلاً سایت فروشگاه)" required />
        <button disabled={pending} className="btn-primary">ساخت کلید</button>
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
