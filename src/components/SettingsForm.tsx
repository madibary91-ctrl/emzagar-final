"use client";

import { useActionState } from "react";
import { saveSettingsAction, type SettingsState } from "@/modules/settings/actions";

type S = Record<string, string>;
const PROVIDERS = [
  { id: "log", label: "حالت آزمایشی (فقط ثبت در لاگ)" },
  { id: "kavenegar", label: "کاوه‌نگار" },
  { id: "melipayamak", label: "ملی پیامک" },
];

function Field({ name, label, s, type = "text", secret }: { name: string; label: string; s: S; type?: string; secret?: boolean }) {
  return (
    <div>
      <label htmlFor={`settings-${name}`} className="label">{label}</label>
      <input
        id={`settings-${name}`}
        name={name}
        type={secret ? "password" : type}
        defaultValue={secret ? "" : s[name]}
        placeholder={secret && s[name] ? "•••••• (برای حفظ مقدار فعلی خالی بگذارید)" : ""}
        dir="ltr"
        className="input"
        autoComplete="off"
      />
    </div>
  );
}

export default function SettingsForm({ settings }: { settings: S }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(saveSettingsAction, {});
  return (
    <form action={action} className="space-y-5">
      <section className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">عمومی</h2>
        <Field name="site_name" label="نام سایت" s={settings} />
        <Field name="admin_email" label="ایمیل مدیر (دریافت نسخه نهایی)" s={settings} type="email" />
        <Field name="app_url" label="آدرس سایت (برای لینک‌های ایمیل)" s={settings} />
      </section>

      <section className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">پنل پیامک</h2>
        <div className="sm:col-span-2">
          <label htmlFor="settings-form-sms_provider" className="label">سرویس‌دهنده</label>
          <select id="settings-form-sms_provider" name="sms_provider" defaultValue={settings.sms_provider} className="input">
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <Field name="kavenegar_api_key" label="کاوه‌نگار — کلید API" s={settings} secret />
        <Field name="kavenegar_template" label="کاوه‌نگار — نام قالب تایید (verify/lookup)" s={settings} />
        <Field name="melipayamak_username" label="ملی پیامک — نام کاربری" s={settings} />
        <Field name="melipayamak_password" label="ملی پیامک — رمز عبور" s={settings} secret />
        <Field name="melipayamak_from" label="ملی پیامک — شماره فرستنده" s={settings} />
      </section>

      <section className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">ایمیل (SMTP)</h2>
        <p className="text-xs text-stone-600 sm:col-span-2">اگر میزبان SMTP خالی باشد، ایمیل‌ها فقط در لاگ ثبت می‌شوند.</p>
        <Field name="smtp_host" label="میزبان SMTP" s={settings} />
        <Field name="smtp_port" label="پورت" s={settings} />
        <Field name="smtp_user" label="نام کاربری" s={settings} />
        <Field name="smtp_pass" label="رمز عبور" s={settings} secret />
        <Field name="smtp_from" label="ایمیل فرستنده" s={settings} />
      </section>

      {state.saved && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">تنظیمات ذخیره شد.</p>}
      {state.error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{state.error}</p>}
      <button disabled={pending} className="btn btn-primary">{pending ? "در حال ذخیره…" : "ذخیره تنظیمات"}</button>
    </form>
  );
}
