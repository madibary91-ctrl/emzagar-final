"use client";

import { useActionState, useState, useTransition } from "react";
import { Play } from "lucide-react";
import { runNowAction, saveAutomationAction, type AutomationState } from "@/modules/automation/actions";

type S = Record<string, string>;

export default function AutomationForm({ s }: { s: S }) {
  const [state, action, pending] = useActionState<AutomationState, FormData>(saveAutomationAction, {});
  const [msg, setMsg] = useState<AutomationState>({});
  const [running, start] = useTransition();
  return (
    <div className="space-y-5">
      <form action={action} className="card grid gap-4 sm:grid-cols-2">
        <h2 className="font-bold sm:col-span-2">قوانین یادآوری خودکار</h2>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="reminder_enabled" defaultChecked={s.reminder_enabled === "1"} />
          ارسال خودکار یادآوری برای قراردادهای امضا نشده
        </label>
        <div>
          <label htmlFor="automation-form-reminder_first_hours" className="label">اولین یادآوری: چند ساعت پس از شروع نوبت امضا</label>
          <input id="automation-form-reminder_first_hours" name="reminder_first_hours" type="number" min={1} max={720} defaultValue={s.reminder_first_hours} className="input" />
        </div>
        <div>
          <label htmlFor="automation-form-reminder_interval_hours" className="label">فاصله‌ی یادآوری‌های بعدی (ساعت)</label>
          <input id="automation-form-reminder_interval_hours" name="reminder_interval_hours" type="number" min={1} max={720} defaultValue={s.reminder_interval_hours} className="input" />
        </div>
        <div>
          <label htmlFor="automation-form-reminder_max" className="label">حداکثر تعداد یادآوری برای هر نوبت (۰ = غیرفعال)</label>
          <input id="automation-form-reminder_max" name="reminder_max" type="number" min={0} max={20} defaultValue={s.reminder_max} className="input" />
        </div>
        <div>
          <label htmlFor="automation-form-default_expiry_days" className="label">مهلت پیش‌فرض امضا (روز، ۰ = بدون انقضا)</label>
          <input id="automation-form-default_expiry_days" name="default_expiry_days" type="number" min={0} max={3650} defaultValue={s.default_expiry_days} className="input" />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="reminder_sms" defaultChecked={s.reminder_sms === "1"} />
          علاوه بر ایمیل و پیام‌رسان، پیامک هم ارسال شود
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="sign_link_sms" defaultChecked={s.sign_link_sms === "1"} />
          لینک امضا (بدون نیاز به ثبت‌نام مشتری) علاوه بر ایمیل، با پیامک هم ارسال شود
        </label>
        {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-2">{state.error}</p>}
        {state.ok && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 sm:col-span-2">تنظیمات ذخیره شد.</p>}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button disabled={pending} className="btn-primary">ذخیره قوانین</button>
          <button
            type="button"
            disabled={running}
            className="btn-secondary"
            onClick={() => start(async () => setMsg(await runNowAction()))}
          >
            <Play size={15} />{running ? "در حال اجرا…" : "اجرای دستی همین الان"}
          </button>
        </div>
        {msg.message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 sm:col-span-2">{msg.message}</p>}
        {msg.error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 sm:col-span-2">{msg.error}</p>}
      </form>
    </div>
  );
}
