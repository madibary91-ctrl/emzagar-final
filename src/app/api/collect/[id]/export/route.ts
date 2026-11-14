import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { buildCsv, buildZip, getCampaign } from "@/modules/collect/service";
import { logAudit } from "@/modules/audit/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** خروجی مدیر: ?f=csv (اکسل) یا ?f=zip (PDF همه‌ی امضاهای معتبر) */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const team = await getTeamForApi("view");
  if (!team) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const c = await getCampaign(Number(id), team.workspaceId);
  if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!rateLimit(`colexport:${team.id}`, 20, 15 * 60_000).ok) return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  const f = new URL(req.url).searchParams.get("f");
  await logAudit({ action: "report.exported", workspaceId: team.workspaceId, userId: team.id, detail: `امضاهای عمومی «${c.title}» (${f === "zip" ? "ZIP" : "CSV"})` });
  if (f === "zip") {
    const z = await buildZip(c);
    return new NextResponse(new Uint8Array(z.data), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="signatures-${c.code}.zip"`, "Cache-Control": "private, no-store", "X-Zip-Count": String(z.count), "X-Zip-Truncated": z.truncated ? "1" : "0" } });
  }
  return new NextResponse(await buildCsv(c), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="signatures-${c.code}.csv"`, "Cache-Control": "private, no-store" } });
}
