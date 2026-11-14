import { toCsv } from "@/lib/csv-out";
import { getTeamForApi } from "@/modules/tenancy/context";
import { batchStats, getBatch, listBatchRows } from "@/modules/merge/service";
import { MERGE_STATUS_LABELS } from "@/modules/merge/pure";

export const dynamic = "force-dynamic";

/** گزارش نتیجه‌ی ارسال انبوه (CSV): وضعیت هر ردیف، خطا، شماره‌ی قرارداد */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const team = await getTeamForApi("view");
  if (!team) return new Response("unauthorized", { status: 401 });
  const batch = await getBatch(Number((await params).id), team.workspaceId);
  if (!batch) return new Response("not found", { status: 404 });
  const rows = await listBatchRows(batch.id, { limit: 5000 });
  const st = await batchStats(batch.id);
  const out: unknown[][] = [["ردیف", "نام", "موبایل", "وضعیت", "خطا", "شماره‌ی قرارداد", "وضعیت قرارداد"]];
  for (const { row, number, cstatus } of rows) out.push([row.rowNo, row.name, row.mobile, MERGE_STATUS_LABELS[row.status] ?? row.status, row.error ?? "", number ?? "", cstatus ?? ""]);
  void st;
  return new Response(toCsv(out), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="merge-${batch.id}-report.csv"`, "Cache-Control": "private, no-store" } });
}
