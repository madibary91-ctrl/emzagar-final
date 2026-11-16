"use client";

import { safeCall } from "@/lib/safe-call";
import { useActionState, useState, useTransition } from "react";
import { Check, Copy, Pencil, RotateCw, Send, Trash2 } from "lucide-react";
import ConfirmButton from "@/components/ConfirmButton";
import {
  deleteWebhookAction, retryAllWebhooksAction, retryDeliveryStateAction, saveWebhookAction, testWebhookAction, toggleWebhookAction, updateWebhookAction, type WebhookState,
} from "@/modules/webhooks/actions";
import { EVENTS, PROVIDERS } from "@/modules/webhooks/meta";

function CopyButton({ value, label = "کپی" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          /* مرورگر اجازه نداد: کاربر متن را دستی انتخاب می‌کند */
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? "کپی شد" : label}
    </button>
  );
}

/** کلید امضای تازه‌ساخته: فقط یک بار دیده می‌شود */
function SecretReveal({ secret }: { secret: string }) {
  return (
    <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-6 text-amber-900 sm:col-span-2" data-testid="webhook-secret-reveal">
      <b>کلید امضای HMAC شما (فقط همین یک‌بار نمایش داده می‌شود):</b>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code dir="ltr" className="select-all break-all rounded-lg bg-white px-2 py-1 font-mono text-[12px]">{secret}</code>
        <CopyButton value={secret} />
      </div>
      <p className="mt-2">آن را در سمت گیرنده (مثلاً افزونه یا سرور شما) ذخیره کنید تا امضای هر پیام را راستی‌آزمایی کند. اگر گم شد، از «ویرایش ← کلید امضای جدید» کلید تازه بسازید.</p>
    </div>
  );
}

function Feedback({ state }: { state: WebhookState }) {
  if (state.error) return <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-2">{state.error}</p>;
  if (state.ok) return <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 sm:col-span-2">{state.info ?? "ذخیره شد."}</p>;
  return null;
}

function EventsFieldset({ selected }: { selected?: string }) {
  const chosen = !selected || selected === "*" ? [] : selected.split(",");
  return (
    <fieldset className="sm:col-span-2">
      <legend className="label">رویدادهای ارسالی (هیچ‌کدام = همه‌ی رویدادهای قرارداد؛ اعلان گفتگوی آنلاین فقط با انتخاب صریح)</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {EVENTS.filter((e) => e.id !== "test").map((e) => (
          <label key={e.id} className="flex items-center gap-2 text-xs"><input type="checkbox" name="events" value={e.id} defaultChecked={chosen.includes(e.id)} />{e.label}</label>
        ))}
      </div>
    </fieldset>
  );
}

export function WebhookForm() {
  const [state, action, pending] = useActionState<WebhookState, FormData>(saveWebhookAction, {});
  const [provider, setProvider] = useState("telegram");
  const meta = PROVIDERS.find((p) => p.id === provider)!;
  const generic = provider === "generic";
  const bad = (f: string) => state.error && state.field === f;
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
        <input id="webhook-form-name" name="name" className="input" placeholder="مثلاً کانال مدیریت" required aria-invalid={bad("name") ? true : undefined} />
      </div>
      <div>
        <label htmlFor="webhook-form-target" className="label">{generic ? "آدرس وب‌هوک (HTTPS)" : "شناسه‌ی چت / کانال (chat_id)"}</label>
        <input id="webhook-form-target" name="target" dir="ltr" className="input" required autoComplete="off" aria-invalid={bad("target") ? true : undefined} placeholder={generic ? "https://example.com/wp-json/…" : "-1001234567890 یا @my_channel"} />
      </div>
      <div>
        <label htmlFor="webhook-form-secret" className="label">{generic ? "کلید امضای HMAC (اختیاری)" : "توکن ربات"}</label>
        <input id="webhook-form-secret" name="secret" type="password" dir="ltr" className="input" autoComplete="off" required={!generic} aria-invalid={bad("secret") ? true : undefined} />
        {generic && <p className="mt-1.5 text-[11px] text-ink/72">خالی بگذارید تا یک کلید قوی خودکار ساخته و یک‌بار به شما نشان داده شود (پیشنهادی). بدون کلید، امضای پیام‌ها قابل اتکا نیست.</p>}
      </div>
      {!generic && (
        <div className="sm:col-span-2">
          <label htmlFor="webhook-form-baseUrl" className="label">آدرس پروکسی API (اختیاری — برای سرورهایی که دسترسی مستقیم به تلگرام ندارند)</label>
          <input id="webhook-form-baseUrl" name="baseUrl" dir="ltr" className="input" placeholder="https://tg-proxy.example.com" aria-invalid={bad("baseUrl") ? true : undefined} />
        </div>
      )}
      <p className="text-xs text-ink/72 sm:col-span-2">{meta.hint}</p>
      <EventsFieldset />
      <Feedback state={state} />
      {state.ok && state.secret && <SecretReveal secret={state.secret} />}
      <div className="sm:col-span-2"><button disabled={pending} className="btn-primary">{pending ? "در حال ذخیره…" : "افزودن مقصد"}</button></div>
    </form>
  );
}

