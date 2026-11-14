"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus, QrCode, Trash2 } from "lucide-react";
import DocUploader, { DocWarnings, type UploadedDoc } from "@/components/DocUploader";
import { DocPlacer } from "@/components/DocViews";
import { COLLECT_FIELD_TYPES, type CollectField, type CollectFieldType } from "@/modules/collect/schema";
import { COLLECT_PRESETS } from "@/modules/collect/presets";
import type { Placement } from "@/modules/docs/placement";
import { createCampaignAction } from "@/modules/collect/actions";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const toHtml = (text: string) => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

type Row = CollectField & { optionsText?: string };

export default function CollectBuilder() {
  const router = useRouter();
  const [kind, setKind] = useState<"text" | "file">("text");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [doc, setDoc] = useState<UploadedDoc | null>(null);
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [requireOtp, setRequireOtp] = useState(true);
  const [requireSignature, setRequireSignature] = useState(true);
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [max, setMax] = useState("");
  const [closes, setCloses] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  const setRow = (i: number, patch: Partial<Row>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  const preset = (id: string) => {
    const p = COLLECT_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setKind("text");
    setTitle(p.title);
    setDescription(p.description);
    setBody(p.body);
    setRows(p.fields.map((f) => ({ ...f, optionsText: f.options?.join("، ") })));
  };

  const submit = () => {
    setError("");
    start(async () => {
      const r = await createCampaignAction({
        title,
        description,
        bodyHtml: kind === "text" ? toHtml(body) : "",
        fields: rows.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.type === "select" ? (f.optionsText ?? "").split(/[\n,،]/).map((o) => o.trim()).filter(Boolean) : undefined })),
        requireOtp,
        requireSignature,
        allowDuplicates,
        maxSubmissions: max ? Number(max) : null,
        closesAtIso: closes ? new Date(`${closes}T23:59:59`).toISOString() : undefined,
        successMessage: success,
        draftCode: kind === "file" ? doc?.code : undefined,
        placements: kind === "file" ? placements : undefined,
      });
      if (!r.ok || !r.id) return setError(r.error || "ساخت انجام نشد");
      router.push(`/admin/collect/${r.id}?created=1`);
    });
  };

  return (
    <div className="space-y-6">
      <section className="card space-y-3">
        <h2 className="text-sm font-black">شروع سریع با نمونه</h2>
        <div className="flex flex-wrap gap-2">
          {COLLECT_PRESETS.map((p) => (
            <button key={p.id} type="button" onClick={() => preset(p.id)} className="rounded-2xl border border-ink/12 bg-white px-3 py-2 text-xs font-bold transition hover:border-ink/40">
              {p.emoji} {p.title}
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <div className="flex gap-2" role="tablist" aria-label="نوع سند">
          {([["text", "متن توافق‌نامه"], ["file", "فایل PDF/Word من"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`rounded-xl px-4 py-2 text-xs font-bold ${kind === k ? "bg-ink text-white" : "bg-stone-100"}`}>{l}</button>
          ))}
        </div>
        <div>
          <label className="label" htmlFor="c-title">عنوان فرم</label>
          <input id="c-title" className="input" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="مثلاً رضایت‌نامه‌ی ثبت‌نام باشگاه" />
        </div>
        <div>
          <label className="label" htmlFor="c-desc">توضیح کوتاه (اختیاری)</label>
          <input id="c-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 300))} />
        </div>
        {kind === "text" ? (
          <div>
            <label className="label" htmlFor="c-body">متنی که مردم امضا می‌کنند</label>
            <textarea id="c-body" rows={9} className="input" value={body} onChange={(e) => setBody(e.target.value.slice(0, 50000))} placeholder="بین بندها یک خط خالی بگذارید…" />
          </div>
        ) : doc ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-stone-50 p-4 text-sm">
            <span><b>{doc.name}</b> — {doc.pageCount} صفحه</span>
            <button type="button" className="btn-secondary btn-sm" onClick={() => { setDoc(null); setPlacements([]); }}>تعویض فایل</button>
          </div>
        ) : (
          <DocUploader mode="team" onUploaded={(d) => { setDoc(d); if (!title) setTitle(d.name.replace(/\.(pdf|docx)$/i, "")); }} />
        )}
        {kind === "file" && doc && <DocWarnings warnings={doc.warnings} />}
      </section>

      {kind === "file" && doc && (
        <section className="space-y-3">
          <h2 className="text-sm font-black">جای امضا و فیلدها روی فایل (برای هر نفر که امضا می‌کند)</h2>
          <DocPlacer url={`/api/docs/draft/${doc.code}`} pages={doc.pages} signers={[{ pos: 1, label: "امضاکننده" }]} value={placements} onChange={setPlacements} />
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-sm font-black">اطلاعاتی که از هر نفر می‌گیرید</h2>
        <p className="text-xs leading-6 text-ink/70">نام کامل و موبایل همیشه گرفته می‌شود. فیلدهای بیشتر را اینجا اضافه کنید.</p>
        {rows.map((f, i) => (
          <div key={i} className="grid gap-2 rounded-2xl bg-stone-50 p-3 sm:grid-cols-[1fr_170px_auto_auto] sm:items-center">
            <input aria-label="عنوان فیلد" className="input" value={f.label} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="عنوان (مثلاً کد ملی)" />
            <select aria-label="نوع فیلد" className="input" value={f.type} onChange={(e) => setRow(i, { type: e.target.value as CollectFieldType })}>
              {COLLECT_FIELD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={f.required} onChange={(e) => setRow(i, { required: e.target.checked })} />اجباری</label>
            <button type="button" aria-label="حذف فیلد" className="btn-ghost btn-sm" onClick={() => setRows((r) => r.filter((_, k) => k !== i))}><Trash2 size={15} /></button>
            {f.type === "select" && <input aria-label="گزینه‌ها" className="input sm:col-span-4" value={f.optionsText ?? f.options?.join("، ") ?? ""} onChange={(e) => setRow(i, { optionsText: e.target.value })} placeholder="گزینه‌ها را با ویرگول جدا کنید: مقدماتی، متوسط، پیشرفته" />}
          </div>
        ))}
        {rows.length < 20 && <button type="button" className="btn-secondary btn-sm" onClick={() => setRows((r) => [...r, { key: `f${r.length + 1}`, label: "", type: "text", required: true }])}><Plus size={14} />افزودن فیلد</button>}
      </section>

      <section className="card space-y-3">
        <h2 className="text-sm font-black">تنظیمات</h2>
        <label className="flex items-start gap-2 text-xs leading-6"><input className="mt-1.5" type="checkbox" checked={requireOtp} onChange={(e) => setRequireOtp(e.target.checked)} /><span><b>تأیید موبایل با پیامک</b> — اعتبار حقوقی و جلوگیری از شماره‌ی جعلی (پیشنهاد می‌شود)</span></label>
        <label className="flex items-start gap-2 text-xs leading-6"><input className="mt-1.5" type="checkbox" checked={requireSignature} onChange={(e) => setRequireSignature(e.target.checked)} /><span><b>گرفتن امضای دستی</b> — اگر خاموش باشد، پذیرش متن کافی است</span></label>
        <label className="flex items-start gap-2 text-xs leading-6"><input className="mt-1.5" type="checkbox" checked={allowDuplicates} onChange={(e) => setAllowDuplicates(e.target.checked)} /><span>اجازه‌ی ثبت چندباره با یک شماره (پیش‌فرض: هر شماره یک‌بار)</span></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="c-max">سقف تعداد امضا (اختیاری)</label><input id="c-max" className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, "").slice(0, 7))} /></div>
          <div><label className="label" htmlFor="c-close">آخرین مهلت (اختیاری)</label><input id="c-close" type="date" className="input" value={closes} onChange={(e) => setCloses(e.target.value)} /></div>
        </div>
        <div><label className="label" htmlFor="c-msg">پیام پس از امضا (اختیاری)</label><input id="c-msg" className="input" value={success} onChange={(e) => setSuccess(e.target.value.slice(0, 300))} placeholder="ممنون! ثبت‌نام شما تکمیل شد." /></div>
      </section>

      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
      <div className="flex justify-end">
        <button type="button" onClick={submit} disabled={pending} className="btn-primary btn-mint !min-h-[50px] sm:!px-8">
          {pending ? <LoaderCircle size={17} className="animate-spin" /> : <QrCode size={17} />}ساخت لینک و QR
        </button>
      </div>
    </div>
  );
}
