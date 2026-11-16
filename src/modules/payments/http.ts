import { extTimeout, friendlyNetworkError } from "@/lib/external";

export type HttpCall = { status: number; json: Record<string, unknown> | null; transient: boolean; netError?: string };

/**
 * تماس JSON سرور به سرور با مهلت، بدون پیگیری ریدایرکت و با طبقه‌بندی خطا.
 * transient = «جواب قطعی نگرفتیم»: قطعی شبکه، تایم‌اوت، 5xx یا پاسخ غیر JSON.
 */
export async function postJson(url: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<HttpCall> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(extTimeout(15_000)),
      redirect: "error",
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!json || res.status >= 500) {
      return { status: res.status, json, transient: true, netError: res.status >= 500 ? `درگاه پرداخت در دسترس نیست (HTTP ${res.status})` : "پاسخ نامعتبر از درگاه" };
    }
    return { status: res.status, json, transient: false };
  } catch (e) {
    return { status: 0, json: null, transient: true, netError: friendlyNetworkError(e, "درگاه پرداخت") };
  }
}

export const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
