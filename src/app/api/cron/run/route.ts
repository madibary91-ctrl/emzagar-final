import { NextResponse } from "next/server";
import { runAutomation, verifyCronSecret } from "@/modules/automation/service";
import { dispatchOutbox } from "@/modules/sync/service";
import { reconcilePendingPayments } from "@/modules/billing/service";

export const dynamic = "force-dynamic";

/**
 * اجرای یادآوری و انقضا از بیرون (cron سیستم‌عامل، cPanel، cron-job.org …)
 *   curl -X POST https://your-domain/api/cron/run -H "Authorization: Bearer <CRON_SECRET>"
 */
async function handle(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-cron-secret");
  if (!(await verifyCronSecret(token))) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const result = await runAutomation("http");
  // تراکنش‌های پرداخت‌شده‌ای که به‌خاطر قطعی موقت درگاه تایید نشده‌اند (برای هاست‌های بدون پردازه‌ی دائمی)
  const payments = await reconcilePendingPayments().catch(() => ({ checked: 0, paid: 0, recovered: 0 }));
  const sync = await dispatchOutbox().catch(() => ({ pushed: 0, failed: 0 }));
  return NextResponse.json({ ok: true, ...result, payments, sync });
}

export const POST = handle;
export const GET = handle;
