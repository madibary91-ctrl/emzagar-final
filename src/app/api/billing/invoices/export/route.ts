import { toCsv } from "@/lib/csv-out";
import { rateLimit } from "@/lib/rate-limit";
import { invoiceItems, listInvoices } from "@/modules/billing/invoices";
import { invoiceFail } from "@/modules/billing/invoice-http";
import { getTeamForApi } from "@/modules/tenancy/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** خروجی CSV فاکتورها و اعلامیه‌های بستانکاری فضای کاری (برای حسابدار؛ Excel-safe با BOM) */
export async function GET(req: Request) {
  const team = await getTeamForApi("settings");
  if (!team) return invoiceFail(req, "auth", 401);
  if (!rateLimit(`invoice:csv:${team.id}`, 10, 60_000).ok) return invoiceFail(req, "rate", 429);
  const rows = await listInvoices(team.workspaceId, 1000);
  const csv = toCsv([
    ["شماره", "نوع", "تاریخ صدور (میلادی)", "شرح", "مبلغ پیش از مالیات", "مالیات", "مبلغ کل", "وضعیت", "شماره‌ی پیگیری", "کد پیگیری درگاه", "آزمایشی"],
    ...rows.map((i) => [i.number, i.kind === "credit_note" ? "اعلامیه‌ی بستانکاری" : "فاکتور", i.issuedAt.toISOString().slice(0, 10), invoiceItems(i)[0]?.title ?? "", i.subtotal, i.taxAmount, i.total, i.status, i.trackingCode, i.paymentRef ?? "", i.test ? "بله" : "خیر"]),
  ]);
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="invoices.csv"', "Cache-Control": "private, no-store" } });
}
