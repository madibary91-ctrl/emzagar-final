import { clientIpFrom } from "@/lib/request";
import { rateLimit } from "@/lib/rate-limit";
import { verifyCronSecret } from "@/modules/automation/service";
import { statusSummary } from "@/modules/health/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const headers = { "Cache-Control": "no-store" };

/**
 * نقطه‌ی پایش بیرونی (UptimeRobot، Better Stack، Zabbix …): وضعیت تجمیعی همه‌ی سرویس‌ها.
 *   curl -H "Authorization: Bearer <CRON_SECRET>" https://your-domain/api/health/status
 * پاسخ 200 = ok/degraded ، 503 = down (یکی از سرویس‌های حیاتی قطع است). بدون کلید 401.
 * مسیر ساده‌ی /api/health (بدون احراز هویت، فقط دیتابیس) برای healthcheck داکر دست‌نخورده است.
 */
export async function GET(req: Request) {
  const ip = clientIpFrom((n) => req.headers.get(n));
  if (!rateLimit(`health-status:${ip}`, 30, 60_000).ok) return Response.json({ ok: false, error: "rate_limited" }, { status: 429, headers });
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-cron-secret");
  try {
    if (!(await verifyCronSecret(token))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401, headers });
  } catch {
    // پیش از نصب یا هنگام قطعی دیتابیس، کلید قابل راستی‌آزمایی نیست؛ برای پایش یعنی «قطع»
    return Response.json({ ok: false, status: "down", error: "database_unavailable" }, { status: 503, headers });
  }
  const s = await statusSummary();
  return Response.json({ ok: s.status !== "down", ...s }, { status: s.status === "down" ? 503 : 200, headers });
}
