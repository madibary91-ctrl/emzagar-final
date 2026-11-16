"use client";

import { X } from "lucide-react";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const faDigits = (n: number | string) => String(n).replace(/\d/g, (d) => FA[Number(d)]);

/** نوار پیشرفت ارسال فایل (U-12) با دکمه‌ی لغو. percent=null ⇒ حالت نامعین (نوار متحرک) */
export default function UploadProgress({ percent, label = "در حال ارسال فایل…", onCancel }: { percent: number | null; label?: string; onCancel?: () => void }) {
  const known = percent !== null;
  const sending = known && percent >= 100;
  return (
    <div className="space-y-2 rounded-2xl border border-ink/10 bg-white p-3" data-testid="upload-progress">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-bold" aria-live="polite">{sending ? "ارسال شد؛ در حال پردازش روی سرور…" : label}</span>
        <span className="flex items-center gap-2">
          {known && <span className="tabular-nums text-ink/70">{faDigits(percent)}٪</span>}
          {onCancel && !sending && (
            <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-bold text-rose-700 hover:bg-rose-50">
              <X size={13} aria-hidden="true" />لغو
            </button>
          )}
        </span>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? percent : undefined} aria-label="پیشرفت ارسال فایل" className="h-2 overflow-hidden rounded-full bg-stone-200">
        <div className={`h-full rounded-full bg-emerald-500 transition-[width] duration-200 ${known && !sending ? "" : "animate-pulse"}`} style={{ width: known ? `${percent}%` : "40%" }} />
      </div>
    </div>
  );
}
