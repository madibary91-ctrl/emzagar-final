/**
 * U-12 / U-13 — ارسال فایل با نوار پیشرفت، سقف زمان، لغو و پیام خطای روشن.
 *
 * `fetch` هیچ رویداد پیشرفتی برای «ارسال» ندارد؛ کاربر موبایل با اینترنت ضعیف (۵ مگابایت کارت ملی) فقط یک اسپینر بی‌پایان می‌دید
 * و نمی‌دانست چیزی ارسال می‌شود یا نه. XHR هم پیشرفت می‌دهد و هم timeout/abort را تمیز مدیریت می‌کند.
 * هرگز نمی‌اندازد: همه‌ی خطاها به شکل `{ ok: false, kind, error }` برمی‌گردند.
 */
import { NET_MESSAGES, isOffline } from "@/lib/safe-call";

export type UploadFailKind = "http" | "offline" | "timeout" | "aborted" | "network";
type FailData<T> = Partial<T> & { error?: string; code?: string };
export type UploadResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; kind: UploadFailKind; error: string; data: FailData<T> };

export interface UploadOptions {
  method?: "POST" | "PUT";
  /** پیش‌فرض ۲ دقیقه */
  timeoutMs?: number;
  /** درصد ۰..۱۰۰ (یا null اگر اندازه‌ی کل نامعلوم است) */
  onProgress?: (percent: number | null) => void;
  signal?: AbortSignal;
  /** پیام پیش‌فرض اگر سرور پیام نداد */
  fallbackError?: string;
}

export const UPLOAD_TIMEOUT_MS = 120_000;

export function uploadForm<T = Record<string, unknown>>(url: string, body: FormData, opts: UploadOptions = {}): Promise<UploadResult<T>> {
  const fallback = opts.fallbackError ?? "آپلود ناموفق بود";
  return new Promise((resolve) => {
    if (isOffline()) {
      resolve({ ok: false, status: 0, kind: "offline", error: NET_MESSAGES.offline, data: {} });
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    const done = (r: UploadResult<T>) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const fail = (kind: UploadFailKind, error: string, status = 0, data: FailData<T> = {}) => done({ ok: false, status, kind, error, data });
    const onAbort = () => {
      xhr.abort();
    };
    xhr.open(opts.method ?? "POST", url);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.timeout = opts.timeoutMs ?? UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (e) => opts.onProgress?.(e.lengthComputable && e.total > 0 ? Math.min(100, Math.round((e.loaded / e.total) * 100)) : null);
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText || "{}") as Record<string, unknown>;
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) {
        opts.onProgress?.(100);
        done({ ok: true, status: xhr.status, data: data as T });
      } else {
        const msg = typeof data.error === "string" && data.error ? data.error : xhr.status === 413 ? "حجم فایل بیش از حد مجاز است" : xhr.status >= 500 ? NET_MESSAGES.server : fallback;
        fail("http", msg, xhr.status, data as FailData<T>);
      }
    };
    xhr.onerror = () => fail(isOffline() ? "offline" : "network", isOffline() ? NET_MESSAGES.offline : "ارسال فایل با خطای شبکه روبه‌رو شد؛ دوباره تلاش کنید.");
    xhr.ontimeout = () => fail("timeout", "ارسال فایل بیش از حد طول کشید (اینترنت کند است). دوباره تلاش کنید یا فایل کم‌حجم‌تری انتخاب کنید.");
    xhr.onabort = () => fail("aborted", "ارسال فایل لغو شد.");
    if (opts.signal) {
      if (opts.signal.aborted) return fail("aborted", "ارسال فایل لغو شد.");
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      xhr.send(body);
    } catch {
      fail("network", "ارسال فایل ممکن نشد؛ دوباره تلاش کنید.");
    }
  });
}
