import { authenticateApi } from "@/modules/api/service";
import { errJson, okJson } from "@/modules/connect/http";
import { connectionByKey, dispatchOutbox, pullEvents } from "@/modules/sync/service";

export const dynamic = "force-dynamic";

/**
 * Pull رویدادهای ابر → وردپرس (برای سایت‌هایی که ابر نمی‌تواند به آن‌ها Push کند).
 * بدنه: { ack?: string[] (شناسه‌ی رویدادهای پردازش‌شده), limit?: number }
 * پاسخ: { events, pending, secretAt } — secretAt جدیدتر از مقدار محلی یعنی راز چرخیده و باید دوباره دست‌داد.
 */
export async function POST(req: Request) {
  const auth = await authenticateApi(req, { bucket: "sync", limit: 240 });
  if (!auth.ok) return errJson(auth.status, auth.error);
  const conn = await connectionByKey(auth.keyId);
  if (!conn) return errJson(404, "connection_not_found");
  const body = (await req.json().catch(() => ({}))) as { ack?: unknown; limit?: unknown };
  const ack = Array.isArray(body.ack) ? body.ack.map((x) => String(x)) : [];
  // فرصت یک Push تازه پیش از Pull (اگر سایت قابل‌دسترس باشد، رویدادها همان‌جا تحویل می‌شوند)
  void dispatchOutbox(conn.id).catch(() => undefined);
  const r = await pullEvents(conn, ack, Number(body.limit) || 25);
  return okJson({ ...r, syncEnabled: conn.syncEnabled, serverTime: Math.floor(Date.now() / 1000) });
}
