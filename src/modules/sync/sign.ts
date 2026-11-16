import crypto from "node:crypto";

/**
 * امضای HMAC-SHA256 رویدادهای همگام‌سازی (در هر دو جهت یکسان است):
 *   signature = "sha256=" + hex( HMAC(secret, `${timestamp}.${rawBody}`) )
 * timestamp ثانیه‌ی یونیکس است و در هدر X-Emzagar-Timestamp می‌آید؛ پنجره‌ی ۵ دقیقه‌ای جلوی بازپخش (Replay) را می‌گیرد.
 */
export const SIG_TOLERANCE_SEC = 5 * 60;

export function signBody(secret: string, timestamp: number | string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type SigResult = "ok" | "missing" | "stale" | "mismatch";

export function verifySignature(secret: string, timestamp: string | null, signature: string | null, body: string, nowSec = Math.floor(Date.now() / 1000)): SigResult {
  if (!secret || !timestamp || !signature) return "missing";
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > SIG_TOLERANCE_SEC) return "stale";
  const expected = Buffer.from(signBody(secret, timestamp, body));
  const given = Buffer.from(signature.trim());
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? "ok" : "mismatch";
}

export function newSyncSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function newEventId(): string {
  return `evt_${crypto.randomBytes(12).toString("hex")}`;
}
