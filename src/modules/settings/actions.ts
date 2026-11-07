"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { SETTING_KEYS, SECRET_SETTING_KEYS, saveSettings, getAllSettings, type SettingKey } from "./service";
import { logAudit } from "@/modules/audit/service";
import { assertPublicHost } from "@/lib/ssrf";

const PROTECTED_KEYS: SettingKey[] = ["brand_logo_file", "brand_logo_v"];

export type SettingsState = { saved?: boolean; error?: string };

export async function saveSettingsAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const admin = await requireTeam("settings");
  const current = await getAllSettings(admin.workspaceId);
  const values: Partial<Record<SettingKey, string>> = {};
  for (const key of SETTING_KEYS) {
    if (!formData.has(key)) continue;
    if ((PROTECTED_KEYS as string[]).includes(key)) continue;
    const v = String(formData.get(key) ?? "").trim();
    // فیلدهای محرمانه: اگر خالی ارسال شد مقدار قبلی حفظ شود
    if (SECRET_SETTING_KEYS.includes(key) && v === "") {
      values[key] = current[key];
    } else {
      values[key] = v;
    }
  }
  if (values.app_url) {
    try {
      const u = new URL(values.app_url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      values.app_url = u.origin;
    } catch {
      return { error: "آدرس سایت نامعتبر است (مثال: https://sign.example.com)" };
    }
  }
  // جلوگیری از اسکن شبکه‌ی داخلی از طریق میزبان SMTP دلخواه
  if (values.smtp_host) {
    try {
      await assertPublicHost(values.smtp_host);
    } catch (e) {
      return { error: `میزبان SMTP نامعتبر است: ${e instanceof Error ? e.message : ""}` };
    }
  }
  await saveSettings(values, admin.workspaceId);
  await logAudit({ workspaceId: admin.workspaceId, action: "settings.saved", userId: admin.id });
  revalidatePath("/admin/settings");
  return { saved: true };
}
