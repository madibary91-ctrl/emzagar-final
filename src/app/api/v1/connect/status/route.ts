import { authenticateApi } from "@/modules/api/service";
import { cloudOrigin, errJson, failJson, okJson } from "@/modules/connect/http";
import { heartbeat } from "@/modules/connect/service";
import { workspaceName } from "@/modules/contracts/service";

export const dynamic = "force-dynamic";

/** ضربان و وضعیت اتصال؛ افزونه روزانه (و هنگام ورود مدیر به صفحه‌ی امضاگیر) فراخوانی می‌کند */
async function handle(req: Request, meta: Record<string, unknown>) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return errJson(auth.status, auth.error);
  try {
    const conn = await heartbeat(auth.keyId, {
      pluginVersion: String(meta.pluginVersion || ""),
      wpVersion: String(meta.wpVersion || ""),
      wcActive: typeof meta.wcActive === "boolean" ? meta.wcActive : undefined,
      locale: String(meta.locale || ""),
      siteName: String(meta.siteName || ""),
    });
    return okJson({
      workspace: await workspaceName(auth.workspaceId),
      managed: !!conn,
      verified: conn?.verified ?? false,
      sso: !!conn?.ownerUserId,
      panelUrl: cloudOrigin(req),
    });
  } catch (e) {
    return failJson(e);
  }
}

export const GET = (req: Request) => handle(req, {});
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return handle(req, body && typeof body === "object" ? body : {});
}
