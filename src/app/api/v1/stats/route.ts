import { NextResponse } from "next/server";
import { authenticateApi } from "@/modules/api/service";
import { adminCounts, adminStats, workspaceName } from "@/modules/contracts/service";

export const dynamic = "force-dynamic";

/** اتصال‌سنجی کلید + آمار فضای کاری (برای دکمه‌ی «تست اتصال» و ویجت آمار افزونه‌ی وردپرس) */
export async function GET(req: Request) {
  const auth = await authenticateApi(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const [name, counts, stats] = await Promise.all([workspaceName(auth.workspaceId), adminCounts(auth.workspaceId), adminStats(auth.workspaceId)]);
  return NextResponse.json(
    {
      ok: true,
      workspace: name,
      counts,
      stats: { total: stats.total, signed: stats.signed, pending: stats.pending, rate: stats.rate, expiringSoon: stats.expiringSoon, avgHours: stats.avgHours },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
