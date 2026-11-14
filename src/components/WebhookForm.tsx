"use client";

import { useActionState, useState, useTransition } from "react";
import { Send, Trash2 } from "lucide-react";
import {
  deleteWebhookAction, saveWebhookAction, testWebhookAction, toggleWebhookAction, type WebhookState,
} from "@/modules/webhooks/actions";
import { EVENTS, PROVIDERS } from "@/modules/webhooks/meta";

export function WebhookForm() {
  const [state, action, pending] = useActionState<WebhookState, FormData>(saveWebhookAction, {});
  const [provider, setProvider] = useState("telegram");
  const meta = PROVIDERS.find((p) => p.id === provider)!;
  const generic = provider === "generic";
  return (
    <form action={action} className="card grid gap-4 sm:grid-cols-2">
      <h2 className="font-bold sm:col-span-2">افزودن مقصد جدید</h2>
      <div>
        <label htmlFor="webhook-form-provider" className="label">پیام‌رسان</label>
        <select id="webhook-form-provider" name="provider" value={provider} onChange={(e) => setProvider(e.target.value)} className="input">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="webhook-form-name" className="label">نام نمایشی</label>
        <input id="webhook-form-name" name="name" className="input" placeholder="مثلاً کانال مدیریت" required />
      </div>
      <div>
        <label htmlFor="webhook-form-target" className="label">{generic ? "آدرس وب‌هوک (HTTPS)" : "شناسه‌ی چت / کانال (chat_id)"}</label>
        <input id="webhook-form-target" name="target" dir="ltr" className="input" required autoComplete="off" />
      </div>
      <div>
        <label htmlFor="webhook-form-secret" className="label">{generic ? "کلید امضای HMAC (اختیاری)" : "توکن ربات"}</label>
        <input id="webhook-form-secret" name="secret" type="password" dir="ltr" className="input" autoComplete="off" required={!generic} />
      </div>
      {!generic && (
        <div className="sm:col-span-2">
          <label htmlFor="webhook-form-baseUrl" className="label">آدرس پروکسی API (اختیاری — برای سرورهایی که دسترسی مستقیم به تلگرام ندارند)</label>
          <input id="webhook-form-baseUrl" name="baseUrl" dir="ltr" className="input" placeholder="https://tg-proxy.example.com" />
        </div>
      )}
      <p className="text-xs text-ink/72 sm:col-span-2">{meta.hint}</p>
      <fieldset className="sm:col-span-2">
        <legend className="label">رویدادهای ارسالی (هیچ‌کدام = همه‌ی رویدادهای قرارداد؛ اعلان گفتگوی آنلاین فقط با انتخاب صریح)</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {EVENTS.filter((e) => e.id !== "test").map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-xs"><input type="checkbox" name="events" value={e.id} />{e.label}</label>
          ))}
        </div>
      </fieldset>
      {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-2">{state.error}</p>}
      {state.ok && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 sm:col-span-2">مقصد ذخیره شد. با دکمه‌ی «تست» اتصال را بررسی کنید.</p>}
      <div className="sm:col-span-2"><button disabled={pending} className="btn-primary">افزودن مقصد</button></div>
    </form>
  );
}

export function EndpointActions({ id, active }: { id: number; active: boolean }) {
  const [res, setRes] = useState<{ ok: boolean; error?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => start(async () => setRes(await testWebhookAction(id)))}>
        <Send size={13} />{pending ? "…" : "تست"}
      </button>
      <form action={toggleWebhookAction}>
        <input type="hidden" name="id" value={id} />
        <button className="btn-secondary btn-sm">{active ? "غیرفعال" : "فعال‌سازی"}</button>
      </form>
      <form action={deleteWebhookAction} onSubmit={(e) => { if (!confirm("این مقصد حذف شود؟")) e.preventDefault(); }}>
        <input type="hidden" name="id" value={id} />
        <button className="btn-danger btn-sm"><Trash2 size={13} />حذف</button>
      </form>
      {res && <span role={res.ok ? "status" : "alert"} className={`text-xs ${res.ok ? "text-emerald-700" : "text-rose-600"}`}>{res.ok ? "ارسال شد ✓" : res.error}</span>}
    </div>
  );
}
