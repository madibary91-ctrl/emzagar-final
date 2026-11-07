import Shell from "@/components/Shell";
import SettingsForm from "@/components/SettingsForm";
import AiSettingsForm from "@/components/AiSettingsForm";
import { requireTeam } from "@/modules/tenancy/context";
import { getAllSettings, SECRET_SETTING_KEYS } from "@/modules/settings/service";
import { getAiConfig, usageToday } from "@/modules/ai/service";
import { maskSecret } from "@/lib/crypto";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const admin = await requireTeam("settings");
  const settings = await getAllSettings(admin.workspaceId);
  const ai = await getAiConfig(admin.workspaceId);
  const usage = await usageToday(admin.workspaceId);
  // رمزها هرگز به مرورگر ارسال نمی‌شوند؛ فقط وجود/عدم وجود آن‌ها مشخص می‌شود
  const safe: Record<string, string> = { ...settings };
  for (const k of SECRET_SETTING_KEYS) safe[k] = settings[k as keyof typeof settings] ? "set" : "";
  return (
    <Shell user={admin}>
      <h1 className="mb-4 text-2xl font-black">تنظیمات</h1>
      <div className="space-y-5">
        <AiSettingsForm
          hasKey={!!ai.key}
          masked={maskSecret(settings.ai_api_key)}
          source={ai.source}
          provider={ai.provider}
          model={settings.ai_model}
          baseUrl={settings.ai_base_url}
          used={usage.used}
          limit={usage.limit}
        />
        <SettingsForm settings={safe} />
      </div>
    </Shell>
  );
}
