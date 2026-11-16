import { assertSafeAiUrl, extTimeout, friendlyNetworkError, isSimulatorOrigin, simActive } from "@/lib/external";
import { safeFetch } from "@/lib/ssrf";
import { scrubSecrets } from "@/lib/scrub";
import { GUARD_NOTE, aiGuardEnabled, assertGuardPolicy, newVault, protectText, restoreTextDetailed, vaultValues } from "./guard";
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

/** پیام داخل بدنه‌ی خطای سرویس (فرمت OpenAI/Anthropic/Gemini) — فقط متن کوتاه و بی‌خطر */
export function providerMessage(bodyText: string, secrets: readonly string[] = []): string {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: unknown } | string; message?: unknown } | unknown[] | null;
    const first = Array.isArray(j) ? (j[0] as { error?: { message?: unknown } } | undefined) : j;
    const e = first && typeof first === "object" ? (first as { error?: { message?: unknown } | string; message?: unknown }) : null;
    const m = typeof e?.error === "string" ? e.error : e?.error && typeof e.error === "object" ? e.error.message : e?.message;
    return typeof m === "string" ? scrubSecrets(m, secrets, 160) : "";
  } catch {
    return "";
  }
}

/**
 * AI-02: «اعتبار/موجودی تمام شده» فقط با ۴۰۲ نیست. OpenAI با ۴۲۹ + `insufficient_quota`، برخی سرویس‌ها با ۴۰۳/۴۰۰ و Gemini با ۴۲۹ +
 * «exceeded your current quota … billing» پاسخ می‌دهند. پیش‌تر همه‌ی این‌ها «محدودیت نرخ؛ کمی بعد تلاش کنید» می‌شدند و کاربر
 * بی‌نتیجه دوباره و دوباره تلاش می‌کرد. اگر پیام صراحتاً «محدودیت نرخ در دقیقه» باشد و نشانه‌ی قوی اعتبار نباشد، همچنان نرخ است.
 */
