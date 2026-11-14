"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Eye, Send } from "lucide-react";
import { previewMergeAction, startMergeAction } from "@/modules/merge/actions";
import type { PreviewResult } from "@/modules/merge/service";
import type { MergeMapping, MergeOptions, Placeholder, Roles } from "@/modules/merge/pure";

const fmt = (n: number) => n.toLocaleString("fa-IR");

function ColSelect({ id, label, value, headers, onChange, required, hint }: { id: string; label: string; value: string; headers: string[]; onChange: (v: string) => void; required?: boolean; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}{required && <span className="text-rose-600"> *</span>}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={required && !value ? true : undefined}>
        <option value="">— انتخاب نشده —</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
      {hint && <p className="mt-1 text-[11px] text-ink/65">{hint}</p>}
    </div>
  );
}

/** بازبینی پیش از ارسال: نگاشت ستون‌ها، گزینه‌ها، برنامه‌ی پرداخت و پیش‌نمایش زنده‌ی سند شخصی‌سازی‌شده */
export default function MergeReview({ batchId, headers, placeholders, initialMapping, initialOptions, sampleRows, total }: { batchId: number; headers: string[]; placeholders: Placeholder[]; initialMapping: MergeMapping; initialOptions: MergeOptions; sampleRows: string[][]; total: number }) {
  const router = useRouter();
  const [mapping, setMapping] = useState(initialMapping);
  const [options, setOptions] = useState(initialOptions);
  const [sampleNo, setSampleNo] = useState(1);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [perr, setPerr] = useState("");
  const [msg, setMsg] = useState("");
  const [pending, start] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    const t = setTimeout(async () => {
      const r = await previewMergeAction(batchId, { mapping, options }, sampleNo);
      if (my !== seq.current) return;
      if (r.ok) {
        setPreview(r.preview);
        setPerr("");
      } else setPerr(r.error);
    }, 350);
    return () => clearTimeout(t);
  }, [batchId, mapping, options, sampleNo]);

  const setRole = (k: keyof Roles, v: string) => setMapping((m) => ({ ...m, roles: { ...m.roles, [k]: v } }));
  const setVar = (k: string, v: string) => setMapping((m) => ({ ...m, vars: { ...m.vars, [k]: v } }));
  const setPlan = (patch: Partial<MergeOptions["plan"]>) => setOptions((o) => ({ ...o, plan: { ...o.plan, ...patch } }));
  const custom = placeholders.filter((p) => !["USER_NAME", "USER_MOBILE"].includes(p.key));
  const ready = !!mapping.roles.name && !!mapping.roles.mobile && (preview?.valid ?? 0) > 0;

  const go = () => {
    if (!window.confirm(`${fmt(preview?.valid ?? 0)} قرارداد برای گیرندگان ارسال می‌شود. ادامه می‌دهید؟`)) return;
    start(async () => {
      const r = await startMergeAction(batchId, { mapping, options });
      if (!r.ok) return setMsg(r.error || "شروع نشد");
      router.refresh();
    });
  };

  return (
    <div className="space-y-5">
      <section className="panel-solid space-y-4 p-5 sm:p-6">
        <h2 className="text-sm font-black">۱) نگاشت ستون‌های فایل ({fmt(total)} ردیف)</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ColSelect id="mp-name" label="نام امضاکننده" required value={mapping.roles.name} headers={headers} onChange={(v) => setRole("name", v)} />
          <ColSelect id="mp-mobile" label="موبایل (کد تأیید امضا به آن می‌رود)" required value={mapping.roles.mobile} headers={headers} onChange={(v) => setRole("mobile", v)} />
          <ColSelect id="mp-amount" label="مبلغ (تومان)" value={mapping.roles.amount} headers={headers} onChange={(v) => setRole("amount", v)} hint="برای [AMOUNT] و برنامه‌ی پرداخت" />
          {options.plan.enabled && <ColSelect id="mp-dep" label="بیعانه‌ی اختصاصی هر ردیف" value={mapping.roles.deposit} headers={headers} onChange={(v) => setRole("deposit", v)} hint="اختیاری؛ وگرنه درصد پیش‌فرض" />}
          {options.plan.enabled && <ColSelect id="mp-cnt" label="تعداد اقساط هر ردیف" value={mapping.roles.count} headers={headers} onChange={(v) => setRole("count", v)} hint="اختیاری؛ وگرنه تعداد پیش‌فرض" />}
        </div>
        {custom.length > 0 ? (
          <div>
            <h3 className="mb-2 text-xs font-black text-ink/80">متغیرهای داخل قالب</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {custom.map((p) => <ColSelect key={p.key} id={`mv-${p.key}`} label={p.style === "curly" ? `{{${p.key}}}` : `[${p.key}]`} value={mapping.vars[p.key] ?? ""} headers={headers} onChange={(v) => setVar(p.key, v)} />)}
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink/72">در قالب متغیر اختصاصی پیدا نشد؛ فقط نام و موبایل جایگزین می‌شود. برای شخصی‌سازی بیشتر در قالب <code dir="ltr">{"{{نام ستون}}"}</code> بنویسید.</p>
        )}
        {sampleRows.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-ink/10">
            <table className="w-full text-xs"><thead className="bg-stone-50"><tr>{headers.map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
              <tbody>{sampleRows.map((r, i) => <tr key={i} className="border-t border-ink/[.06]">{r.map((c, j) => <td key={j} className="td !py-2 whitespace-nowrap">{c}</td>)}</tr>)}</tbody></table>
          </div>
        )}
      </section>

      <section className="panel-solid space-y-4 p-5 sm:p-6">
        <h2 className="text-sm font-black">۲) تنظیمات ارسال</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><label htmlFor="op-title" className="label">عنوان هر قرارداد (می‌تواند متغیر داشته باشد)</label><input id="op-title" className="input" value={options.contractTitle} onChange={(e) => setOptions({ ...options, contractTitle: e.target.value })} /></div>
          <div><label htmlFor="op-label" className="label">عنوان نقش امضاکننده</label><input id="op-label" className="input" value={options.signerLabel} onChange={(e) => setOptions({ ...options, signerLabel: e.target.value })} placeholder="کارمند / مشتری / پیمانکار" /></div>
          <div><label htmlFor="op-exp" className="label">مهلت امضا (روز؛ ۰ = بدون مهلت)</label><input id="op-exp" className="input" dir="ltr" inputMode="numeric" value={options.expiryDays ?? 0} onChange={(e) => setOptions({ ...options, expiryDays: Number(e.target.value) || null })} /></div>
          <div><label htmlFor="op-tags" className="label">برچسب‌ها (با ویرگول)</label><input id="op-tags" className="input" value={options.tags} onChange={(e) => setOptions({ ...options, tags: e.target.value })} placeholder="منابع انسانی, ۱۴۰۵" /></div>
          <label className="flex items-center gap-2 self-end pb-3 text-xs font-semibold"><input type="checkbox" checked={options.skipDuplicates} onChange={(e) => setOptions({ ...options, skipDuplicates: e.target.checked })} />ردیف‌های تکراری (نام و موبایل یکسان) ارسال نشود</label>
        </div>
        <div className="rounded-2xl border border-ink/10 bg-stone-50 p-4">
          <label className="flex items-center gap-2 text-sm font-black"><input type="checkbox" checked={options.plan.enabled} onChange={(e) => setPlan({ enabled: e.target.checked })} />ارسال همراه با برنامه‌ی پرداخت (امضا و پرداخت)</label>
          {options.plan.enabled && (
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <div><label htmlFor="pl-pct" className="label">بیعانه (٪)</label><input id="pl-pct" className="input" dir="ltr" inputMode="numeric" value={options.plan.depositPercent} onChange={(e) => setPlan({ depositPercent: Number(e.target.value) || 0 })} /></div>
              <div><label htmlFor="pl-cnt" className="label">تعداد اقساط</label><input id="pl-cnt" className="input" dir="ltr" inputMode="numeric" value={options.plan.count} onChange={(e) => setPlan({ count: Number(e.target.value) || 0 })} /></div>
              <div><label htmlFor="pl-int" className="label">فاصله (روز)</label><input id="pl-int" className="input" dir="ltr" inputMode="numeric" value={options.plan.intervalDays} onChange={(e) => setPlan({ intervalDays: Number(e.target.value) || 30 })} /></div>
              <label className="flex items-center gap-2 self-end pb-3 text-xs font-semibold"><input type="checkbox" checked={options.plan.gateDeposit} onChange={(e) => setPlan({ gateDeposit: e.target.checked })} />بیعانه پیش‌شرط امضا</label>
              <p className="text-[11px] leading-6 text-ink/70 sm:col-span-4">مبلغ هر ردیف از ستون «مبلغ» خوانده و بین بیعانه و اقساط تقسیم می‌شود؛ جدول پرداخت در متن همان قرارداد درج می‌شود.</p>
            </div>
          )}
        </div>
      </section>

      <section className="panel-solid space-y-4 p-5 sm:p-6" aria-live="polite">
        <h2 className="flex items-center gap-2 text-sm font-black"><Eye size={16} />۳) پیش‌نمایش و اعتبارسنجی</h2>
        {perr && <p className="text-xs font-bold text-rose-600" role="alert">{perr}</p>}
        {preview && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl bg-emerald-50 p-3"><span className="text-xs text-emerald-800">آماده‌ی ارسال</span><b className="block text-2xl text-emerald-900">{fmt(preview.valid)}</b></div>
              <div className="rounded-2xl bg-rose-50 p-3"><span className="text-xs text-rose-800">نامعتبر</span><b className="block text-2xl text-rose-900">{fmt(preview.invalid)}</b></div>
              <div className="rounded-2xl bg-amber-50 p-3"><span className="text-xs text-amber-800">تکراری</span><b className="block text-2xl text-amber-900">{fmt(preview.duplicates)}</b></div>
              <div className="rounded-2xl bg-stone-50 p-3"><span className="text-xs text-ink/70">جمع مبالغ</span><b className="block text-lg">{preview.paymentTotal ? `${fmt(preview.paymentTotal)} ت` : "—"}</b></div>
            </div>
            {preview.problems.length > 0 && (
              <details className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-xs">
                <summary className="cursor-pointer font-bold text-rose-800"><AlertTriangle size={13} className="ml-1 inline" />ردیف‌های دارای خطا (ردیف‌های نامعتبر ارسال نمی‌شوند)</summary>
                <ul className="mt-2 space-y-1">{preview.problems.map((p) => <li key={p.rowNo}>ردیف {fmt(p.rowNo)}: {p.error}</li>)}{preview.invalid > preview.problems.length && <li>… و {fmt(preview.invalid - preview.problems.length)} مورد دیگر</li>}</ul>
              </details>
            )}
            {preview.sample && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label htmlFor="sample-no" className="text-xs font-bold">نمونه‌ی ردیف</label>
                  <input id="sample-no" type="number" min={1} max={total} dir="ltr" className="input !min-h-10 !w-24" value={sampleNo} onChange={(e) => setSampleNo(Math.max(1, Math.min(total, Number(e.target.value) || 1)))} />
                  <span className="text-xs text-ink/72">{preview.sample.name} — <span dir="ltr">{preview.sample.mobile}</span></span>
                </div>
                <h3 className="text-sm font-black">{preview.sample.title}</h3>
                <article className="contract-paper contract-body max-h-96 overflow-auto" dangerouslySetInnerHTML={{ __html: preview.sample.bodyHtml }} />
              </div>
            )}
          </>
        )}
        {msg && <p className="text-xs font-bold text-rose-600" role="alert">{msg}</p>}
        <div className="flex flex-wrap items-center gap-3 border-t border-ink/[.07] pt-4">
          <button type="button" className="btn-primary btn-mint !min-h-[50px]" disabled={!ready || pending} onClick={go}><Send size={17} />{pending ? "در حال آماده‌سازی…" : `ارسال ${preview ? fmt(preview.valid) : ""} قرارداد`}</button>
          {ready && <span className="flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 size={14} />ارسال در پس‌زمینه انجام می‌شود؛ می‌توانید صفحه را ببندید.</span>}
        </div>
      </section>
    </div>
  );
}
