import { NextResponse } from "next/server";
import { getOrigin } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { getPlatformAdminForApi } from "@/modules/platform/admin";
import type { SessionUser } from "@/modules/auth/session";
import { getTeamContext } from "@/modules/tenancy/context";
import type { CheckContext } from "./types";

export const noStore = { "Cache-Control": "no-store" };
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

/** درخواست‌های تغییردهنده باید هم‌مبدأ و JSON باشند (دفاع در برابر CSRF) */
function sameOriginJson(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return (req.headers.get("content-type") || "").includes("application/json");
}

export type AdminGuard = { ok: true; user: SessionUser; ctx: CheckContext; workspaceName: string } | { ok: false; res: NextResponse };

/** فقط مدیر کل پلتفرم؛ فضای کاری فعال او تعیین‌کننده‌ی «پیکربندی مؤثر» ایمیل/پیامک/AI است */
export async function guardAdmin(req: Request, opts: { mutating?: boolean; bucket: string; limit: number; windowMs?: number }): Promise<AdminGuard> {
  const user = await getPlatformAdminForApi();
  if (!user) return { ok: false, res: json({ ok: false, error: "دسترسی غیرمجاز" }, 403) };
  if (opts.mutating && !sameOriginJson(req)) return { ok: false, res: json({ ok: false, error: "درخواست نامعتبر" }, 400) };
  const rl = rateLimit(`${opts.bucket}:${user.id}`, opts.limit, opts.windowMs ?? 60_000);
  if (!rl.ok) return { ok: false, res: json({ ok: false, error: `تعداد درخواست‌ها زیاد است؛ ${rl.retryAfter} ثانیه بعد تلاش کنید` }, 429) };
  const team = await getTeamContext().catch(() => null);
  return { ok: true, user, ctx: { workspaceId: team?.workspaceId ?? 0, origin: await getOrigin().catch(() => "") }, workspaceName: team?.workspaceName ?? "" };
}
