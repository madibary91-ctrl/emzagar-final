import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { sha256 } from "@/lib/password";
import { resolveTrustedOrigin } from "@/lib/origin";

export function generateKey(): { plain: string; prefix: string; hash: string } {
  const plain = `emz_${crypto.randomBytes(24).toString("hex")}`;
  return { plain, prefix: plain.slice(0, 10), hash: sha256(plain) };
}

const hits = new Map<string, { n: number; reset: number }>();
const LIMIT = 60; // درخواست در دقیقه برای هر کلید

/** احراز هویت کلید API از هدر Authorization: Bearer … ؛ شامل محدودیت نرخ */
export async function authenticateApi(req: Request, opts: { bucket?: string; limit?: number } = {}): Promise<{ ok: true; keyId: number; workspaceId: number } | { ok: false; status: number; error: string }> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!/^emz_[a-f0-9]{48}$/.test(token)) return { ok: false, status: 401, error: "invalid_api_key" };
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, sha256(token)));
  if (!key || !key.active || !key.workspaceId) return { ok: false, status: 401, error: "invalid_api_key" };

  const now = Date.now();
  // مسیرهای همگام‌سازی سطل و سقف جداگانه دارند تا فعالیت سفارش‌ها API معمولی را مسدود نکند
  const hk = `${opts.bucket ?? "api"}:${key.id}`;
  const h = hits.get(hk);
  if (!h || h.reset < now) hits.set(hk, { n: 1, reset: now + 60000 });
  else if (++h.n > (opts.limit ?? LIMIT)) return { ok: false, status: 429, error: "rate_limited" };

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  return { ok: true, keyId: key.id, workspaceId: key.workspaceId };
}

/** آدرس پایه‌ی مورد اعتماد برای ساخت لینک مطلق؛ هدرهای Host/X-Forwarded-Host بدون اعتماد هرگز استفاده نمی‌شوند (lib/origin.ts) */
export function requestOrigin(req: Request): string {
  return resolveTrustedOrigin((n) => req.headers.get(n));
}
