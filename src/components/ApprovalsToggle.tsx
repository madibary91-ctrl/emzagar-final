"use client";

import { useActionState, useRef } from "react";
import { ClipboardCheck } from "lucide-react";
import { setApprovalsEnabledAction, type ToggleState } from "@/modules/settings/actions";

/**
 * کلید «تأیید داخلی پیش از انتشار» (پیش‌فرض خاموش). برای کسی که تنها کار می‌کند این مرحله فقط مانع است؛
 * تیم‌های چندنفره آن را روشن می‌کنند. با تغییر کلید، همان لحظه ذخیره می‌شود.
 */
export default function ApprovalsToggle({ initial }: { initial: boolean }) {
  const [state, action, pending] = useActionState<ToggleState, FormData>(setApprovalsEnabledAction, { enabled: initial });
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={action} className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><ClipboardCheck size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-bold">تأیید داخلی پیش از انتشار</h2>
          <p className="mt-0.5 text-xs leading-6 text-ink/72">
            اگر خاموش باشد، پنل «تأیید داخلی» در همه‌ی صفحه‌ها حذف می‌شود و «انتشار نسخه نهایی» مستقیم منتشر می‌کند. برای تیم‌هایی که پیش از ارسال باید همکار (مثلاً حقوقی) متن را تأیید کند، آن را روشن کنید.
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-bold" htmlFor="approvals-enabled-switch">
          <span>{state.enabled ? "روشن" : "خاموش"}</span>
          <input
            id="approvals-enabled-switch"
            type="checkbox"
            role="switch"
            name="enabled"
            value="1"
            defaultChecked={initial}
            disabled={pending}
            onChange={() => formRef.current?.requestSubmit()}
            className="h-5 w-10 cursor-pointer accent-emerald-600"
          />
        </label>
      </div>
      {state.message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">{state.message}</p>}
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
    </form>
  );
}
