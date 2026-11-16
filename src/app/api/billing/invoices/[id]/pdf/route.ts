import { NextResponse } from "next/server";
import { getInvoice, renderInvoicePdf } from "@/modules/billing/invoices";
import { getPlatformAdminForApi } from "@/modules/platform/admin";
import { getTeamForApi } from "@/modules/tenancy/context";
import { rateLimit } from "@/lib/rate-limit";
import { invoiceFail } from "@/modules/billing/invoice-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * دانلود PDF فاکتور رسمی (یا اعلامیه‌ی بستانکاری).
 * دسترسی: مالک/مدیر همان فضای کاری، یا مدیر کل پلتفرم. فاکتور فضای دیگر به‌جای «ممنوع» همیشه ۴۰۴ می‌دهد (افشای وجود شناسه‌ها ممنوع).
 * خطا برای «کلیک روی لینک در مرورگر» به صفحه‌ی فاکتورها با پیام روشن برمی‌گردد (نه متن خام `Unauthorized`)؛ کلاینت‌های API همان کد وضعیت را می‌گیرند.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const invoiceId = Number(id);
  if (!Number.isInteger(invoiceId) || invoiceId < 1) return invoiceFail(req, "nodoc", 404);

  const [admin, team] = await Promise.all([getPlatformAdminForApi(), getTeamForApi("settings")]);
  if (!admin && !team) return invoiceFail(req, "auth", 401);
  if (!rateLimit(`invoice:pdf:${admin?.id ?? team?.id}`, 30, 60_000).ok) return invoiceFail(req, "rate", 429);

  const inv = await getInvoice(invoiceId);
  if (!inv || (!admin && inv.workspaceId !== team?.workspaceId)) return invoiceFail(req, "nodoc", 404);
  let pdf: Buffer;
  try {
    pdf = await renderInvoicePdf(inv);
  } catch (e) {
    console.error("[invoice:pdf]", invoiceId, e instanceof Error ? e.message : e);
    return invoiceFail(req, "pdf", 500);
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${inv.number}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
