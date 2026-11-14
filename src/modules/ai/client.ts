import { assertSafeAiUrl, extTimeout, friendlyNetworkError, isSimulatorOrigin, simActive } from "@/lib/external";
import { safeFetch } from "@/lib/ssrf";
import { protocolOf, type AiProtocol } from "./providers";

/**
 * لایه‌ی یکپارچه‌ی تماس با سرویس‌های هوش مصنوعی.
 * بقیه‌ی برنامه (تولید قرارداد، تحلیل ریسک، …) فقط aiChat را صدا می‌زند و از پروتکل سرویس بی‌خبر است.
 * وقتی شبیه‌ساز فعال است همه‌ی تماس‌ها با پروتکل OpenAI به شبیه‌ساز می‌روند (هیچ درخواست واقعی نمی‌رود).
 */
export interface AiCallConfig {
  key: string;
  baseUrl: string;
  model: string;
  /** شناسه‌ی سرویس (اختیاری؛ ناشناخته = سازگار با OpenAI) */
  provider?: string;
}

const ANTHROPIC_VERSION = "2023-06-01";

/** آدرس سرویس AI را کاربر تنظیم می‌کند ← اتصال فقط از مسیر نگهبان SSRF (ضد DNS Rebinding)؛ شبیه‌ساز محلی مستثناست */
function aiFetch(url: string, init: RequestInit): Promise<Response> {
  let sim = false;
  try {
    sim = isSimulatorOrigin(new URL(url));
  } catch {
    /* آدرس نامعتبر را safeFetch رد می‌کند */
  }
  return sim ? fetch(url, init) : safeFetch(url, init);
}

const effectiveProtocol = (cfg: AiCallConfig): AiProtocol => (simActive() ? "openai" : protocolOf(cfg.provider));

/** خطای HTTP سرویس → پیام فارسی قابل‌فهم */
export function aiHttpError(status: number, bodyText = ""): Error {
  if (status === 401 || status === 403) return new Error("کلید API نامعتبر است یا دسترسی ندارد");
  if (status === 429) return new Error("محدودیت نرخ سرویس؛ کمی بعد تلاش کنید");
  return new Error(`خطای سرویس هوش مصنوعی (${status}) ${bodyText.slice(0, 120)}`.trim());
}

export interface AiChatInput {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** یک گفتگوی تک‌نوبتی؛ در خطا Error با پیام فارسی پرتاب می‌کند */
export async function aiChat(cfg: AiCallConfig, input: AiChatInput): Promise<{ text: string; tokens: number }> {
  await assertSafeAiUrl(cfg.baseUrl);
  const signal = AbortSignal.timeout(extTimeout(input.timeoutMs ?? 100_000));
  const temperature = input.temperature ?? 0.3;
  const max_tokens = input.maxTokens ?? 3000;

  if (effectiveProtocol(cfg) === "anthropic") {
    const res = await aiFetch(`${cfg.baseUrl}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": ANTHROPIC_VERSION },
      redirect: "error",
      signal,
      body: JSON.stringify({ model: cfg.model, max_tokens, temperature, system: input.system, messages: [{ role: "user", content: input.user }] }),
    });
    if (!res.ok) throw aiHttpError(res.status, await res.text().catch(() => ""));
    const json = (await res.json().catch(() => null)) as { content?: { type?: string; text?: unknown }[]; usage?: { input_tokens?: number; output_tokens?: number } } | null;
    if (!json || typeof json !== "object") throw new Error("پاسخ نامعتبر از سرویس هوش مصنوعی (غیر JSON)");
    const text = (json.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("\n");
    return { text: text.trim(), tokens: (Number(json.usage?.input_tokens) || 0) + (Number(json.usage?.output_tokens) || 0) };
  }

  const res = await aiFetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
    redirect: "error",
    signal,
    body: JSON.stringify({
      model: cfg.model,
      temperature,
      max_tokens,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
  });
  if (!res.ok) throw aiHttpError(res.status, await res.text().catch(() => ""));
  const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[]; usage?: { total_tokens?: number } } | null;
  if (!json || typeof json !== "object") throw new Error("پاسخ نامعتبر از سرویس هوش مصنوعی (غیر JSON)");
  const content = json.choices?.[0]?.message?.content;
  return { text: (typeof content === "string" ? content : "").trim(), tokens: Number(json.usage?.total_tokens) || 0 };
}

/** تست اتصال و دریافت فهرست مدل‌ها (برای دکمه‌ی «تست اتصال» در تنظیمات) */
export async function aiTestConnection(c: AiCallConfig): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  if (!c.key) return { ok: false, error: "کلید API وارد نشده است" };
  try {
    await assertSafeAiUrl(c.baseUrl);
    const anthropic = effectiveProtocol(c) === "anthropic";
    const headers: Record<string, string> = anthropic ? { "x-api-key": c.key, "anthropic-version": ANTHROPIC_VERSION } : { Authorization: `Bearer ${c.key}` };
    const res = await aiFetch(`${c.baseUrl}/models`, { headers, signal: AbortSignal.timeout(extTimeout(15_000)), redirect: "error" });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "کلید API نامعتبر است یا دسترسی ندارد" };
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const models = (json?.data ?? [])
        .map((m) => String(m.id || "").replace(/^models\//, ""))
        .filter(Boolean)
        .sort()
        .slice(0, 300);
      return { ok: true, models };
    }
    // برخی سرویس‌ها /models ندارند؛ یک درخواست کوچک آزمایشی می‌فرستیم
    const probe = anthropic
      ? await aiFetch(`${c.baseUrl}/messages`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: c.model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
          signal: AbortSignal.timeout(extTimeout(20_000)),
          redirect: "error",
        })
      : await aiFetch(`${c.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: c.model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
          signal: AbortSignal.timeout(extTimeout(20_000)),
          redirect: "error",
        });
    if (probe.status === 401 || probe.status === 403) return { ok: false, error: "کلید API نامعتبر است یا دسترسی ندارد" };
    if (!probe.ok) return { ok: false, error: `سرویس پاسخ ناموفق داد (${probe.status}) — آدرس یا نام مدل را بررسی کنید` };
    return { ok: true, models: [] };
  } catch (e) {
    return { ok: false, error: friendlyNetworkError(e, "سرویس هوش مصنوعی") };
  }
}
