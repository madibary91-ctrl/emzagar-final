"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "lucide-react";

/** دکمه‌ی ارسال فرم با حالت «در حال انجام»: کارهای سنگین (بک‌آپ، بررسی) دیگر با کلیک دوباره دوبار اجرا نمی‌شوند */
export default function PendingButton({ children, pendingText, className }: { children: ReactNode; pendingText?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className}>
      {pending ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : null}
      {pending ? pendingText ?? "در حال انجام…" : children}
    </button>
  );
}
