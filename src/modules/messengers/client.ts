import { extTimeout, externalBase, friendlyNetworkError, simActive } from "@/lib/external";
import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { MESSENGER_PROVIDERS, type MessengerProvider } from "./util";

/**
 * کلاینت Bot API (تلگرام و بله). فقط تماس سرور به سرور؛ توکن هرگز در پیام خطا یا لاگ نمی‌آید.
 */
export interface BotRef {
  provider: MessengerProvider;
  token: string;
  /** رله/پروکسی اختیاری؛ حتماً از فیلتر SSRF می‌گذرد */
  apiBase?: string;
}

export class BotApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "BotApiError";
  }
  /** کاربر ربات را مسدود کرده یا چت وجود ندارد: تکرار بی‌فایده است */
  get chatGone(): boolean {
    return this.code === 403 || (this.code === 400 && /chat not found|user is deactivated|PEER_ID_INVALID|bot was blocked/i.test(this.message));
  }
  /** خطای دکمه‌ی URL (مثلاً آدرس محلی در محیط توسعه) */
  get badButtonUrl(): boolean {
    return this.code === 400 && /BUTTON_URL_INVALID|wrong http url|inline keyboard|url/i.test(this.message);
  }
  /** تلاش دوباره سودی ندارد */
  get permanent(): boolean {
    return this.code === 400 || this.code === 401 || this.code === 403 || this.code === 404;
  }
}

const label = (p: MessengerProvider) => (p === "bale" ? "بله" : "تلگرام");

const FA_ERRORS: Record<number, string> = {
  401: "توکن ربات نامعتبر است",
  404: "توکن ربات نامعتبر است یا ربات وجود ندارد",
  409: "ربات هم‌زمان در جای دیگری (وب‌هوک یا نمونه‌ی دیگر) در حال دریافت پیام است",
  429: "سقف ارسال پیام‌رسان؛ کمی بعد دوباره تلاش می‌شود",
};

async function resolveBase(ref: BotRef): Promise<{ base: string; safe: boolean }> {
  if (simActive()) return { base: externalBase(ref.provider, ""), safe: false };
  if (ref.apiBase) {
    const u = await assertSafeUrl(ref.apiBase);
    return { base: (u.origin + u.pathname).replace(/\/+$/, ""), safe: true };
  }
  const def = MESSENGER_PROVIDERS.find((p) => p.id === ref.provider)?.apiBase ?? "https://api.telegram.org";
  return { base: def, safe: false };
}

/** پاک‌سازی توکن از هر متنی که ممکن است به کاربر برسد */
const redact = (s: string, token: string) => (token ? s.split(token).join("***") : s);

export async function callApi<T = unknown>(ref: BotRef, method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; form?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    const { base, safe } = await resolveBase(ref);
    const url = `${base}/bot${ref.token}/${method}`;
    const init: RequestInit = opts.form
      ? { method: "POST", body: opts.form }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) };
    init.signal = AbortSignal.timeout(extTimeout(opts.timeoutMs ?? 15000));
    init.redirect = "error";
    res = await (safe ? safeFetch(url, init) : fetch(url, init));
  } catch (e) {
    throw new BotApiError(redact(friendlyNetworkError(e, label(ref.provider)), ref.token), 0);
  }
  let json: { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    json = null;
  }
  if (json?.ok) return json.result as T;
  const code = Number(json?.error_code) || res.status;
  const desc = typeof json?.description === "string" ? json.description : "";
  const msg = redact(FA_ERRORS[code] && code !== 400 ? FA_ERRORS[code] : desc || `HTTP ${res.status}`, ref.token).slice(0, 200);
  throw new BotApiError(msg, code, json?.parameters?.retry_after);
}

/* ───────── انواع آپدیت ───────── */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  contact?: { phone_number?: string; user_id?: number; first_name?: string };
  forward_from?: unknown;
  forward_origin?: unknown;
  forward_date?: number;
}
export interface TgCallback {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number; type: string } };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

/* ───────── متدها ───────── */

export const getMe = (ref: BotRef) => callApi<TgUser>(ref, "getMe", {}, { timeoutMs: 10000 });
export const setWebhook = (ref: BotRef, url: string, headerSecret: string) =>
  callApi<boolean>(ref, "setWebhook", { url, secret_token: headerSecret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false }, { timeoutMs: 15000 });
export const deleteWebhook = (ref: BotRef) => callApi<boolean>(ref, "deleteWebhook", {}, { timeoutMs: 10000 });
export const getUpdates = (ref: BotRef, offset: number) => callApi<TgUpdate[]>(ref, "getUpdates", { offset, timeout: 0, limit: 50, allowed_updates: ["message", "callback_query"] }, { timeoutMs: 15000 });
export const answerCallback = (ref: BotRef, id: string, text?: string) => callApi<boolean>(ref, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) }, { timeoutMs: 8000 });
export const setMyCommands = (ref: BotRef, commands: { command: string; description: string }[]) => callApi<boolean>(ref, "setMyCommands", { commands }, { timeoutMs: 10000 });

export type ReplyMarkup = Record<string, unknown> | undefined;

export function sendMessage(ref: BotRef, chatId: string, text: string, markup?: ReplyMarkup, timeoutMs?: number) {
  return callApi<{ message_id: number }>(ref, "sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }, { timeoutMs });
}

export function sendDocument(ref: BotRef, chatId: string, file: { buffer: Buffer; filename: string; mime?: string }, caption: string, markup?: ReplyMarkup) {
  const form = new FormData();
  form.set("chat_id", chatId);
  if (caption) form.set("caption", caption.slice(0, 1000));
  if (markup) form.set("reply_markup", JSON.stringify(markup));
  form.set("document", new Blob([new Uint8Array(file.buffer)], { type: file.mime ?? "application/pdf" }), file.filename);
  return callApi<{ message_id: number }>(ref, "sendDocument", {}, { form, timeoutMs: 60000 });
}
