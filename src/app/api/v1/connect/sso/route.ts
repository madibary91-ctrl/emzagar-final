import { authenticateApi } from "@/modules/api/service";
import { cloudOrigin, errJson, failJson, okJson } from "@/modules/connect/http";
import { createSsoToken } from "@/modules/connect/service";

export const dynamic = "force-dynamic";

const TARGETS = new Set(["admin", "templates", "contracts", "settings", "new"]);

/**
 * لینک ورود یک‌بارمصرف (۹۰ ثانیه) به پنل؛ افزونه فقط وقتی مدیر وردپرس روی «باز کردن پنل» کلیک می‌کند آن را می‌گیرد.
 * اگر ورود یک‌کلیکی برای این فضای کاری مجاز نباشد، به صفحه‌ی ورود عادی هدایت می‌شود.
 */
export async function POST(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return errJson(auth.status, auth.error);
  const body = (await req.json().catch(() => ({}))) as { target?: string };
  const target = TARGETS.has(String(body?.target)) ? String(body.target) : "admin";
  const path = target === "admin" ? "/admin" : target === "new" ? "/admin/new" : `/admin/${target}`;
  const origin = cloudOrigin(req);
  try {
    const token = await createSsoToken(auth.keyId, auth.workspaceId);
    if (!token) return okJson({ sso: false, url: `${origin}/login?next=${encodeURIComponent(path)}` });
    return okJson({ sso: true, url: `${origin}/connect/sso?t=${token}&to=${target}` });
  } catch (e) {
    return failJson(e);
  }
}
