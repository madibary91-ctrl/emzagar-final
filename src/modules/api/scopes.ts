/**
 * M-05 — دامنه‌های دسترسی (Scope) کلید API.
 *
 * اصل «حداقل دسترسی»: هر کلید فقط همان کاری را می‌تواند انجام دهد که برایش صادر شده است.
 * نگاشت «مسیر + متد ← scope لازم» در یک جای واحد (`requiredScope`) است، نه پراکنده در ۱۹ مسیر؛
 * مسیرِ ناشناخته «رد» می‌شود (fail-closed): افزودن یک endpoint جدید بدون تعریف scope هرگز دسترسی رایگان نمی‌دهد.
 */
export const API_SCOPES = {
  "contracts:read": "خواندن وضعیت و فهرست قراردادها و دریافت PDF",
  "contracts:write": "صدور قرارداد (و دریافت لینک امضا)، یادآوری و لغو",
  "templates:read": "خواندن فهرست قالب‌ها",
  "stats:read": "خواندن آمار",
  hub: "مرکز فرماندهی وردپرس (صف اقدام، جستجو، دسترسی قرارداد)",
  sync: "همگام‌سازی ووکامرس؛ شامل دریافت راز HMAC (حساس)",
  connect: "اتصال وردپرس: وضعیت، SSO، به‌روزرسانی، قطع اتصال (حساس)",
} as const;
export type ApiScope = keyof typeof API_SCOPES;
export const ALL_SCOPES = Object.keys(API_SCOPES) as ApiScope[];
/** scopeهای حساس: هرگز پیش‌فرض نیستند و در فرم با هشدار نمایش داده می‌شوند */
export const SENSITIVE_SCOPES: ApiScope[] = ["sync", "connect"];
/** پیش‌فرض کلید جدید: فقط خواندن */
export const DEFAULT_NEW_KEY_SCOPES: ApiScope[] = ["contracts:read", "templates:read", "stats:read"];
/** اتصال خودکار وردپرس (handshake) به همه‌ی قابلیت‌های افزونه نیاز دارد */
export const WORDPRESS_CONNECTION_SCOPES: ApiScope[] = ALL_SCOPES;

export const MAX_KEY_LIFETIME_DAYS = 366;
export const DEFAULT_KEY_LIFETIME_DAYS = 365;

export function parseScopes(csv: string | null | undefined): Set<ApiScope> {
  const out = new Set<ApiScope>();
  for (const raw of String(csv ?? "").split(",")) {
    const s = raw.trim();
    if ((ALL_SCOPES as string[]).includes(s)) out.add(s as ApiScope);
  }
  return out;
}

export function serializeScopes(list: Iterable<string>): string {
  return [...parseScopes([...list].join(","))].sort().join(",");
}

/** scope لازم برای یک درخواست؛ null = مسیر/متد ناشناخته (رد می‌شود) */
export function requiredScope(method: string, pathname: string): ApiScope | null {
  const m = method.toUpperCase();
  const p = pathname.replace(/\/+$/, "");
  const safe = m === "GET" || m === "HEAD";
  if (/^\/api\/v1\/sync(\/|$)/.test(p)) return "sync";
  if (/^\/api\/v1\/connect(\/|$)/.test(p)) return "connect";
  if (/^\/api\/v1\/hub(\/|$)/.test(p)) return "hub";
  if (p === "/api/v1/stats") return safe ? "stats:read" : null;
  if (p === "/api/v1/templates") return safe ? "templates:read" : null;
  if (p === "/api/v1/contracts") return safe ? "contracts:read" : m === "POST" ? "contracts:write" : null;
  if (/^\/api\/v1\/contracts\/[^/]+$/.test(p)) return safe ? "contracts:read" : null;
  if (/^\/api\/v1\/contracts\/[^/]+\/pdf$/.test(p)) return safe ? "contracts:read" : null;
  if (/^\/api\/v1\/contracts\/[^/]+\/(cancel|remind)$/.test(p)) return m === "POST" ? "contracts:write" : null;
  return null;
}
