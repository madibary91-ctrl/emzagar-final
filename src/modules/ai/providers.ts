/**
 * فهرست سرویس‌های هوش مصنوعی پشتیبانی‌شده (بدون وابستگی به سرور؛ در فرم تنظیمات هم استفاده می‌شود).
 *
 * دو «پروتکل» پشتیبانی می‌شود:
 *  - openai    : POST {base}/chat/completions  (OpenAI، Gemini، GapGPT، OpenRouter، DeepSeek، Groq، Mistral و هر سرویس سازگار)
 *  - anthropic : POST {base}/messages          (Claude — رابط بومی Anthropic)
 *
 * افزودن سرویس جدید = افزودن یک ردیف به PROVIDERS (و در صورت نیاز یک پروتکل جدید در client.ts).
 */
export type AiProtocol = "openai" | "anthropic";

export const PROVIDER_IDS = ["gapgpt", "openai", "gemini", "anthropic", "openrouter", "deepseek", "groq", "mistral", "custom"] as const;
export type AiProviderId = (typeof PROVIDER_IDS)[number];

export interface AiProviderInfo {
  id: AiProviderId;
  label: string;
  protocol: AiProtocol;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  keyHint: string;
  docsUrl: string;
  description: string;
  /** برای «سرویس دلخواه»: آدرس الزامی است */
  requiresBaseUrl?: boolean;
}

export const PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  gapgpt: {
    id: "gapgpt",
    label: "GapGPT",
    protocol: "openai",
    baseUrl: "https://api.gapgpt.app/v1",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "claude-3-5-sonnet-latest", "gemini-2.5-flash", "deepseek-chat"],
    keyHint: "sk-…",
    docsUrl: "https://gapgpt.app",
    description: "درگاه ایرانی دسترسی به مدل‌های مختلف (پیش‌فرض)",
  },
  openai: {
    id: "openai",
    label: "OpenAI (ChatGPT)",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
    keyHint: "sk-proj-…",
    docsUrl: "https://platform.openai.com/api-keys",
    description: "کلید رسمی OpenAI",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    keyHint: "AIza…",
    docsUrl: "https://aistudio.google.com/apikey",
    description: "کلید Google AI Studio (از رابط سازگار با OpenAI استفاده می‌شود)",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", "claude-3-5-haiku-latest"],
    keyHint: "sk-ant-…",
    docsUrl: "https://console.anthropic.com/settings/keys",
    description: "کلید رسمی Anthropic (رابط بومی Messages)",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    models: ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash", "deepseek/deepseek-chat"],
    keyHint: "sk-or-…",
    docsUrl: "https://openrouter.ai/keys",
    description: "یک کلید برای صدها مدل",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    keyHint: "sk-…",
    docsUrl: "https://platform.deepseek.com/api_keys",
    description: "مدل‌های اقتصادی DeepSeek",
  },
  groq: {
    id: "groq",
    label: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyHint: "gsk_…",
    docsUrl: "https://console.groq.com/keys",
    description: "پاسخ‌دهی بسیار سریع با مدل‌های متن‌باز",
  },
  mistral: {
    id: "mistral",
    label: "Mistral AI",
    protocol: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    models: ["mistral-large-latest", "mistral-small-latest"],
    keyHint: "…",
    docsUrl: "https://console.mistral.ai/api-keys",
    description: "مدل‌های اروپایی Mistral",
  },
  custom: {
    id: "custom",
    label: "سرویس دلخواه (سازگار با OpenAI)",
    protocol: "openai",
    baseUrl: "",
    defaultModel: "",
    models: [],
    keyHint: "کلید سرویس شما",
    docsUrl: "",
    description: "هر سرویسی که رابط /chat/completions استاندارد دارد (آدرس HTTPS عمومی الزامی است)",
    requiresBaseUrl: true,
  },
};

export const PROVIDER_LIST: AiProviderInfo[] = PROVIDER_IDS.map((id) => PROVIDERS[id]);

export const isProviderId = (v: unknown): v is AiProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

/** پروتکل ارتباط با سرویس (سرویس ناشناخته = سازگار با OpenAI) */
export const protocolOf = (provider: string | undefined): AiProtocol => (isProviderId(provider) ? PROVIDERS[provider].protocol : "openai");