/** ویرایش درجا: بدون حذف مقصد، تاریخچه و صف تلاش مجدد حفظ می‌شود */
function EndpointEditor({ ep }: { ep: EndpointView }) {
  const [state, action, pending] = useActionState<WebhookState, FormData>(updateWebhookAction, {});
  const generic = ep.provider === "generic";
  return (
    <details className="w-full rounded-2xl border border-ink/[.08] bg-stone-50 p-3 open:bg-white">
      <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-bold"><Pencil size={13} />ویرایش</summary>
      <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="id" value={ep.id} />
        <div>
          <label htmlFor={`ep-name-${ep.id}`} className="label">نام نمایشی</label>
          <input id={`ep-name-${ep.id}`} name="name" className="input" defaultValue={ep.name} required />
        </div>
        <div>
          <label htmlFor={`ep-target-${ep.id}`} className="label">{generic ? "آدرس وب‌هوک" : "شناسه‌ی چت / کانال"}</label>
          <input id={`ep-target-${ep.id}`} name="target" dir="ltr" className="input" defaultValue={ep.target} required />
        </div>
        <div>
          <label htmlFor={`ep-secret-${ep.id}`} className="label">{generic ? "کلید امضای جدید (اختیاری)" : "توکن ربات جدید (خالی = بدون تغییر)"}</label>
          <input id={`ep-secret-${ep.id}`} name="secret" type="password" dir="ltr" className="input" autoComplete="off" />
        </div>
        {!generic && (
          <div>
            <label htmlFor={`ep-base-${ep.id}`} className="label">آدرس پروکسی API</label>
            <input id={`ep-base-${ep.id}`} name="baseUrl" dir="ltr" className="input" defaultValue={ep.baseUrl} />
          </div>
        )}
        {generic && <label className="flex items-center gap-2 self-end pb-3 text-xs"><input type="checkbox" name="rotateSecret" />ساخت کلید امضای جدید و نمایش آن</label>}
        <EventsFieldset selected={ep.events} />
        <Feedback state={state} />
        {state.ok && state.secret && <SecretReveal secret={state.secret} />}
        <div className="sm:col-span-2"><button disabled={pending} className="btn-primary btn-sm">{pending ? "در حال ذخیره…" : "ذخیره‌ی تغییرات"}</button></div>
      </form>
    </details>
  );
}

export type EndpointView = { id: number; name: string; provider: string; target: string; baseUrl: string; events: string; active: boolean };

export function EndpointActions({ id, active, endpoint }: { id: number; active: boolean; endpoint?: EndpointView }) {
  const [res, setRes] = useState<{ ok: boolean; error?: string; raw?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
      <button type="button" disabled={pending} className="btn-secondary btn-sm" onClick={() => start(async () => setRes(await safeCall(() => testWebhookAction(id))))}>
        <Send size={13} />{pending ? "در حال ارسال…" : "تست"}
      </button>
      <form action={toggleWebhookAction}>
        <input type="hidden" name="id" value={id} />
        <button className="btn-secondary btn-sm">{active ? "غیرفعال" : "فعال‌سازی"}</button>
      </form>
      <form action={deleteWebhookAction}>
        <input type="hidden" name="id" value={id} />
        <ConfirmButton title="حذف مقصد" message="این مقصد و تاریخچه و ارسال‌های در صف آن حذف می‌شود. اگر فقط توکن یا آدرس را اشتباه وارد کرده‌اید، به‌جای حذف از «ویرایش» استفاده کنید." confirmLabel="بله، حذف شود" className="btn-danger btn-sm"><Trash2 size={13} />حذف</ConfirmButton>
      </form>
      {res && (
        <div role={res.ok ? "status" : "alert"} className={`basis-full text-xs leading-6 ${res.ok ? "text-emerald-700" : "text-rose-700"}`}>
          {res.ok ? "پیام آزمایشی ارسال شد ✓" : res.error}
          {!res.ok && res.raw && <span dir="ltr" className="mr-2 font-mono text-[10px] text-ink/60">({res.raw})</span>}
        </div>
      )}
      {endpoint && <EndpointEditor ep={endpoint} />}
    </div>
  );
}

/** «تلاش دوباره» یک ارسال با نمایش نتیجه در همان ردیف */
export function RetryButton({ id }: { id: number }) {
  const [state, action, pending] = useActionState<WebhookState, FormData>(retryDeliveryStateAction, {});
  return (
    <form action={action} className="mr-2 inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <button disabled={pending} className="inline-flex items-center gap-1 font-bold underline"><RotateCw size={12} />{pending ? "در حال ارسال…" : "تلاش دوباره"}</button>
      {state.error && <span role="alert" className="max-w-xs text-[11px] leading-5 text-rose-700">{state.error}</span>}
      {state.ok && <span role="status" className="text-[11px] text-emerald-700">{state.info}</span>}
    </form>
  );
}

export function RetryAllButton({ count }: { count: number }) {
  const [state, action, pending] = useActionState<WebhookState, FormData>(retryAllWebhooksAction, {});
  if (count === 0 && !state.ok && !state.error) return null;
  return (
    <form action={action} className="flex flex-wrap items-center gap-3 px-5 pt-3">
      <button disabled={pending} className="btn-secondary btn-sm"><RotateCw size={13} />{pending ? "در حال ارسال…" : `تلاش دوباره‌ی همه (${count.toLocaleString("fa-IR")})`}</button>
      {state.error && <span role="alert" className="text-xs text-rose-700">{state.error}</span>}
      {state.ok && <span role="status" className="text-xs text-emerald-700">{state.info}</span>}
    </form>
  );
}
