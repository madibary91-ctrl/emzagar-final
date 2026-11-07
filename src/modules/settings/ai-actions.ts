"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { getAllSettings, saveSettings } from "./service";
import { logAudit } from "@/modules/audit/service";
import { assertSafeUrl } from "@/lib/ssrf";
import { PROVIDERS, isProviderId, type AiProviderId } from "@/modules/ai/providers";

export type AiSettingsState = { saved?: boolean; error?: string };

const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,80}$/;

/**
 * ذخیره‌ی تنظیمات هوش مصنوعی هر فضای کاری (انتخاب سرویس، کلید، مدل، آدرس).
 * کلید رمزنگاری‌شده ذخیره می‌شود و هرگز به مرورگر برنمی‌گردد.
 * امنیت: اگر «سرویس» عوض شود، کلید قبلی هرگز به سرویس تازه فرستاده نمی‌شود؛ باید کلید جدید وارد شود.
 */
export async function saveAiSettingsAction(_prev: AiSettingsState, formData: FormData): Promise<AiSettingsState> {
  const admin = await requireTeam("settings");
  const current = await getAllSettings(admin.workspaceId);

  const rawProvider = String(formData.get("ai_provider") || "gapgpt");
  if (!isProviderId(rawProvider)) return { error: "سرویس هوش مصنوعی نامعتبر است" };
  const provider: AiProviderId = rawProvider;
  const info = PROVIDERS[provider];
  const prevProvider: AiProviderId = isProviderId(current.ai_provider) ? current.ai_provider : current.ai_base_url.trim() ? "custom" : "gapgpt";

  let key = current.ai_api_key;
  const typed = String(formData.get("ai_api_key") || "").trim();
  if (formData.get("clear_key") === "1") key = "";
  else if (typed) {
    if (typed.length < 8 || typed.length > 400 || /\s/.test(typed)) return { error: "کلید API معتبر نیست (بدون فاصله و حداقل ۸ نویسه)" };
    key = typed;
  } else if (key && provider !== prevProvider) {
    return { error: `با تغییر سرویس به «${info.label}» باید کلید API همان سرویس را وارد کنید (کلید قبلی برای سرویس دیگری بود و ارسال نمی‌شود).` };
  }

  const model = String(formData.get("ai_model") || "").trim();
  if (model && !MODEL_RE.test(model)) return { error: "نام مدل نامعتبر است" };
  if (info.requiresBaseUrl && !model) return { error: "برای «سرویس دلخواه» نام مدل الزامی است" };

  let baseUrl = String(formData.get("ai_base_url") || "").trim().replace(/\/+$/, "");
  // آدرس پیش‌فرض خود سرویس ذخیره نمی‌شود (در به‌روزرسانی‌های بعدی خودکار اصلاح می‌شود)
  if (baseUrl === info.baseUrl) baseUrl = "";
  if (info.requiresBaseUrl && !baseUrl) return { error: "برای «سرویس دلخواه» آدرس سرویس (مثل https://api.example.com/v1) الزامی است" };
  if (baseUrl) {
    try {
      await assertSafeUrl(baseUrl);
    } catch (e) {
      return { error: `آدرس سرویس نامعتبر است: ${e instanceof Error ? e.message : ""}` };
    }
  }

  await saveSettings({ ai_provider: provider, ai_api_key: key, ai_model: model, ai_base_url: baseUrl }, admin.workspaceId);
  await logAudit({
    workspaceId: admin.workspaceId,
    userId: admin.id,
    action: "settings.ai_saved",
    detail: `${info.label} · ${key ? "کلید ثبت شد" : "بدون کلید"} · مدل: ${model || "پیش‌فرض"}`,
  });
  revalidatePath("/admin/settings");
  return { saved: true };
}
