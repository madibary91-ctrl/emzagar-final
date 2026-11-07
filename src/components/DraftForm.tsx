"use client";

import { useActionState } from "react";
import { Rocket, Save } from "lucide-react";
import RichEditor from "@/components/RichEditor";
import { draftAction, type DraftState } from "@/modules/contracts/actions";

export default function DraftForm({ id, title, body }: { id: number; title: string; body: string }) {
  const [state, action, pending] = useActionState<DraftState, FormData>(draftAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={id} />
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
        <button disabled={pending} name="intent" value="save" className="btn-secondary"><Save size={16} />ذخیره پیش‌نویس</button>
        <button
          disabled={pending}
          name="intent"
          value="publish"
          onClick={(e) => {
            if (!confirm("پس از انتشار، متن قرارداد قفل می‌شود و برای امضاکننده ارسال خواهد شد. ادامه می‌دهید؟")) e.preventDefault();
          }}
          className="btn-primary btn-mint"
        >
          <Rocket size={16} />انتشار نسخه نهایی
        </button>
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      {state.saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">پیش‌نویس ذخیره شد.</p>}
    </form>
  );
}
