import crypto from "node:crypto";
import { webhookEndpoints } from "@/db/schema";
import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { safeCutIndex } from "@/modules/messengers/util";
import type { WebhookProvider } from "./meta";

const API_BASES: Record<Exclude<WebhookProvider, "generic">, string> = {
  telegram: "https://api.telegram.org",
  bale: "https://tapi.bale.ai",
  rubika: "https://botapi.rubika.ir",
  eitaa: "https://eitaayar.ir",
};

export interface WebhookEvent {
  /** زمان وقوع رویداد (ISO)؛ برای تلاش مجدد ثابت می‌ماند تا امضا و محتوا یکسان بماند */
  at?: string;
  /** شناسه‌ی یکتای ارسال (برای حذف تکراری در مقصد): هدر X-Emzagar-Delivery */
  deliveryKey?: string;
  event: string;
  /** فضای کاری مقصد؛ اگر نبود از روی قرارداد تعیین می‌شود (بدون هیچ‌کدام: ارسال نمی‌شود) */
  workspaceId?: number;
  contractId?: number | null;
  /** متن فارسی آماده‌ی نمایش در پیام‌رسان */
  text: string;
  data?: Record<string, string | number | null>;
}

/** سقف متن پیام در تلگرام/بله (۴۰۹۶)؛ متن بلندتر ۴۰۰ «دائمی» می‌گرفت و رویداد برای همیشه dead می‌شد (M-10) */
const MAX_TEXT = 4000;
export const fitText = (t: string): string => (t.length > MAX_TEXT ? t.slice(0, safeCutIndex(t, MAX_TEXT - 1)) + "…" : t);

/**
 * پاسخ پیام‌رسان را می‌خواند. M-10: علت خطا (description) حفظ می‌شود تا «علت + راه‌حل» دقیق نشان داده شود (پیش‌تر فقط «HTTP 400»)،
 * و پاسخ ۲۰۰ که JSON نیست (صفحه‌ی HTML پروکسی/رله/کپچا) «موفق» حساب نمی‌شود.
 */
export async function readMessengerResponse(res: Response): Promise<void> {
  const raw = await res.text().catch(() => "");
  let json: { ok?: boolean; status?: string; description?: string; status_det?: string } | null = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  const desc = typeof json?.description === "string" ? json.description.replace(/\s+/g, " ").slice(0, 150) : "";
  if (!res.ok) throw new Error(`HTTP ${res.status}${desc ? `: ${desc}` : ""}`);
  if (!json && /html/i.test(res.headers.get("content-type") || raw.slice(0, 20))) throw new Error("پاسخ نامعتبر از مقصد (صفحه‌ی HTML به‌جای پاسخ API؛ آدرس پروکسی/رله را بررسی کنید)");
  // پیام‌رسان‌ها گاهی با کد 200 و ok=false پاسخ می‌دهند
  if (json && (json.ok === false || json.status === "INVALID_INPUT" || json.status === "INVALID_ACCESS")) {
    throw new Error(desc || json.status || "پاسخ ناموفق");
  }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  await readMessengerResponse(res);
}

export type Endpoint = typeof webhookEndpoints.$inferSelect;

export async function deliver(ep: Endpoint, ev: WebhookEvent, attempt = 1) {
  if (ep.provider === "generic") {
    const url = await assertSafeUrl(ep.target);
    const payload = JSON.stringify({ event: ev.event, contractId: ev.contractId ?? null, text: ev.text, data: ev.data ?? {}, at: ev.at ?? new Date().toISOString() });
    const sig = crypto.createHmac("sha256", ep.secret || "").update(payload).digest("hex");
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Emzagar-Event": ev.event, "X-Emzagar-Signature": `sha256=${sig}`, ...(ev.deliveryKey ? { "X-Emzagar-Delivery": ev.deliveryKey, "X-Emzagar-Attempt": String(attempt) } : {}) },
      body: payload,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return;
  }
  const provider = ep.provider as Exclude<WebhookProvider, "generic">;
  const base = ep.baseUrl ? (await assertSafeUrl(ep.baseUrl)).origin : API_BASES[provider];
  const token = encodeURIComponent(ep.secret);
  if (provider === "eitaa") {
    // ایتایار: ارسال یک‌طرفه به کانال/گروه (فرم‌دیتا)؛ ایتا وب‌هوک و دکمه‌ی تعاملی ندارد
    const res = await safeFetch(`${base}/api/${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ chat_id: ep.target, text: fitText(ev.text) }).toString(),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    await readMessengerResponse(res);
    return;
  }
  const url = provider === "rubika" ? `${base}/v3/${token}/sendMessage` : `${base}/bot${token}/sendMessage`;
  await post(url, { chat_id: ep.target, text: fitText(ev.text) });
}


/**
 * آیا شکست ارسال «دائمی» است (تلاش مجدد بی‌فایده)؟ خطاهای 4xx به‌جز 408/425/429 یعنی مقصد درخواست را اساساً نمی‌پذیرد
 * (توکن/آدرس/دسترسی اشتباه). 404 برای وب‌هوک عمومی موقتی حساب می‌شود (سایت وردپرس هنگام استقرار/بروزرسانی).
 * قطعی شبکه، تایم‌اوت، 5xx و هر خطای ناشناخته «موقت» است و دوباره تلاش می‌شود.
 */
export function isPermanentFailure(error: string, provider: string): boolean {
  const m = /^HTTP (\d{3})/.exec(error);
  if (!m) return false;
  const code = Number(m[1]);
  if (code === 404) return provider !== "generic";
  return code >= 400 && code < 500 && ![408, 425, 429].includes(code);
}

/** فاصله‌ی تلاش‌های مجدد (پس از تلاش n ام): ۱ دقیقه، ۵ دقیقه، ۳۰ دقیقه، ۲ ساعت، ۶ ساعت ⇒ در مجموع ۶ تلاش در حدود ۸٫۶ ساعت */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
