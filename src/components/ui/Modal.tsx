"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** آیکن بالای عنوان */
  icon?: ReactNode;
  tone?: "default" | "danger";
  children?: ReactNode;
  /** دکمه‌های پایین پنجره */
  footer?: ReactNode;
  /** اگر true باشد کلیک روی پس‌زمینه و Esc پنجره را نمی‌بندد (مثلاً هنگام ارسال) */
  locked?: boolean;
};

/**
 * پنجره‌ی گفتگوی دسترس‌پذیر: پرتال، قفل اسکرول، تله‌ی فوکوس (Tab)، بستن با Esc،
 * و بازگرداندن فوکوس به عنصر قبلی. جایگزین window.confirm / window.prompt.
 */
export default function Modal({ open, onClose, title, description, icon, tone = "default", children, footer, locked }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const closeRef = useRef(onClose);
  const lockedRef = useRef(locked);
  useEffect(() => {
    closeRef.current = onClose;
    lockedRef.current = locked;
  });

  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const target = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>(FOCUSABLE) ?? el;
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (!lockedRef.current) closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const nodes = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="ui-modal-backdrop no-print fixed inset-0 z-[200] grid place-items-center overflow-y-auto bg-ink/55 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className="ui-modal-panel relative w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl outline-none"
      >
        <button type="button" onClick={onClose} disabled={locked} aria-label="بستن" className="absolute left-4 top-4 grid h-9 w-9 place-items-center rounded-xl text-ink/75 transition hover:bg-ink/[.06] hover:text-ink">
          <X size={17} />
        </button>
        {icon && (
          <span className={`mb-4 grid h-12 w-12 place-items-center rounded-2xl ${tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-mint/25 text-ink"}`}>{icon}</span>
        )}
        <h2 id={titleId} className="text-lg font-black">{title}</h2>
        {description && <p id={descId} className="mt-2 text-sm leading-7 text-ink/70">{description}</p>}
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-6 flex flex-wrap justify-start gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
