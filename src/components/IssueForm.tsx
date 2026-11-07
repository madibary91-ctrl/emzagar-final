"use client";

import { useActionState, useMemo, useState } from "react";
import RichEditor from "@/components/RichEditor";
import { issueContractsAction, type IssueState } from "@/modules/contracts/actions";

interface Tpl { id: number; title: string; body: string }
interface U { id: number; name: string; email: string }
interface Step { key: number; label: string; userId: string }

export default function IssueForm({ templates, users, initialCustomer, kyc }: { templates: Tpl[]; users: U[]; initialCustomer?: number; kyc?: { threshold: number; approved: boolean } }) {
  const [valueText, setValueText] = useState("");
  const valueNum = Number(valueText.replace(/[,٬\s]/g, "").replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))) || 0;
  const needKyc = !!kyc && kyc.threshold > 0 && !kyc.approved && valueNum >= kyc.threshold;
  const [state, action, pending] = useActionState<IssueState, FormData>(issueContractsAction, {});
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [selected, setSelected] = useState<number[]>(initialCustomer && users.some((u) => u.id === initialCustomer) ? [initialCustomer] : []);
  const [search, setSearch] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);

  const filtered = useMemo(
    () => users.filter((u) => (u.name + u.email).toLowerCase().includes(search.toLowerCase())),
    [users, search],
  );

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => String(x.id) === id);
    if (t) {
      setBody(t.body);
      if (!title) setTitle(t.title);
      setEditorKey((k) => k + 1);
    }
  };
  const toggle = (id: number) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const c = [...s];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    });

  return (
    <form action={action} className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="card space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="issue-form-templateId" className="label">قالب</label>
              <select id="issue-form-templateId" name="templateId" value={templateId} onChange={(e) => pickTemplate(e.target.value)} className="input">
                <option value="">— بدون قالب (متن آزاد) —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="issue-form-title" className="label">عنوان قرارداد</label>
              <input id="issue-form-title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} className="input" required />
            </div>
          </div>
          <div>
            <label className="label">متن قرارداد</label>
            <RichEditor key={editorKey} name="body" initialHtml={body} />
            <p className="mt-1 text-xs text-stone-600">متغیرها هنگام صدور برای هر کاربر به‌صورت خودکار جایگزین می‌شوند.</p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="card space-y-3">
          <h2 className="font-bold">۱. گیرندگان (مشتری)</h2>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی کاربر…" className="input" />
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {filtered.map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-stone-50">
                <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} className="accent-[#102c31]" />
                <span>{u.name}</span>
                <span className="text-xs text-stone-600" dir="ltr">{u.email}</span>
              </label>
            ))}
          </div>
          {selected.map((id) => (
            <input key={id} type="hidden" name="customerId" value={id} />
          ))}
          <div className="flex items-center justify-between text-xs text-stone-600">
            <span>{selected.length} کاربر انتخاب شده {selected.length > 1 && "(صدور گروهی)"}</span>
            <button type="button" className="underline" onClick={() => setSelected(filtered.map((u) => u.id))}>انتخاب همه</button>
          </div>
        </div>

        <div className="card space-y-3">
          <h2 className="font-bold">۲. ترتیب امضا</h2>
          <p className="text-xs text-stone-600">امضاکنندگان داخلی به‌ترتیب زیر امضا می‌کنند و در پایان نوبت مشتری است.</p>
          {steps.map((s, i) => (
            <div key={s.key} className="space-y-2 rounded-lg border border-stone-200 p-2">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-stone-200 text-xs">{i + 1}</span>
                <input
                  name="signerLabel"
                  value={s.label}
                  onChange={(e) => setSteps((st) => st.map((x) => (x.key === s.key ? { ...x, label: e.target.value } : x)))}
                  placeholder="عنوان (مثلاً بخش مالی)"
                  className="input"
                />
              </div>
              <select
                name="signerUser"
                value={s.userId}
                onChange={(e) => setSteps((st) => st.map((x) => (x.key === s.key ? { ...x, userId: e.target.value } : x)))}
                className="input"
              >
                <option value="">— انتخاب کاربر —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} className="btn btn-secondary btn-sm">↑</button>
                <button type="button" onClick={() => move(i, 1)} className="btn btn-secondary btn-sm">↓</button>
                <button type="button" onClick={() => setSteps((st) => st.filter((x) => x.key !== s.key))} className="btn btn-secondary btn-sm text-red-700">حذف</button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => setSteps((s) => [...s, { key: Date.now(), label: "", userId: "" }])} className="btn btn-secondary w-full">
            + افزودن امضاکننده
          </button>
          <div className="rounded-lg bg-emerald-50 p-2 text-center text-sm text-emerald-800">آخرین امضاکننده: مشتری</div>
        </div>

        {state.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p>}
        <div>
          <label htmlFor="issue-form-expiryDays" className="label">مهلت امضا (روز) — خالی = پیش‌فرض تنظیمات، ۰ = بدون انقضا</label>
          <input id="issue-form-expiryDays" name="expiryDays" type="number" min={0} max={3650} className="input" placeholder="پیش‌فرض" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div>
            <label htmlFor="issue-form-tags" className="label">برچسب‌ها (با ویرگول جدا کنید)</label>
            <input id="issue-form-tags" name="tags" maxLength={200} className="input" placeholder="مثلاً: مشتری ویژه، سالانه" />
          </div>
          <div>
            <label htmlFor="issue-form-value" className="label">ارزش قرارداد (تومان) — اختیاری</label>
            <input id="issue-form-value" name="contractValue" inputMode="numeric" dir="ltr" value={valueText} onChange={(e) => setValueText(e.target.value)} className="input" placeholder="مثلاً 50000000" />
            {kyc && kyc.threshold > 0 && !kyc.approved && (
              <p role={needKyc ? "alert" : undefined} className={`mt-1 text-xs font-semibold ${needKyc ? "text-red-700" : "text-ink/70"}`}>
                {needKyc ? "این ارزش نیازمند احراز هویت تاییدشده است؛ می‌توانید پیش‌نویس ذخیره کنید یا " : `قراردادهای ${kyc.threshold.toLocaleString("fa-IR")} تومان و بیشتر نیازمند احراز هویت‌اند. `}
                <a href="/admin/kyc" className="underline">احراز هویت</a>
              </p>
            )}
          </div>
        </div>
        <button disabled={pending} name="intent" value="issue" className="btn btn-primary w-full !py-3">
          {pending ? "در حال پردازش…" : selected.length > 1 ? `صدور ${selected.length} قرارداد` : "صدور و ارسال قرارداد"}
        </button>
        <button disabled={pending} name="intent" value="draft" formNoValidate className="btn btn-secondary w-full !py-3">
          ذخیره به‌عنوان پیش‌نویس (بدون ارسال)
        </button>
      </div>
    </form>
  );
}
