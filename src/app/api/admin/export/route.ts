import { NextResponse } from "next/server";
import { getTeamForApi } from "@/modules/tenancy/context";
import { queryContracts, STATUS_LABELS } from "@/modules/contracts/service";
import { logAudit } from "@/modules/audit/service";

export const dynamic = "force-dynamic";

/** نویسه‌های آغازین فرمول در اکسل خنثی می‌شوند (CSV Injection) */
function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** خروجی CSV از قراردادهای همین فضای کاری؛ با همان فیلترهای لیست یا فقط شناسه‌های انتخاب‌شده */
export async function GET(req: Request) {
  const team = await getTeamForApi("view");
  if (!team) return new NextResponse("Forbidden", { status: 403 });
  const sp = new URL(req.url).searchParams;
  const ids = (sp.get("ids") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const { rows } = await queryContracts(team.workspaceId, {
    status: sp.get("status") || "all",
    q: (sp.get("q") || "").trim().slice(0, 100),
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    templateId: Number(sp.get("templateId")) || undefined,
    source: sp.get("source") || undefined,
    expiring: sp.get("expiring") === "1",
    archived: sp.get("archived") === "1",
    tag: sp.get("tag") || undefined,
    openRequests: sp.get("requests") === "1",
    ids: ids.length ? ids : undefined,
    pageSize: 5000,
  });
  const head = ["شماره", "عنوان", "قالب", "مشتری", "ایمیل", "وضعیت", "تاریخ صدور", "تاریخ امضا", "برچسب‌ها", "ارزش (تومان)", "بایگانی"];
  const lines = [head.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [r.number, r.title, r.templateTitle ?? "", r.userName, r.userEmail, STATUS_LABELS[r.status] ?? r.status, r.issuedAt.toISOString(), r.signedAt?.toISOString() ?? "", r.tags.split(",").filter(Boolean).join("، "), r.contractValue ? String(r.contractValue) : "", r.archivedAt ? "بله" : ""]
        .map(cell)
        .join(","),
    );
  }
  await logAudit({ action: "report.exported", workspaceId: team.workspaceId, userId: team.id, detail: `خروجی CSV (${rows.length} قرارداد)` });
  return new NextResponse("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="contracts.csv"',
      "Cache-Control": "no-store",
    },
  });
}
