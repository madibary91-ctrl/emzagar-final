"use client";

import { useActionState, useRef } from "react";
import { Rocket, Save } from "lucide-react";
import RichEditor from "@/components/RichEditor";
import { draftAction, type DraftState } from "@/modules/contracts/actions";

/**
 * waitingOn: نام همکارانی (غیر از خود کاربر) که هنوز نسخه‌ی فعلی را تأیید نکرده‌اند و انتشار را نگه داشته‌اند.
 * selfApprover: خود کاربر در فهرست تأییدکنندگان است؛ زدن «انتشار» تأیید خودش حساب می‌شود.
 */
export default function DraftForm({ id, title, body, waitingOn = [], selfApprover = false }: { id: number; title: string; body: string; waitingOn?: string[]; selfApprover?: boolean }) {
  const [state, action, pending] = useActionState<DraftState, FormData>(draftAction, {});
  // نیت کاربر (ذخیره/انتشار) در یک فیلد مخفی نگه داشته می‌شود تا به رفتار مرورگر/ری‌اکت در ارسال نام و مقدار
  // دکمه‌ی ارسال‌کننده (submitter) وابسته نباشد؛ پیش‌فرض (مثلاً Enter در عنوان) «ذخیره» است.
  const intentRef = useRef<HTMLInputElement>(null);
  const setIntent = (v: "save" | "publish") => {
    if (intentRef.current) intentRef.current.value = v;
  };
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="intent" defaultValue="save" ref={intentRef} />
      <div className="card space-y-4">
        <div>
          <label htmlFor="draft-form-title" className="label">عنوان قرارداد</label>
          <input id="draft-form-title" name="title" defaultValue={title} className="input" required />
        </div>
        <div>
          <label className="label">متن قرارداد</label>
          <RichEditor name="body" initialHtml={body} />
        </div>
      </div>
      <div className="card grid items-end gap-4 sm:grid-cols-[1fr_auto_auto]">
        <div>
          <label htmlFor="draft-form-expiryDays" className="label">مهلت امضا پس از انتشار (روز) — خالی = پیش‌فرض، ۰ = بدون انقضا</label>
          <input id="draft-form-expiryDays" name="expiryDays" type="number" min={0} max={3650} className="input" placeholder="پیش‌فرض" />
        </div>
        <button type="submit" disabled={pending} onClick={() => setIntent("save")} className="btn-secondary"><Save size={16} />ذخیره پیش‌نویس</button>
        <button
          type="submit"
          disabled={pending}
          onClick={(e) => {
            if (!confirm("پس از انتشار، متن قرارداد قفل می‌شود و برای امضاکننده ارسال خواهد شد. ادامه می‌دهید؟")) {
              e.preventDefault();
              setIntent("save");
              return;
            }
            setIntent("publish");
          }}
          className="btn-primary btn-mint"
        >
          <Rocket size={16} />{pending ? "در حال انجام…" : "انتشار نسخه نهایی"}
        </button>
      </div>
      {waitingOn.length > 0 && <p role="note" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-800">انتشار تا تأیید همکاران زیر ممکن نیست: <b>{waitingOn.join("، ")}</b>. می‌توانید از پنل «تأیید داخلی» پایین صفحه، تأییدکننده را حذف کنید یا در «تنظیمات» تأیید داخلی را خاموش کنید.</p>}
      {waitingOn.length === 0 && selfApprover && <p role="note" className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs leading-6 text-sky-800">شما خودتان تأییدکننده‌ی این قرارداد هستید؛ زدن «انتشار نسخه نهایی» به‌منزله‌ی تأیید همین نسخه است و نیازی به مرحله‌ی جداگانه نیست.</p>}
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      {state.saved && !pending && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">پیش‌نویس ذخیره شد.</p>}
    </form>
  );
}
