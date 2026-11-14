"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react";

export default function MergeUploadForm({ templates }: { templates: { id: number; title: string }[] }) {
  const router = useRouter();
  const [tid, setTid] = useState(templates[0]?.id ? String(templates[0].id) : "");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!tid) return setError("ابتدا یک قالب انتخاب کنید");
    if (!file) return setError("فایل اکسل یا CSV را انتخاب کنید");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("templateId", tid);
      fd.set("title", title);
      fd.set("file", file);
      const res = await fetch("/api/merge/upload", { method: "POST", body: fd });
      const j = (await res.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!res.ok || !j.id) {
        setError(j.error || "بارگذاری انجام نشد");
        setBusy(false);
        return;
      }
      router.push(`/admin/merge/${j.id}`);
    } catch {
      setError("ارتباط با سرور برقرار نشد");
      setBusy(false);
    }
  };

  if (templates.length === 0) return <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">برای ارسال انبوه ابتدا یک قالب بسازید (یا از «کتابخانه‌ی قالب‌ها» کپی کنید). در متن قالب از <code dir="ltr">{"{{نام ستون}}"}</code> یا <code dir="ltr">[SALARY]</code> برای مقدارهای شخصی استفاده کنید.</p>;

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="بارگذاری فایل ارسال انبوه">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="mg-tpl" className="label">قالب قرارداد</label>
          <select id="mg-tpl" className="input" value={tid} onChange={(e) => setTid(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mg-title" className="label">عنوان دسته (اختیاری)</label>
          <input id="mg-title" className="input" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً قرارداد کارکنان ۱۴۰۵" />
        </div>
      </div>
      <div>
        <label htmlFor="mg-file" className="label">فایل اکسل (xlsx) یا CSV — حداکثر ۲٬۰۰۰ ردیف و ۵ مگابایت</label>
        <input id="mg-file" type="file" accept=".xlsx,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input !py-3" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <p className="mt-2 text-xs leading-6 text-ink/72">ردیف اول سرستون‌هاست (نام، موبایل، مبلغ و هر ستون دلخواه). بارگذاری فقط فایل را می‌خواند؛ هیچ قراردادی تا تأیید شما ارسال نمی‌شود.</p>
      </div>
      {error && <p role="alert" className="text-xs font-bold text-rose-600">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary btn-mint" disabled={busy}>{busy ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />}بارگذاری و بازبینی</button>
        <a href={`/api/merge/sample?templateId=${tid}`} className="btn-secondary btn-sm"><Download size={14} />دانلود فایل نمونه‌ی این قالب</a>
        {file && <span className="flex items-center gap-1 text-xs text-ink/72"><FileSpreadsheet size={14} />{file.name}</span>}
      </div>
    </form>
  );
}
