import { auditHealthAction, buildSnapshot } from "@/modules/health/service";
import { guardAdmin, json } from "@/modules/health/guard";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** گزارش JSON برای پشتیبانی/مستندسازی (هیچ کلید یا رمزی در آن نیست؛ متغیرهای محیطی فقط «تنظیم‌شده/نشده» هستند) */
export async function GET(req: Request) {
  const g = await guardAdmin(req, { bucket: "health-export", limit: 10 });
  if (!g.ok) return g.res;
  const snapshot = await buildSnapshot(g.ctx, { force: true, workspaceName: g.workspaceName });
  await auditHealthAction(g.user.id, "health.export", `score ${snapshot.readiness.score}`);
  const name = `health-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  if (new URL(req.url).searchParams.get("inline") === "1") return json({ ok: true, report: snapshot });
  return new Response(JSON.stringify({ report: "emzagar-health", ...snapshot }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}
