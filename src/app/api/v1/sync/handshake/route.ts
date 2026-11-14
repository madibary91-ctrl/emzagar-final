import { authenticateApi } from "@/modules/api/service";
import { errJson, okJson } from "@/modules/connect/http";
import { connectionByKey, syncHandshake } from "@/modules/sync/service";

export const dynamic = "force-dynamic";

/**
 * دست‌دادن همگام‌سازی: افزونه (با کلید API) راز مشترک HMAC و قابلیت‌های سرور را می‌گیرد.
 * بدنه‌ی اختیاری: { rotate?: boolean, capabilities?: "push,pull,orders,customers" }
 */
export async function POST(req: Request) {
  const auth = await authenticateApi(req, { bucket: "sync", limit: 120 });
  if (!auth.ok) return errJson(auth.status, auth.error);
  const body = (await req.json().catch(() => ({}))) as { rotate?: boolean; capabilities?: string };
  const conn = await connectionByKey(auth.keyId);
  if (!conn) return errJson(404, "connection_not_found");
  const r = await syncHandshake(conn, { rotate: body.rotate === true, capabilities: String(body.capabilities ?? "") });
  return okJson({
    secret: r.secret,
    secretAt: r.secretAt,
    syncEnabled: conn.syncEnabled,
    serverTime: Math.floor(Date.now() / 1000),
    limits: { maxBatch: 50, signatureToleranceSec: 300 },
    protocol: 2,
  });
}
