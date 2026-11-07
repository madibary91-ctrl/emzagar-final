"use client";

import { useActionState } from "react";
import { Link2, LockKeyhole } from "lucide-react";
import CopyButton from "@/components/CopyButton";
import { disableLinkAction, saveLinkAction, type LinkState } from "@/modules/links/actions";
import { fa } from "@/lib/jalali";

export interface LinkInfo {
  code: string;
  url: string;
  hasPassword: boolean;
  active: boolean;
  clicks: number;
  expiresAt: string | null;
}

/** مدیریت لینک کوتاه اختصاصی: کد دلخواه، رمز، مهلت و تعداد بازدید */
export default function LinkCard({ contractId, link }: { contractId: number; link: LinkInfo | null }) {
  const [state, action, pending] = useActionState<LinkState, FormData>(saveLinkAction, {});
  return (
    <section className="panel-solid p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-black"><Link2 size={16} />لینک کوتاه اختصاصی</h2>
        {link && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink/75">
            {link.hasPassword && <span className="badge bg-mint/25 text-ink"><LockKeyhole size={12} />رمزدار</span>}
            <span>{new Intl.NumberFormat("fa-IR").format(link.clicks)} بازدید</span>
            {link.expiresAt && <span>تا {fa(link.expiresAt)}</span>}
            {!link.active && <span className="badge bg-rose-50 text-rose-700">غیرفعال</span>}
          </div>
        )}
      </div>
      {link && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-stone-50 p-3">
          <code dir="ltr" className="min-w-0 flex-1 truncate text-xs">{link.url}</code>
          <CopyButton text={link.url} />
          <form action={disableLinkAction}>
            <input type="hidden" name="contractId" value={contractId} />
            <button className="btn-secondary btn-sm">{link.active ? "غیرفعال‌سازی" : "فعال‌سازی"}</button>
          </form>
        </div>
      )}
      <form action={action} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="contractId" value={contractId} />
        <div>
          <label className="label">کد اختصاصی</label>
          <input name="slug" dir="ltr" defaultValue={link?.code ?? ""} placeholder="مثلاً nda-ali" className="input" autoComplete="off" />
        </div>
        <div>
          <label className="label">رمز لینک {link?.hasPassword && "(خالی = بدون تغییر)"}</label>
          <input name="password" type="password" dir="ltr" className="input" autoComplete="new-password" />
        </div>
        <div>
          <label className="label">مهلت لینک (روز، ۰ = نامحدود)</label>
          <input name="days" type="number" min={0} max={365} defaultValue={0} className="input" />
        </div>
        <div className="flex items-end">
          <button disabled={pending} className="btn-primary w-full">{link ? "به‌روزرسانی لینک" : "ساخت لینک"}</button>
        </div>
        {link?.hasPassword && (
          <label className="flex items-center gap-2 text-xs text-ink/75 sm:col-span-2">
            <input type="checkbox" name="clearPassword" /> حذف رمز فعلی
          </label>
        )}
        {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-2 lg:col-span-4">{state.error}</p>}
        {state.ok && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 sm:col-span-2 lg:col-span-4">لینک ذخیره شد.</p>}
      </form>
      <p className="mt-3 text-xs leading-6 text-ink/72">رمز لینک، دسترسی به آدرس را قفل می‌کند. متن قرارداد همچنان فقط پس از ورود به حساب و فقط برای طرفین همان قرارداد نمایش داده می‌شود.</p>
    </section>
  );
}
