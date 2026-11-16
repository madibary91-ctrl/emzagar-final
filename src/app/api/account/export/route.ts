import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import { logAudit } from "@/modules/audit/service";
import { buildUserExport } from "@/modules/privacy/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** دانلود JSON کامل داده‌های شخصی کاربر واردشده */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!rateLimit(`export:${user.id}`, 5, 60 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const data = await buildUserExport(user.id);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await logAudit({ action: "account.exported", userId: user.id, detail: "خروجی کامل داده‌های شخصی" });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-data-${user.id}-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
