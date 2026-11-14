import { authenticateApi } from "@/modules/api/service";
import { errJson, okJson } from "@/modules/connect/http";
import { connectionByKey, ingestEvents, parseEvents, secretOf } from "@/modules/sync/service";
import { verifySignature } from "@/modules/sync/sign";

export const dynamic = "force-dynamic";

const MAX_BODY = 1_500_000;

/**
 * دریافت دسته‌ای رویدادهای ووکامرس (سفارش، مشتری …).
 * امنیت: کلید API (Bearer) + امضای HMAC بدنه با راز مشترک + برچسب زمان (ضد بازپخش) + شناسه‌ی یکتای هر رویداد (ایدمپوتنت).
 * پاسخ: { ok, results: [{ id, status: ok|duplicate|ignored|error }] } — افزونه فقط رویدادهای ناموفق را دوباره می‌فرستد.
 */
export async function POST(req: Request) {
  const auth = await authenticateApi(req, { bucket: "sync", limit: 240 });
  if (!auth.ok) return errJson(auth.status, auth.error);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return errJson(413, "payload_too_large");
  const conn = await connectionByKey(auth.keyId);
  if (!conn) return errJson(404, "connection_not_found");
  if (!conn.syncEnabled) return errJson(423, "sync_paused");
  const secret = secretOf(conn);
  if (!secret) return errJson(428, "handshake_required");
  const sig = verifySignature(secret, req.headers.get("x-emzagar-timestamp"), req.headers.get("x-emzagar-signature"), raw);
  if (sig !== "ok") return errJson(401, sig === "stale" ? "stale_timestamp" : "bad_signature");
  let json: unknown;
  try {
    json = JSON.parse(raw.replace(/\\u0000/gi, ""));
  } catch {
    return errJson(400, "invalid_json");
  }
  const events = parseEvents(json);
  if (!events) return errJson(422, "invalid_events");
  const results = await ingestEvents(conn, events);
  return okJson({ results, serverTime: Math.floor(Date.now() / 1000) });
}
