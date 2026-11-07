import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { connectionByKey } from "@/modules/sync/service";
import { cloudOrigin } from "@/modules/connect/http";
import { getPulse, saveFeatures } from "@/modules/hub/service";

export const dynamic = "force-dynamic";

/**
 * نبض کسب‌وکار برای «مرکز فرماندهی» وردپرس (ویجت پیشخوان، نوار مدیریت، گزارش هفتگی).
 * POST اختیاری: افزونه میزان ادغام خود را گزارش می‌دهد { features: {...} } تا «عمق یکپارچگی» محاسبه شود.
 */
async function handle(req: Request, features: unknown) {
  const auth = await authenticateApi(req, { bucket: "hub", limit: 40 });
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const conn = await connectionByKey(auth.keyId);
  if (conn && features && typeof features === "object") await saveFeatures(conn.id, features).catch(() => undefined);
  const fresh = conn ? { ...conn, integrationJson: features && typeof features === "object" ? JSON.stringify(features) : conn.integrationJson } : { id: 0, verified: false, syncEnabled: true, integrationJson: "{}", siteHost: "" };
  const pulse = await getPulse(auth.workspaceId, fresh);
  const origin = cloudOrigin(req);
  return NextResponse.json(
    { ok: true, generatedAt: new Date().toISOString(), ...pulse, trust: { ...pulse.trust, url: origin && pulse.trust.slug ? `${origin}/trust/${pulse.trust.slug}` : "" }, panelUrl: origin },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = (req: Request) => handle(req, null);
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { features?: unknown };
  return handle(req, body?.features ?? null);
}
