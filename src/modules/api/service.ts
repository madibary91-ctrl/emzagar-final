import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { resolveTrustedOrigin } from "@/lib/origin";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { clientIpFrom } from "@/lib/request";
import { ipAllowed } from "./ip-allowlist";
import { type ApiScope, parseScopes, requiredScope } from "./scopes";

export function generateKey(): { plain: string; prefix: string; hash: string } {
  const plain = `emz_${crypto.randomBytes(24).toString("hex")}`;
  return { plain, prefix: plain.slice(0, 10), hash: sha256(plain) };
}

const LIMIT = 60; // درخواست در دقیقه برای هر کلید
/** ثبت زمان آخرین استفاده حداکثر هر ۵ دقیقه (قبلاً هر درخواست یک UPDATE می‌زد) */
const LAST_USED_GRANULARITY_MS = 5 * 60_000;

export type ApiAuth = { ok: true; keyId: number; workspaceId: number; scopes: ApiScope[] };
export type ApiAuthFail = { ok: false; status: number; error: string };

/**
 * احراز هویت و «اجازه‌ی» کلید API از هدر Authorization: Bearer …
 *
 * M-05: علاوه بر شناسایی کلید، این‌ها هم اعمال می‌شوند:
 *  • انقضا (`expires_at`)؛ • فهرست مجاز IP/CIDR (`allowed_ips`)؛
 *  • دامنه‌ی دسترسی (scope) — از «مسیر + متد» استخراج می‌شود (scopes.ts) و مسیر ناشناخته رد می‌شود؛
 *    `opts.scope` فقط برای override صریح یک مسیر خاص است؛
 *  • محدودیت نرخ «پایدار» (M-04) به‌ازای هر کلید، و محدودیت جدا برای حدس کلیدهای نامعتبر به‌ازای IP.
 */
export async function authenticateApi(req: Request, opts: { bucket?: string; limit?: number; scope?: ApiScope } = {}): Promise<ApiAuth | ApiAuthFail> {
  const ip = clientIpFrom((n) => req.headers.get(n));
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const invalid = async (): Promise<ApiAuthFail> => {
    // حدس کلید: سقف جدا به‌ازای IP (فقط درخواست‌های نامعتبر شمرده می‌شوند)
    if (!(await rateLimitDb(`api:badkey:${ip}`, 30, 60_000)).ok) return { ok: false, status: 429, error: "rate_limited" };
    return { ok: false, status: 401, error: "invalid_api_key" };
  };
  if (!/^emz_[a-f0-9]{48}$/.test(token)) return invalid();
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, sha256(token)));
  if (!key || !key.active || !key.workspaceId) return invalid();
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return { ok: false, status: 401, error: "api_key_expired" };
  if (!ipAllowed(key.allowedIps, ip)) return { ok: false, status: 403, error: "ip_not_allowed" };

  let pathname = "";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    /* req.url نامعتبر → scope تعیین نمی‌شود → رد */
  }
  const need = opts.scope ?? requiredScope(req.method, pathname);
  const granted = parseScopes(key.scopes);
  if (!need || !granted.has(need)) return { ok: false, status: 403, error: "insufficient_scope" };

  // مسیرهای همگام‌سازی سطل و سقف جداگانه دارند تا فعالیت سفارش‌ها API معمولی را مسدود نکند
  const rl = await rateLimitDb(`${opts.bucket ?? "api"}:${key.id}`, opts.limit ?? LIMIT, 60_000);
  if (!rl.ok) return { ok: false, status: 429, error: "rate_limited" };

  const stale = !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS || key.lastUsedIp !== ip;
  if (stale) await db.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: ip.slice(0, 64) }).where(eq(apiKeys.id, key.id));
  return { ok: true, keyId: key.id, workspaceId: key.workspaceId, scopes: [...granted] };
}

/** آدرس پایه‌ی مورد اعتماد برای ساخت لینک مطلق؛ هدرهای Host/X-Forwarded-Host بدون اعتماد هرگز استفاده نمی‌شوند (lib/origin.ts) */
export function requestOrigin(req: Request): string {
  return resolveTrustedOrigin((n) => req.headers.get(n));
}
