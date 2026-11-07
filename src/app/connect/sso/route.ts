import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession } from "@/modules/auth/session";
import { setActiveWorkspaceCookie } from "@/modules/tenancy/context";
import { consumeSsoToken } from "@/modules/connect/service";
import { logAudit } from "@/modules/audit/service";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/modules/connect/http";

export const dynamic = "force-dynamic";

const PATHS: Record<string, string> = { admin: "/admin", templates: "/admin/templates", contracts: "/admin", settings: "/admin/settings", new: "/admin/new" };

/** ورود یک‌کلیکی از افزونه‌ی وردپرس: توکن ۹۰ ثانیه‌ای و یک‌بارمصرف */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const rl = rateLimit(`connect:sso:${clientIp(req)}`, 30, 10 * 60_000);
  if (!rl.ok) redirect("/login?sso=limited");
  const hit = await consumeSsoToken(sp.get("t") || "");
  if (!hit) redirect("/login?sso=expired");
  const [user] = await db.select().from(users).where(eq(users.id, hit.userId));
  if (!user) redirect("/login?sso=expired");
  await createSession(user.id, user.passwordHash);
  await setActiveWorkspaceCookie(hit.workspaceId);
  await logAudit({ action: "auth.login", userId: user.id, workspaceId: hit.workspaceId, detail: "ورود یک‌کلیکی از وردپرس" });
  redirect(PATHS[sp.get("to") || "admin"] ?? "/admin");
}