const CREDIT_STRONG = /insufficient[\s_-]*(?:quota|funds?|balance|credits?)|exceeded your current quota|billing[\s_-]*(?:hard[\s_-]*limit|not[\s_-]*active|details|account)|credit balance|out of credits?|no (?:more )?credits?|payment[\s_-]*required|balance (?:is )?(?:too low|insufficient|exhausted)|account[\s_-]*balance|quota[\s_-]*exceeded[^"]{0,60}(?:plan|billing)/i;
const RATE_HINT = /rate[\s_-]*limit|too many requests|requests? per (?:min|sec)|per[\s_-]*(?:minute|second)|try again in|retry[\s_-]*after|tokens? per min/i;
export function isCreditExhausted(status: number, bodyText = ""): boolean {
  if (status === 402) return true;
  if (status !== 429 && status !== 403 && status !== 400) return false;
  if (!CREDIT_STRONG.test(bodyText)) return false;
  // «rate limit» صریح و بدون واژه‌ی قوی بیلینگ ⇒ نرخ (واژه‌های فارسی عمداً نیستند: ۴۰۰ ممکن است متن قرارداد کاربر را بازتاب دهد)
  return !(RATE_HINT.test(bodyText) && !/insufficient|billing|credit|balance|funds|payment/i.test(bodyText));
}

const CREDIT_MESSAGE = "اعتبار یا موجودی حساب شما در سرویس هوش مصنوعی تمام شده است؛ حساب خود را در سایت سرویس‌دهنده شارژ کنید یا سرویس دیگری انتخاب کنید";

/** وقتی سرویس همین را با ۴۲۹ می‌گوید، عبارت «محدودیت نرخ/سهمیه» همان متن وضعیت HTTP است؛ علت واقعی و راه‌حل صریح می‌آید */
const CREDIT_MESSAGE_429 = "سرویس با خطای ۴۲۹ (محدودیت نرخ/سهمیه) پاسخ داد و پیامش نشان می‌دهد اعتبار یا موجودی حساب شما تمام شده است، نه فقط شلوغی لحظه‌ای؛ حساب خود را در سایت سرویس‌دهنده شارژ کنید یا سرویس دیگری انتخاب کنید";
const creditError = (status: number) => new Error(status === 429 ? CREDIT_MESSAGE_429 : CREDIT_MESSAGE);

/** بدنه‌ی غیر-JSON/غیر-HTML کوتاه (متن ساده) را بی‌خطر نمایش می‌دهد؛ JSON ناشناخته/HTML هرگز خام نمایش داده نمی‌شود */
function plainSnippet(bodyText: string, secrets: readonly string[]): string {
  const t = bodyText.trim();
  if (!t || /^[{[<]/.test(t) || /<\/?[a-z][^>]*>/i.test(t)) return "";
  return scrubSecrets(t, secrets, 120);
}

/** خطای HTTP سرویس → پیام فارسی قابل‌فهم، همراه با «علت» و «راه‌حل». `secrets`: مقدارهایی که هرگز نباید در پیام بیایند (کلید، داده‌ی شخصی) */
export function aiHttpError(status: number, bodyText = "", secrets: readonly string[] = []): Error {
  if (status === 403 && isCreditExhausted(status, bodyText)) return creditError(status);
  if (status === 401 || status === 403) return new Error("کلید API نامعتبر است یا دسترسی ندارد");
  if (isCreditExhausted(status, bodyText)) return creditError(status);
  if (status === 429) return new Error("محدودیت نرخ سرویس؛ کمی بعد تلاش کنید");
  const detail = providerMessage(bodyText, secrets);
  const tail = detail ? ` — پیام سرویس: ${detail}` : "";
  if (status === 404) return new Error(`مدل یا آدرس سرویس پیدا نشد (404)؛ نام مدل را در «تنظیمات ← هوش مصنوعی» با «تست اتصال» بررسی کنید${tail}`);
  if (status === 400 || status === 422) return new Error(`سرویس درخواست را نپذیرفت (${status})؛ معمولاً نام مدل نادرست است یا مدل برای این کلید فعال نیست${tail}`);
  if (status === 413) return new Error("متن ارسالی برای سرویس خیلی بزرگ است؛ توضیحات یا متن قرارداد را کوتاه‌تر کنید");
  return new Error(`خطای سرویس هوش مصنوعی (${status}) ${detail || plainSnippet(bodyText, secrets)}`.trim());
}

/** بدنه‌ی خطا را با سقف حجم می‌خواند (سرویس خراب/مخرب نتواند حافظه یا زمان بخورد) */
async function readCapped(res: Response, max = 16_384): Promise<string> {
  try {
    if (!res.body) return (await res.text()).slice(0, max);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let out = "";
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => undefined);
    return out.slice(0, max);
  } catch {
    return "";
  }
}

/** AI-04: مهلت «کل» عملیات؛ هر مرحله‌ی بی‌پشتوانه‌ی AbortSignal (DNS، پاک‌سازی، …) هم به آن مقید می‌شود */
function raceDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface AiChatInput {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** false = بدون نشانگرسازی داده‌ی حساس (فقط برای متن‌هایی که از پیش بی‌داده‌ی شخصی‌اند، مثل پروب سلامت) */
  redact?: boolean;
}

/** یک گفتگوی تک‌نوبتی؛ در خطا Error با پیام فارسی پرتاب می‌کند */
export async function aiChat(
  cfg: AiCallConfig,
  input: AiChatInput,
): Promise<{
  text: string;
  tokens: number;
  /** تعداد داده‌ی حساس نشانگرسازی‌شده (فقط وقتی > 0) */
  redactions?: number;
  /** مدل به سقف طول خروجی خورد و پاسخ «نیمه‌کاره» است (finish_reason=length / stop_reason=max_tokens) */
  truncated?: boolean;
  /** نشانگرهایی که مدل در خروجی نیاورد (داده‌ی حساس گم‌شده در متن بازنویسی‌شده) */
  lostMarkers?: number;
}> {
  // AI-04: مهلت «کل» از همین لحظه (شامل بررسی SSRF/DNS) آغاز می‌شود، نه فقط از لحظه‌ی fetch
  const signal = AbortSignal.timeout(extTimeout(input.timeoutMs ?? 100_000));
  // AI-06: سپر حریم خصوصی در production نباید بی‌صدا خاموش بماند
  const guard = aiGuardEnabled() && input.redact !== false;
  if (input.redact !== false) assertGuardPolicy();
  await raceDeadline(assertSafeAiUrl(cfg.baseUrl), signal);
  // D-06: داده‌ی حساس پیش از خروج از سرور نشانگرسازی می‌شود و در پاسخ برمی‌گردد (نگاه کنید به guard.ts)
  const vault = newVault();
  const sysText = guard ? protectText(input.system, vault) : input.system;
  const userText = guard ? protectText(input.user, vault) : input.user;
  const system = vault.n > 0 ? sysText + GUARD_NOTE : sysText;
  const user = userText;
  // رازها و مقدارهای واقعیِ داده‌ی شخصی هرگز در پیام خطا نمی‌آیند (AI-01)
  const secrets = [cfg.key, ...vaultValues(vault)];
  const back = (t: string) => {
    if (vault.n === 0) return { text: t, lost: 0 };
    const r = restoreTextDetailed(t, vault);
    return { text: r.text, lost: vault.map.size - r.restored.size };
  };
  const temperature = input.temperature ?? 0.3;
  const max_tokens = input.maxTokens ?? 3000;
  const extra = () => ({ ...(vault.n > 0 ? { redactions: vault.n } : {}) });

  try {
    if (effectiveProtocol(cfg) === "anthropic") {
      const res = await aiFetch(`${cfg.baseUrl}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": ANTHROPIC_VERSION },
        redirect: "error",
        signal,
        body: JSON.stringify({ model: cfg.model, max_tokens, temperature, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) throw aiHttpError(res.status, await readCapped(res), secrets);
      const json = (await raceDeadline(res.json().catch(() => null), signal)) as { content?: { type?: string; text?: unknown }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } } | null;
      if (!json || typeof json !== "object") throw new Error("پاسخ نامعتبر از سرویس هوش مصنوعی (غیر JSON)");
      const text = (json.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => String(b.text)).join("\n");
      const r = back(text.trim());
      return { text: r.text, tokens: (Number(json.usage?.input_tokens) || 0) + (Number(json.usage?.output_tokens) || 0), ...(json.stop_reason === "max_tokens" ? { truncated: true } : {}), ...(r.lost > 0 ? { lostMarkers: r.lost } : {}), ...extra() };
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
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw aiHttpError(res.status, await readCapped(res), secrets);
    const json = (await raceDeadline(res.json().catch(() => null), signal)) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { total_tokens?: number } } | null;
    if (!json || typeof json !== "object") throw new Error("پاسخ نامعتبر از سرویس هوش مصنوعی (غیر JSON)");
    const content = json.choices?.[0]?.message?.content;
    const r = back((typeof content === "string" ? content : "").trim());
    return { text: r.text, tokens: Number(json.usage?.total_tokens) || 0, ...(json.choices?.[0]?.finish_reason === "length" ? { truncated: true } : {}), ...(r.lost > 0 ? { lostMarkers: r.lost } : {}), ...extra() };
  } catch (e) {
    // هر خطای دیگر (شبکه، پارس، …) هم پیش از رسیدن به کاربر/دیتابیس از رازها پاک می‌شود
    throw sanitizeError(e, secrets);
  }
}

/** همان خطا با پیام پاک‌شده (نام/علت‌های شبکه‌ای مثل TimeoutError برای friendlyNetworkError حفظ می‌شوند) */
function sanitizeError(e: unknown, secrets: readonly string[]): unknown {
  if (!(e instanceof Error)) return new Error(scrubSecrets(String(e), secrets));
  const clean = scrubSecrets(e.message, secrets, 400);
  if (clean === e.message) return e;
  const out = new Error(clean, { cause: (e as { cause?: unknown }).cause });
  out.name = e.name;
  return out;
}

/** تست اتصال و دریافت فهرست مدل‌ها (برای دکمه‌ی «تست اتصال» در تنظیمات) */
export async function aiTestConnection(c: AiCallConfig): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  if (!c.key) return { ok: false, error: "کلید API وارد نشده است" };
  // AI-04: دو درخواست پشت‌سرهم (models سپس probe) قبلاً تا ۳۵ ثانیه می‌شد؛ اکنون یک مهلت کل مشترک
  const signal = AbortSignal.timeout(extTimeout(25_000));
  try {
    await raceDeadline(assertSafeAiUrl(c.baseUrl), signal);
    const anthropic = effectiveProtocol(c) === "anthropic";
    const headers: Record<string, string> = anthropic ? { "x-api-key": c.key, "anthropic-version": ANTHROPIC_VERSION } : { Authorization: `Bearer ${c.key}` };
    const res = await aiFetch(`${c.baseUrl}/models`, { headers, signal, redirect: "error" });
    if (res.status === 401 || res.status === 403) {
      const body = res.status === 403 ? await readCapped(res) : "";
      return { ok: false, error: isCreditExhausted(res.status, body) ? CREDIT_MESSAGE : "کلید API نامعتبر است یا دسترسی ندارد" };
    }
    if (res.ok) {
      const json = (await raceDeadline(res.json().catch(() => null), signal)) as { data?: { id?: string }[] } | null;
      const models = (json?.data ?? [])
        .map((m) => String(m.id || "").replace(/^models\//, ""))
        .filter(Boolean)
        .sort()
        .slice(0, 300);
      return { ok: true, models };
    }
    res.body?.cancel().catch(() => undefined);
    // برخی سرویس‌ها /models ندارند؛ یک درخواست کوچک آزمایشی می‌فرستیم
    const probe = anthropic
      ? await aiFetch(`${c.baseUrl}/messages`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: c.model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
          signal,
          redirect: "error",
        })
      : await aiFetch(`${c.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model: c.model, max_tokens: 5, messages: [{ role: "user", content: "ping" }] }),
          signal,
          redirect: "error",
        });
    if (probe.status === 401 || probe.status === 403) {
      const body = probe.status === 403 ? await readCapped(probe) : "";
      return { ok: false, error: isCreditExhausted(probe.status, body) ? CREDIT_MESSAGE : "کلید API نامعتبر است یا دسترسی ندارد" };
    }
    if (!probe.ok) {
      const body = await readCapped(probe);
      const hint = isCreditExhausted(probe.status, body) ? "اعتبار یا موجودی حساب سرویس تمام شده است؛ حساب را شارژ کنید" : "آدرس یا نام مدل را بررسی کنید";
      return { ok: false, error: `سرویس پاسخ ناموفق داد (${probe.status}) — ${hint}` };
    }
    probe.body?.cancel().catch(() => undefined);
    return { ok: true, models: [] };
  } catch (e) {
    return { ok: false, error: scrubSecrets(friendlyNetworkError(e, "سرویس هوش مصنوعی"), [c.key]) };
  }
}
