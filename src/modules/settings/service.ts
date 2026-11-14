import { db } from "@/db";
import { settings, workspaceSettings } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { effectiveAppUrl } from "./app-url";

export const SETTING_KEYS = [
  "site_name",
  "admin_email",
  "sms_provider", // log | kavenegar | melipayamak
  "kavenegar_api_key",
  "kavenegar_template",
  "melipayamak_username",
  "melipayamak_password",
  "melipayamak_from",
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_pass",
  "smtp_from",
  "app_url",
  "app_url_proof", // M-08: گواهی HMAC تأیید مالکیت دامنه (فقط سرور می‌نویسد)
  // یادآوری و انقضا
  "reminder_enabled",
  "reminder_first_hours",
  "reminder_interval_hours",
  "reminder_max",
  "reminder_sms",
  "sign_link_sms", // ارسال لینک امضا از طریق پیامک (علاوه بر ایمیل)
  "default_expiry_days",
  // گردش کار تأیید داخلی پیش از انتشار (پیش‌فرض خاموش؛ برای کاربران تنها مزاحم است)
  "approvals_enabled", // "1" | "0"
  // برندینگ
  "brand_primary",
  "brand_accent",
  "brand_theme", // light | dark | system
  "brand_logo_file",
  "brand_logo_v",
  "brand_tagline",
  // هوش مصنوعی (GapGPT یا هر سرویس سازگار با OpenAI)
  "ai_provider", // gapgpt | openai | gemini | anthropic | openrouter | deepseek | groq | mistral | custom
  "ai_api_key",
  "ai_base_url",
  "ai_model",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const DEFAULTS: Record<SettingKey, string> = {
  site_name: "امضاگیر",
  admin_email: "admin@example.com",
  sms_provider: "log",
  kavenegar_api_key: "",
  kavenegar_template: "verify",
  melipayamak_username: "",
  melipayamak_password: "",
  melipayamak_from: "",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_pass: "",
  smtp_from: "",
  app_url: "",
  app_url_proof: "",
  reminder_enabled: "1",
  reminder_first_hours: "24",
  reminder_interval_hours: "48",
  reminder_max: "3",
  reminder_sms: "1",
  sign_link_sms: "1",
  default_expiry_days: "30",
  approvals_enabled: "0",
  brand_primary: "#102c31",
  brand_accent: "#41e4ad",
  brand_theme: "light",
  brand_logo_file: "",
  brand_logo_v: "",
  brand_tagline: "",
  ai_provider: "",
  ai_api_key: "",
  ai_base_url: "",
  ai_model: "",
};

/** کلیدهای محرمانه: هرگز به مرورگر ارسال نمی‌شوند */
export const SECRET_SETTING_KEYS: SettingKey[] = ["kavenegar_api_key", "melipayamak_password", "smtp_pass", "ai_api_key"];
const isSecret = (k: string) => (SECRET_SETTING_KEYS as string[]).includes(k);

/**
 * تنظیمات به‌ازای هر فضای کاری ذخیره می‌شود (workspace_settings).
 * workspaceId = 0 یعنی «پیش‌فرض سیستم» (برای صفحه‌های عمومی بدون فضای کاری).
 * جدول settings قدیمی فقط برای تنظیمات سراسری پلتفرم (مثل cron_secret) نگه داشته شده است.
 */
export async function getAllSettings(workspaceId: number): Promise<Record<SettingKey, string>> {
  const out = { ...DEFAULTS };
  if (!workspaceId) return out;
  const rows = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
  for (const r of rows) if ((SETTING_KEYS as readonly string[]).includes(r.key)) out[r.key as SettingKey] = isSecret(r.key) ? decryptSecret(r.value) : r.value;
  // M-08: آدرس پایه‌ی لینک‌ها فقط وقتی «تأییدشده» است برگردانده می‌شود؛ همه‌ی مصرف‌کننده‌ها (ایمیل، پیامک، QR، PDF، ربات) خودکار پوشش داده می‌شوند
  out.app_url = effectiveAppUrl(workspaceId, out.app_url, out.app_url_proof);
  return out;
}

export async function getSetting(key: SettingKey, workspaceId: number): Promise<string> {
  if (!workspaceId) return DEFAULTS[key];
  if (key === "app_url") return (await getAllSettings(workspaceId)).app_url;
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(and(eq(workspaceSettings.workspaceId, workspaceId), eq(workspaceSettings.key, key)));
  return row ? (isSecret(key) ? decryptSecret(row.value) : row.value) : DEFAULTS[key];
}

/** آیا «تأیید داخلی» برای این فضای کاری روشن است؟ (پیش‌فرض: خاموش) */
export async function isApprovalsEnabled(workspaceId: number): Promise<boolean> {
  return (await getSetting("approvals_enabled", workspaceId)) === "1";
}

export async function saveSettings(values: Partial<Record<SettingKey, string>>, workspaceId: number) {
  if (!workspaceId) throw new Error("فضای کاری نامعتبر است");
  for (const [key, value] of Object.entries(values)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) continue;
    // کلیدهای محرمانه رمزنگاری‌شده (AES-256-GCM) ذخیره می‌شوند
    const stored = isSecret(key) ? encryptSecret(value ?? "") : (value ?? "");
    await db
      .insert(workspaceSettings)
      .values({ workspaceId, key, value: stored })
      .onConflictDoUpdate({ target: [workspaceSettings.workspaceId, workspaceSettings.key], set: { value: stored } });
  }
}

/* ───────── تنظیمات سراسری پلتفرم (مثل کلید کرون) ───────── */
export async function getGlobalSetting(key: string): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row?.value ?? "";
}

export async function saveGlobalSetting(key: string, value: string) {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}
