"use client";

import { useActionState, useEffect, useRef } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { createTicketAction, customerReplyAction, staffReplyAction, type TicketFormState } from "@/modules/tickets/actions";
import { BODY_MAX, CATEGORIES, PRIORITIES, SUBJECT_MAX } from "@/modules/tickets/meta";

const Err = ({ s }: { s: TicketFormState }) => (s.error ? <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{s.error}</p> : null);

export function NewTicketForm() {
  const [state, action, pending] = useActionState<TicketFormState, FormData>(createTicketAction, {});
  return (
    <form action={action} className="card space-y-4">
      <div>
        <label htmlFor="subject" className="label">موضوع</label>
        <input id="subject" name="subject" required minLength={4} maxLength={SUBJECT_MAX} className="input" placeholder="مثلاً: خطا در ارسال پیامک تایید" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="category" className="label">دسته‌بندی</label>
          <select id="category" name="category" className="input" defaultValue="general">
            {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="priority" className="label">اولویت</label>
          <select id="priority" name="priority" className="input" defaultValue="normal">
            {Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="body" className="label">شرح درخواست</label>
        <textarea id="body" name="body" required minLength={10} maxLength={BODY_MAX} rows={8} className="input !h-auto py-3 leading-8" placeholder="مشکل را با جزئیات بنویسید: چه کاری انجام دادید، چه نتیجه‌ای دیدید و چه انتظاری داشتید." />
      </div>
      <Err s={state} />
      <button disabled={pending} className="btn-primary">
        {pending ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}
        ثبت تیکت
      </button>
    </form>
  );
}

export function CustomerReplyForm({ ticketId, closed }: { ticketId: number; closed: boolean }) {
  const [state, action, pending] = useActionState<TicketFormState, FormData>(customerReplyAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="card space-y-3">
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor="reply" className="label">{closed ? "ارسال پیام (تیکت دوباره باز می‌شود)" : "پاسخ شما"}</label>
      <textarea id="reply" name="body" required maxLength={BODY_MAX} rows={5} className="input !h-auto py-3 leading-8" />
      <Err s={state} />
      <button disabled={pending} className="btn-primary">{pending ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}ارسال</button>
    </form>
  );
}

export function StaffReplyForm({ ticketId, status }: { ticketId: number; status: string }) {
  const [state, action, pending] = useActionState<TicketFormState, FormData>(staffReplyAction, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="card space-y-3">
      <input type="hidden" name="ticketId" value={ticketId} />
      <label htmlFor="staff-reply" className="label">پاسخ پشتیبانی</label>
      <textarea id="staff-reply" name="body" maxLength={BODY_MAX} rows={6} className="input !h-auto py-3 leading-8" />
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="internal" value="1" /> یادداشت داخلی (برای کاربر نمایش داده نمی‌شود)</label>
        <div className="flex items-center gap-2">
          <label htmlFor="new-status" className="text-xs font-bold">وضعیت پس از ارسال</label>
          <select id="new-status" name="status" defaultValue="keep" className="input !min-h-10 !w-auto">
            <option value="keep">{status === "open" ? "خودکار (در حال بررسی)" : "بدون تغییر"}</option>
            <option value="open">باز</option>
            <option value="in_progress">در حال بررسی</option>
            <option value="closed">بسته</option>
          </select>
        </div>
      </div>
      <Err s={state} />
      {state.ok && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-800">ثبت شد.</p>}
      <button disabled={pending} className="btn-primary">{pending ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}ارسال / ثبت</button>
    </form>
  );
}
