"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Download, RotateCcw, Trash2 } from "lucide-react";
import { cancelMergeAction, deleteMergeAction, retryMergeAction, type MergeResult } from "@/modules/merge/actions";

export default function MergeActions({ batchId, status, failed, canDelete }: { batchId: number; status: string; failed: number; canDelete: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<MergeResult | null>(null);
  const run = (fn: () => Promise<MergeResult>, after?: () => void) => start(async () => {
    const r = await fn();
    setMsg(r);
    if (r.ok) {
      after?.();
      router.refresh();
    }
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <a className="btn-secondary btn-sm" href={`/api/merge/${batchId}/report`}><Download size={14} />گزارش CSV</a>
      {failed > 0 && status !== "cancelled" && <button className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => retryMergeAction(batchId))}><RotateCcw size={14} />تلاش دوباره‌ی ناموفق‌ها ({failed.toLocaleString("fa-IR")})</button>}
      {status === "running" && <button className="btn-danger btn-sm" disabled={pending} onClick={() => window.confirm("ردیف‌های ارسال‌نشده لغو شوند؟ قراردادهای ارسال‌شده پابرجا می‌مانند.") && run(() => cancelMergeAction(batchId))}><Ban size={14} />لغو ادامه‌ی ارسال</button>}
      {canDelete && status !== "running" && <button className="btn-ghost btn-sm" disabled={pending} onClick={() => window.confirm("این دسته و گزارش آن حذف شود؟ قراردادهای ساخته‌شده حذف نمی‌شوند.") && run(() => deleteMergeAction(batchId), () => router.push("/admin/merge"))}><Trash2 size={14} />حذف دسته</button>}
      {msg && <span role="status" className={`text-xs font-bold ${msg.ok ? "text-emerald-700" : "text-rose-600"}`}>{msg.ok ? msg.message : msg.error}</span>}
    </div>
  );
}
