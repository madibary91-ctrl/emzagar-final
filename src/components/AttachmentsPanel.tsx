"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, ImageIcon, LoaderCircle, Paperclip, Trash2, UploadCloud } from "lucide-react";
import { confirmDialog } from "@/components/ui/dialogs";
import UploadProgress from "@/components/UploadProgress";
import { uploadForm } from "@/lib/upload-client";
import { NET_MESSAGES, isOffline } from "@/lib/safe-call";

export type AttachmentItem = { id: number; name: string; size: number; sha256: string; title: string; uploader: string; at: string; mime: string; deletable: boolean };

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);
const MAX = 5 * 1024 * 1024;
const sizeText = (b: number) => (b >= 1024 * 1024 ? `${faDigits((b / 1024 / 1024).toFixed(1))} مگابایت` : `${faDigits(Math.max(1, Math.round(b / 1024)))} کیلوبایت`);

/**
 * پیوست فایل (کارت ملی، فاکتور …). حالت حساب کاربری: contractId؛ حالت لینک امن: token.
 * فقط PDF/PNG/JPG/WebP تا ۵ مگابایت؛ سرور نوع واقعی فایل را از روی محتوا بررسی و SHA-256 را ثبت می‌کند.
 */
export default function AttachmentsPanel({ contractId, token, items, canUpload, hint }: { contractId?: number; token?: string; items: AttachmentItem[]; canUpload: boolean; hint?: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const cancel = useRef<AbortController | null>(null);
  const uploadUrl = token ? `/api/sign/${token}/attachments` : `/api/contracts/${contractId}/attachments`;
  const downloadUrl = (id: number) => (token ? `/api/sign/${token}/attachments?id=${id}` : `/api/contracts/${contractId}/attachments/${id}`);

  const upload = async (file: File | undefined) => {
    setError("");
    if (!file) return;
    if (file.size > MAX) return setError("حجم فایل بیش از ۵ مگابایت است");
    setBusy(true);
    setProgress(0);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("title", title);
    const ac = new AbortController();
    cancel.current = ac;
    // U-12/U-13: نوار پیشرفت + سقف زمان + لغو؛ هیچ مسیری بدون آزادشدن دکمه نیست
    const r = await uploadForm<{ ok?: boolean }>(uploadUrl, fd, { onProgress: setProgress, signal: ac.signal, fallbackError: "آپلود ناموفق بود" });
    cancel.current = null;
    setBusy(false);
    setProgress(null);
    if (input.current) input.current.value = "";
    if (!r.ok) {
      if (r.kind !== "aborted") setError(r.error);
      return;
    }
    setTitle("");
    router.refresh();
  };

  const remove = async (id: number) => {
    if (!contractId || !(await confirmDialog({ title: "حذف پیوست", message: "این پیوست حذف شود؟", confirmLabel: "بله، حذف شود" }))) return;
    setBusy(true);
    setError("");
    try {
      const ac = new AbortController();
      const timer = window.setTimeout(() => ac.abort(), 30_000);
      const r = await fetch(`/api/contracts/${contractId}/attachments/${id}`, { method: "DELETE", signal: ac.signal }).finally(() => window.clearTimeout(timer));
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) setError(d.error || "حذف ناموفق بود");
      else router.refresh();
    } catch {
      setError(isOffline() ? NET_MESSAGES.offline : NET_MESSAGES.server);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="attachments" className="panel-solid scroll-mt-24 space-y-4 p-5 sm:p-6" aria-labelledby="attachments-title">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-ink text-mint"><Paperclip size={18} /></span>
        <div>
          <h2 id="attachments-title" className="text-sm font-black">پیوست‌ها</h2>
          <p className="mt-0.5 text-xs text-ink/72">{hint ?? "مدارک همراه قرارداد (کارت ملی، فاکتور …) با ثبت اثر انگشت SHA-256"}</p>
        </div>
      </div>

      {items.length === 0 && <p className="rounded-2xl bg-stone-50 p-4 text-xs text-ink/72">هنوز پیوستی ثبت نشده است.</p>}
      <ul className="space-y-2">
        {items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-ink/10 bg-stone-50/60 p-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-ink/70">{a.mime.startsWith("image/") ? <ImageIcon size={16} /> : <FileText size={16} />}</span>
            <div className="min-w-0 flex-1">
              <a href={downloadUrl(a.id)} className="block truncate text-xs font-bold text-ink underline-offset-2 hover:underline">{a.title ? `${a.title} — ` : ""}{a.name}</a>
              <span className="block text-[11px] text-ink/72">{a.uploader} • {sizeText(a.size)} • {a.at}</span>
              <span dir="ltr" className="block truncate text-left font-mono text-[10px] text-ink/72" title={a.sha256}>SHA-256: {a.sha256.slice(0, 24)}…</span>
            </div>
            {a.deletable && (
              <button type="button" onClick={() => remove(a.id)} disabled={busy} className="btn-danger btn-sm" aria-label={`حذف ${a.name}`}>
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {canUpload && (
        <div className="space-y-3 rounded-2xl border border-dashed border-ink/20 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <label className="label" htmlFor="att-title">عنوان (اختیاری)</label>
              <input id="att-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="مثلاً تصویر کارت ملی" className="input" />
            </div>
            <div>
              <input ref={input} id="att-file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
              <label htmlFor="att-file" className={`btn-secondary cursor-pointer ${busy ? "pointer-events-none opacity-60" : ""}`}>
                {busy ? <LoaderCircle size={16} className="animate-spin" /> : <UploadCloud size={16} />}
                انتخاب و آپلود فایل
              </label>
            </div>
          </div>
          <p className="text-xs text-ink/72">PDF، PNG، JPG یا WebP — حداکثر ۵ مگابایت.</p>
        </div>
      )}
      {busy && progress !== null && <UploadProgress percent={progress} onCancel={() => cancel.current?.abort()} />}
      {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
    </section>
  );
}
