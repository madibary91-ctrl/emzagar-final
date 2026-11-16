import { afterCommit, db } from "@/db";
import { settings, workspaceSettings } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { TtlCache } from "@/lib/ttl-cache";
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
/**
 * P-11: تنظیمات تقریباً در همه‌ی جریان‌های داغ (ایمیل، پیامک، PDF، لینک امضا، برندینگ هر صفحه) خوانده می‌شود و بسیار کم‌تغییر است.
 * کش درون‌پروسه‌ای (TTL پیش‌فرض ۱۵ ثانیه، `SETTINGS_CACHE_TTL_MS`؛ ۰ = خاموش) با single-flight و ابطال فوری هنگام ذخیره.
 * فقط «ردیف‌های خامِ رمزگشایی‌شده» کش می‌شوند؛ `app_url` مؤثر (وابسته به پیکربندی/HMAC) در هر خواندن دوباره محاسبه می‌شود،
 * پس تغییر APP_URL/TRUSTED_HOSTS بدون انتظار TTL اعمال می‌شود. به فراخواننده همیشه «کپی» برمی‌گردد (تغییر آن کش را آلوده نمی‌کند).
 */
type RawSettings = Record<SettingKey, string>;
const wsCache = new TtlCache<number, RawSettings>("SETTINGS_CACHE_TTL_MS", 15_000, 2000);
const globalCache = new TtlCache<string, string>("SETTINGS_CACHE_TTL_MS", 15_000, 500);

function rawFromRows(rows: { key: string; value: string }[]): RawSettings {
  const out = { ...DEFAULTS };
  for (const r of rows) if ((SETTING_KEYS as readonly string[]).includes(r.key)) out[r.key as SettingKey] = isSecret(r.key) ? decryptSecret(r.value) : r.value;
  return out;
}
function finalize(workspaceId: number, raw: RawSettings): RawSettings {
  const out = { ...raw };
  // M-08: آدرس پایه‌ی لینک‌ها فقط وقتی «تأییدشده» است برگردانده می‌شود؛ همه‌ی مصرف‌کننده‌ها (ایمیل، پیامک، QR، PDF، ربات) خودکار پوشش داده می‌شوند
  out.app_url = effectiveAppUrl(workspaceId, out.app_url, out.app_url_proof);
  return out;
}

/** ابطال کش تنظیمات یک فضای کاری (یا همه). پس از commit هم تکرار می‌شود تا خواننده‌ی هم‌زمانِ پیش از commit مقدار کهنه را ماندگار نکند. */
export function invalidateSettingsCache(workspaceId?: number): void {
  wsCache.invalidate(workspaceId);
  globalCache.invalidate();
}

export async function getAllSettings(workspaceId: number): Promise<Record<SettingKey, string>> {
  if (!workspaceId) return { ...DEFAULTS };
  const raw = await wsCache.get(workspaceId, async () => rawFromRows(await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId))));
  return finalize(workspaceId, raw);
}

/**
 * تنظیمات چند فضای کاری با «یک» کوئری (برای زمان‌بندها). فضاهایی که در کش‌اند اصلاً به دیتابیس نمی‌روند.
 */
export async function getAllSettingsMany(workspaceIds: number[]): Promise<Map<number, Record<SettingKey, string>>> {
  const ids = [...new Set(workspaceIds.filter((x) => x > 0))];
  const raws = new Map<number, RawSettings>();
  const missing: number[] = [];
  for (const id of ids) {
    const hit = wsCache.peek(id);
    if (hit) raws.set(id, hit);
    else missing.push(id);
  }
  if (missing.length) {
    const gen = wsCache.generation();
    const rows = await db.select().from(workspaceSettings).where(inArray(workspaceSettings.workspaceId, missing));
    const byWs = new Map<number, { key: string; value: string }[]>();
    for (const r of rows) (byWs.get(r.workspaceId) ?? byWs.set(r.workspaceId, []).get(r.workspaceId)!).push(r);
    for (const id of missing) {
      const raw = rawFromRows(byWs.get(id) ?? []);
      raws.set(id, raw);
      wsCache.store(id, raw, gen);
    }
  }
  const out = new Map<number, Record<SettingKey, string>>();
  for (const id of ids) out.set(id, finalize(id, raws.get(id)!));
  return out;
}

export async function getSetting(key: SettingKey, workspaceId: number): Promise<string> {
  if (!workspaceId) return DEFAULTS[key];
  return (await getAllSettings(workspaceId))[key];
}

/** آیا «تأیید داخلی» برای این فضای کاری روشن است؟ (پیش‌فرض: خاموش) */
export async function isApprovalsEnabled(workspaceId: number): Promise<boolean> {
  return (await getSetting("approvals_enabled", workspaceId)) === "1";
}

export async function saveSettings(values: Partial<Record<SettingKey, string>>, workspaceId: number) {
  if (!workspaceId) throw new Error("فضای کاری نامعتبر است");
  try {
    await writeSettings(values, workspaceId);
  } finally {
    invalidateSettingsCache(workspaceId);
    await afterCommit(async () => invalidateSettingsCache(workspaceId));
  }
}

async function writeSettings(values: Partial<Record<SettingKey, string>>, workspaceId: number) {
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
  return globalCache.get(key, async () => {
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    return row?.value ?? "";
  });
}

export async function saveGlobalSetting(key: string, value: string) {
  try {
    await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  } finally {
    globalCache.invalidate(key);
    await afterCommit(async () => globalCache.invalidate(key));
  }
}
