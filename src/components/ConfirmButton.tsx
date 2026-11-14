"use client";

import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import Modal from "@/components/ui/Modal";

type Props = {
  message: string;
  children: ReactNode;
  /** عنوان پنجره‌ی تأیید (پیش‌فرض: «تأیید عملیات») */
  title?: string;
  confirmLabel?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type">;

/**
 * دکمه‌ی ارسال فرم با پنجره‌ی تأیید (برای عملیات مخرب مثل حذف و لغو).
 * پس از تأیید، فرم با همین دکمه به‌عنوان submitter ارسال می‌شود تا formAction و name حفظ شوند.
 */
export default function ConfirmButton({ message, children, title = "تأیید عملیات", confirmLabel = "بله، انجام شود", ...rest }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const confirm = () => {
    setOpen(false);
    const btn = ref.current;
    // پس از بسته‌شدن پنجره و بازگشت فوکوس، فرم ارسال می‌شود
    queueMicrotask(() => btn?.form?.requestSubmit(btn));
  };

  return (
    <>
      <button
        {...rest}
        ref={ref}
        type="submit"
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        tone="danger"
        icon={<TriangleAlert size={22} />}
        title={title}
        description={message}
        footer={
          <>
            <button type="button" onClick={confirm} className="btn-danger">{confirmLabel}</button>
            <button type="button" data-autofocus onClick={() => setOpen(false)} className="btn-secondary">انصراف</button>
          </>
        }
      />
    </>
  );
}
