"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MessageSquareText, TriangleAlert } from "lucide-react";
import Modal from "@/components/ui/Modal";

/**
 * جایگزین «آمرانه و Promise‑محور» برای window.confirm / window.prompt (F-11).
 *
 * چرا؟ دیالوگ بومی مرورگر: ۱) ظاهر یکدست برند و RTL ندارد، ۲) در PWA و WebView و iOS گاهی بی‌صدا مسدود می‌شود
 * (دکمه «کار نمی‌کند» به‌نظر می‌رسد)، ۳) خوانا و دسترس‌پذیر نیست، ۴) نمی‌شود متن اقدام را برجسته کرد.
 *
 * استفاده (بدون هیچ state محلی در کامپوننت):
 *   if (!(await confirmDialog({ message: "حذف شود؟", tone: "danger" }))) return;
 *   const reason = await promptDialog({ title: "دلیل ابطال", required: true }); // null = انصراف
 *
 * <DialogHost /> یک بار در layout ریشه نصب می‌شود. اگر (مثلاً در آزمون یا SSR) میزبانی نصب نباشد،
 * به دیالوگ بومی برمی‌گردیم تا هیچ مسیر حساسی بی‌تأیید اجرا نشود.
 */

export type ConfirmOptions = {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger = دکمه‌ی قرمز و آیکن هشدار (پیش‌فرض) */
  tone?: "danger" | "default";
};
export type PromptOptions = {
  title: string;
  message?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** اگر true باشد، متن خالی پذیرفته نمی‌شود */
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
};

type Req =
  | { id: number; kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: "prompt"; opts: PromptOptions; resolve: (v: string | null) => void };

// ───────────── store ماژولی (بدون Context تا از هر event handler قابل‌فراخوانی باشد) ─────────────
let queue: Req[] = [];
let seq = 0;
let hosts = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => queue;
const serverSnapshot = (): Req[] => [];

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (hosts === 0) return Promise.resolve(window.confirm(opts.message));
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { id: ++seq, kind: "confirm", opts, resolve }];
    emit();
  });
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (hosts === 0) return Promise.resolve(window.prompt(opts.message ?? opts.title, opts.defaultValue ?? ""));
  return new Promise<string | null>((resolve) => {
    queue = [...queue, { id: ++seq, kind: "prompt", opts, resolve }];
    emit();
  });
}

function settle(req: Req, value: boolean | string | null) {
  queue = queue.filter((r) => r.id !== req.id);
  emit();
  if (req.kind === "confirm") req.resolve(value === true);
  else req.resolve(typeof value === "string" ? value : null);
}

/** میزبان دیالوگ‌ها؛ هر بار فقط اولین درخواست صف نمایش داده می‌شود. */
export function DialogHost() {
  const reqs = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    hosts += 1;
    return () => {
      hosts -= 1;
      // اگر میزبان برداشته شد، درخواست‌های معلق «انصراف» حساب می‌شوند (هرگز به‌صورت تأییدشده رها نمی‌شوند)
      if (hosts === 0) {
        const pending = queue;
        queue = [];
        pending.forEach((r) => (r.kind === "confirm" ? r.resolve(false) : r.resolve(null)));
      }
    };
  }, []);
  const req = reqs[0];
  if (!req) return null;
  return req.kind === "confirm" ? <ConfirmView key={req.id} req={req} /> : <PromptView key={req.id} req={req} />;
}

function ConfirmView({ req }: { req: Extract<Req, { kind: "confirm" }> }) {
  const { opts } = req;
  const danger = (opts.tone ?? "danger") === "danger";
  return (
    <Modal
      open
      onClose={() => settle(req, false)}
      tone={danger ? "danger" : "default"}
      icon={<TriangleAlert size={22} />}
      title={opts.title ?? "تأیید عملیات"}
      description={opts.message}
      footer={
        <>
          <button type="button" onClick={() => settle(req, true)} className={danger ? "btn-danger" : "btn-primary btn-mint"}>{opts.confirmLabel ?? "بله، ادامه"}</button>
          <button type="button" data-autofocus onClick={() => settle(req, false)} className="btn-secondary">{opts.cancelLabel ?? "انصراف"}</button>
        </>
      }
    />
  );
}

function PromptView({ req }: { req: Extract<Req, { kind: "prompt" }> }) {
  const { opts } = req;
  const [value, setValue] = useState(opts.defaultValue ?? "");
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const invalid = !!opts.required && value.trim() === "";
  const submit = () => {
    if (invalid) return;
    settle(req, value.trim());
  };
  return (
    <Modal
      open
      onClose={() => settle(req, null)}
      icon={<MessageSquareText size={22} />}
      title={opts.title}
      description={opts.message}
      footer={
        <>
          <button type="button" onClick={submit} disabled={invalid} className="btn-primary btn-mint">{opts.confirmLabel ?? "تأیید"}</button>
          <button type="button" onClick={() => settle(req, null)} className="btn-secondary">انصراف</button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor="dlg-prompt" className="label">{opts.label ?? opts.title}</label>
        {opts.multiline ? (
          <textarea id="dlg-prompt" ref={ref} data-autofocus className="input min-h-24" rows={3} value={value} maxLength={opts.maxLength} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <input id="dlg-prompt" ref={ref} data-autofocus className="input" value={value} maxLength={opts.maxLength} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} />
        )}
        {/* Enter در حالت تک‌خطی فرم را ارسال کند */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
