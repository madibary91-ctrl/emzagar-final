"use client";

import { useState } from "react";
import { Ban, LoaderCircle } from "lucide-react";
import Modal from "@/components/ui/Modal";

/** پنجره‌ی رد قرارداد با فیلد دلیل (جایگزین window.prompt) */
export default function RejectDialog({
  open, busy, onClose, onSubmit,
}: {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      tone="danger"
      icon={<Ban size={22} />}
      title="رد قرارداد"
      description="با رد قرارداد، امضا متوقف می‌شود و فرستنده مطلع خواهد شد. دلیل رد را (در صورت تمایل) بنویسید."
      footer={
        <>
          <button type="button" onClick={() => onSubmit(reason.trim())} disabled={busy} className="btn-danger">
            {busy ? <LoaderCircle size={16} className="animate-spin" /> : <Ban size={16} />}
            {busy ? "در حال ثبت…" : "رد قرارداد"}
          </button>
          <button type="button" onClick={onClose} disabled={busy} className="btn-secondary">انصراف</button>
        </>
      }
    >
      <label className="label" htmlFor="reject-reason">دلیل رد (اختیاری)</label>
      <textarea
        id="reject-reason"
        data-autofocus
        value={reason}
        onChange={(e) => setReason(e.target.value.slice(0, 500))}
        rows={4}
        maxLength={500}
        className="input"
        placeholder="مثلاً: مبلغ یا مدت قرارداد با توافق ما مطابقت ندارد"
      />
      <p className="mt-1 text-start text-xs text-ink/75 tabular">{reason.length.toLocaleString("fa-IR")} / {(500).toLocaleString("fa-IR")}</p>
    </Modal>
  );
}
