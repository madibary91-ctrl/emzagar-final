"use client";

import { useRef, useState } from "react";
import { FileText, FileUp, LoaderCircle, OctagonAlert, TriangleAlert } from "lucide-react";
import type { PageMeta } from "@/modules/docs/placement";

export interface UploadedDoc {
  code: string;
  kind: "pdf" | "docx";
  name: string;
  pageCount: number;
  pages: PageMeta[];
  warnings: string[];
}

/** هشدارهای برجسته‌ی تبدیل Word (قابل نادیده‌گرفتن نیستند: نقش alert، رنگ پررنگ و آیکون) */
export function DocWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div role="alert" aria-live="assertive" className="space-y-2 rounded-2xl border-2 border-amber-400 bg-amber-100 p-4 text-amber-950 shadow-sm">
      <p className="flex items-center gap-2 text-sm font-black"><TriangleAlert size={18} className="shrink-0" />هشدار مهم درباره‌ی تبدیل فایل Word</p>
      <ul className="list-disc space-y-1 pr-5 text-xs font-bold leading-6">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
    </div>
  );
}

/** بارگذاری فایل PDF/Word (کشیدن و رها کردن یا انتخاب) ← پیش‌نویس سمت سرور */
export default function DocUploader({ mode, onUploaded }: { mode: "team" | "quick"; onUploaded: (d: UploadedDoc) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [over, setOver] = useState(false);

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setErrorCode("");
    if (file.size > 12 * 1024 * 1024) return setError("حجم فایل بیشتر از ۱۲ مگابایت است");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("mode", mode);
      const res = await fetch("/api/docs/upload", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorCode(String(j.code || ""));
        throw new Error(j.error || "بارگذاری ناموفق بود");
      }
      onUploaded({ code: j.code, kind: j.kind, name: j.name, pageCount: j.pageCount, pages: j.pages, warnings: j.warnings ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "بارگذاری ناموفق بود");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files?.[0]); }}
        className={`grid cursor-pointer place-items-center rounded-3xl border-2 border-dashed p-8 text-center transition ${over ? "border-emerald-500 bg-emerald-50" : "border-ink/20 bg-white hover:border-ink/40"}`}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        <input ref={input} type="file" hidden accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(e) => void send(e.target.files?.[0])} />
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-ink text-mint">{busy ? <LoaderCircle className="animate-spin" size={24} /> : <FileUp size={24} />}</span>
        <p className="mt-3 text-sm font-black">{busy ? "در حال پردازش فایل…" : "فایل PDF یا Word خود را اینجا بکشید یا انتخاب کنید"}</p>
        <p className="mt-1 text-xs text-ink/65">PDF و docx تا ۱۲ مگابایت — فایل Word دارای تصویر/مهر پذیرفته نمی‌شود (PDF بارگذاری کنید)</p>
      </div>
      {error && errorCode === "docx_has_images" && (
        <div role="alert" aria-live="assertive" className="mt-3 space-y-3 rounded-2xl border-2 border-rose-500 bg-rose-50 p-4 text-rose-900 shadow-sm">
          <p className="flex items-center gap-2 text-sm font-black"><OctagonAlert size={20} className="shrink-0" />این فایل Word پذیرفته نشد؛ لطفاً PDF بارگذاری کنید</p>
          <p className="text-xs font-bold leading-6">{error}</p>
          <p className="flex items-center gap-2 rounded-xl bg-white/70 p-2 text-xs leading-6"><FileText size={16} className="shrink-0" />در Word: «File ← Save As ← PDF» و سپس همان فایل PDF را همین‌جا بارگذاری کنید. مهر و امضای اسکن‌شده در PDF حفظ می‌شود.</p>
        </div>
      )}
      {error && errorCode !== "docx_has_images" && <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs leading-6 text-rose-700"><TriangleAlert size={15} className="mt-1 shrink-0" />{error}</p>}
    </div>
  );
}
