"use client";

import { safeCall, safeCallWith } from "@/lib/safe-call";
import { useActionState, useState } from "react";
import { LoaderCircle, Mail } from "lucide-react";
import { saveSettingsAction, sendTestEmailAction, type SettingsState, type TestEmailState } from "@/modules/settings/actions";

type S = Record<string, string>;
const PROVIDERS = [
  { id: "log", label: "حالت آزمایشی (فقط ثبت در لاگ)" },
  { id: "kavenegar", label: "کاوه‌نگار" },
  { id: "melipayamak", label: "ملی پیامک" },
];

function Field({ name, label, s, d, type = "text", secret }: { name: string; label: string; s: S; d?: S; type?: string; secret?: boolean }) {
  return (
    <div>
      <label htmlFor={`settings-${name}`} className="label">{label}</label>
      <input
        id={`settings-${name}`}
        name={name}
        type={secret ? "password" : type}
        defaultValue={d && name in d ? d[name] : secret ? "" : s[name]}
        placeholder={secret && s[name] && !(d && d[name]) ? "•••••• (برای حفظ مقدار فعلی خالی بگذارید)" : ""}
        dir="ltr"
        className="input"
        autoComplete="off"
      />
    </div>
  );
}

/** ارسال ایمیل آزمایشی با تنظیمات ذخیره‌شده */
function TestEmail() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TestEmailState | null>(null);
  async function run() {
    setBusy(true);
    setRes(null);
    try {
      setRes(await safeCallWith(() => sendTestEmailAction(), (message) => ({ level: "error", message } as TestEmailState)));
    } catch {
      setRes({ level: "error", message: "ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید." });
    } finally {
      setBusy(false);
    }
  }
  const tone = res?.level === "success" ? "bg-emerald-50 text-emerald-800" : res?.level === "warn" ? "bg-amber-50 text-amber-800" : "bg-rose-50 text-rose-700";
  return (
    <div className="space-y-2 sm:col-span-2">
      <button type="button" onClick={run} disabled={busy} className="btn-secondary btn-sm" data-testid="smtp-test">
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Mail size={14} />}ارسال ایمیل آزمایشی به خودم
      </button>
      <span className="mr-2 text-[11px] text-stone-600">با تنظیمات «ذخیره‌شده» آزمایش می‌شود؛ ابتدا تغییرات را ذخیره کنید.</span>
      {res?.message && <p role="status" data-testid="smtp-test-result" className={`rounded-xl p-3 text-xs ${tone}`}>{res.message}</p>}
    </div>
  );
}

export default function SettingsForm({ settings }: { settings: S }) {
  // React 19 فرم‌های ناکنترل‌شده را بعد از هر اکشن «بازنشانی» می‌کند؛ بدون این، با هر خطای اعتبارسنجی همه‌ی مقدارهای تایپ‌شده پاک می‌شد
  const [state, action, pending] = useActionState<SettingsState & { draft?: S }, FormData>(async (prev, fd) => {
    const draft: S = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") draft[k] = v;
    const r = await safeCall(() => saveSettingsAction(prev, fd));
    return { ...r, draft: r.saved ? undefined : draft };
  }, {});
  return (
    <form action={action} className="space-y-5">
      <section className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">عمومی</h2>
        <Field name="site_name" label="نام سایت" s={settings} d={state.draft} />
        <Field name="admin_email" label="ایمیل مدیر (دریافت نسخه نهایی)" s={settings} d={state.draft} type="email" />
        <Field name="app_url" label="آدرس سایت (برای لینک‌های ایمیل)" s={settings} d={state.draft} />
      </section>

      <section className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">پنل پیامک</h2>
        <div className="sm:col-span-2">
          <label htmlFor="settings-form-sms_provider" className="label">سرویس‌دهنده</label>
          <select id="settings-form-sms_provider" name="sms_provider" defaultValue={state.draft?.sms_provider ?? settings.sms_provider} className="input">
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <Field name="kavenegar_api_key" label="کاوه‌نگار — کلید API" s={settings} d={state.draft} secret />
        <Field name="kavenegar_template" label="کاوه‌نگار — نام قالب تایید (verify/lookup)" s={settings} d={state.draft} />
        <Field name="melipayamak_username" label="ملی پیامک — نام کاربری" s={settings} d={state.draft} />
        <Field name="melipayamak_password" label="ملی پیامک — رمز عبور" s={settings} d={state.draft} secret />
        <Field name="melipayamak_from" label="ملی پیامک — شماره فرستنده" s={settings} d={state.draft} />
      </section>

      <section className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">ایمیل (SMTP)</h2>
        <p className="text-xs text-stone-600 sm:col-span-2">اگر میزبان SMTP خالی باشد، ایمیل‌ها فقط در لاگ ثبت می‌شوند.</p>
        <Field name="smtp_host" label="میزبان SMTP" s={settings} d={state.draft} />
        <Field name="smtp_port" label="پورت" s={settings} d={state.draft} />
        <Field name="smtp_user" label="نام کاربری" s={settings} d={state.draft} />
        <Field name="smtp_pass" label="رمز عبور" s={settings} d={state.draft} secret />
        <Field name="smtp_from" label="ایمیل فرستنده" s={settings} d={state.draft} />
        <TestEmail />
      </section>

      {state.saved && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">تنظیمات ذخیره شد.</p>}
      {state.saved && !!state.warnings?.length && (
        <ul data-testid="settings-warnings" className="space-y-1 rounded-lg bg-amber-50 p-3 text-xs leading-6 text-amber-800">
          <li className="font-bold">ذخیره شد، ولی این موارد ناقص است:</li>
          {state.warnings.map((w) => <li key={w}>• {w}</li>)}
        </ul>
      )}
      {state.error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn btn-primary">{pending ? "در حال ذخیره…" : "ذخیره تنظیمات"}</button>
    </form>
  );
}
