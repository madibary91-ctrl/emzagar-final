"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { logAudit } from "@/modules/audit/service";
import { saveSettings } from "@/modules/settings/service";
import { runAutomation } from "./service";

export type AutomationState = { ok?: boolean; error?: string; message?: string };

const int = (v: FormDataEntryValue | null, min: number, max: number) => {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

export async function saveAutomationAction(_prev: AutomationState, formData: FormData): Promise<AutomationState> {
  const admin = await requireTeam("settings");
  const first = int(formData.get("reminder_first_hours"), 1, 720);
  const interval = int(formData.get("reminder_interval_hours"), 1, 720);
  const max = int(formData.get("reminder_max"), 0, 20);
  const expiry = int(formData.get("default_expiry_days"), 0, 3650);
  if (first === null || interval === null || max === null || expiry === null) return { error: "مقادیر واردشده معتبر نیستند (عدد صحیح در بازه‌ی مجاز)" };
  await saveSettings({
    reminder_enabled: formData.get("reminder_enabled") === "on" ? "1" : "0",
    reminder_sms: formData.get("reminder_sms") === "on" ? "1" : "0",
    sign_link_sms: formData.get("sign_link_sms") === "on" ? "1" : "0",
    reminder_first_hours: String(first),
    reminder_interval_hours: String(interval),
    reminder_max: String(max),
    default_expiry_days: String(expiry),
  }, admin.workspaceId);
  await logAudit({ workspaceId: admin.workspaceId, action: "settings.saved", userId: admin.id, detail: "یادآوری و انقضا" });
  revalidatePath("/admin/automation");
  return { ok: true };
}

export async function runNowAction(): Promise<AutomationState> {
  const admin = await requireTeam("settings");
  const r = await runAutomation("manual", admin.workspaceId);
  await logAudit({ workspaceId: admin.workspaceId, action: "cron.run", userId: admin.id, detail: `یادآوری: ${r.reminders} — منقضی: ${r.expired}` });
  revalidatePath("/admin/automation");
  if (r.skipped) return { error: "اجرای دیگری در حال انجام است" };
  return { ok: true, message: `${r.reminders} یادآوری ارسال و ${r.expired} قرارداد منقضی شد.` };
}
