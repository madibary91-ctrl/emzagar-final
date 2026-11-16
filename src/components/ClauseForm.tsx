"use client";

import { useActionState } from "react";
import RichEditor from "@/components/RichEditor";
import { saveClauseAction, type ClauseFormState } from "@/modules/clauses/actions";
import { CLAUSE_CATEGORIES } from "@/modules/clauses/builtin";

export default function ClauseForm({ initial }: { initial?: { id: number; title: string; category: string; body: string } }) {
  const [state, action, pending] = useActionState<ClauseFormState, FormData>(saveClauseAction, {});
  return (
    <form action={action} className="space-y-3">
      {initial && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div>
          <label className="label" htmlFor={`clause-title-${initial?.id ?? "new"}`}>عنوان بند</label>
          <input id={`clause-title-${initial?.id ?? "new"}`} name="title" required minLength={2} maxLength={120} defaultValue={initial?.title} className="input" placeholder="مثلاً: ضمانت کیفیت" />
        </div>
        <div>
          <label className="label" htmlFor={`clause-cat-${initial?.id ?? "new"}`}>دسته</label>
          <select id={`clause-cat-${initial?.id ?? "new"}`} name="category" defaultValue={initial?.category ?? "general"} className="input">
            {Object.entries(CLAUSE_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">متن بند</label>
        <RichEditor name="body" initialHtml={initial?.body ?? ""} ai={false} />
      </div>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{state.error}</p>}
      {state.ok && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">ذخیره شد.</p>}
      <button disabled={pending} className="btn-primary btn-mint">{pending ? "در حال ذخیره…" : initial ? "ذخیره‌ی تغییرات" : "افزودن به کتابخانه"}</button>
    </form>
  );
}
