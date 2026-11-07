import Link from "next/link";
import { ScanSearch } from "lucide-react";
import { desc, eq, ne, and } from "drizzle-orm";
import Shell from "@/components/Shell";
import RiskAnalyzer, { RiskReport } from "@/components/RiskAnalyzer";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { aiConfigured, usageToday } from "@/modules/ai/service";
import { getAnalysis, listAnalyses } from "@/modules/risk/service";
import { LEVEL_LABELS, type Level } from "@/modules/risk/rules";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const COLOR: Record<string, string> = { low: "bg-emerald-50 text-emerald-700", medium: "bg-amber-50 text-amber-700", high: "bg-orange-50 text-orange-700", critical: "bg-red-50 text-red-700" };

/** تحلیل ریسک قرارداد: موتور قواعد فارسی + هوش مصنوعی */
export default async function RiskPage({ searchParams }: { searchParams: Promise<{ contract?: string; view?: string }> }) {
  const team = await requireTeam("view");
  const sp = await searchParams;
  const canWrite = can(team.wsRole, "write");
  const viewId = Number(sp.view);
  const contractParam = Number(sp.contract);
  const [list, history, aiReady, usage, viewed] = await Promise.all([
    db.select({ id: contracts.id, number: contracts.number, title: contracts.title }).from(contracts).where(and(eq(contracts.workspaceId, team.workspaceId), ne(contracts.status, "cancelled"))).orderBy(desc(contracts.issuedAt)).limit(200),
    listAnalyses(team.workspaceId),
    aiConfigured(team.workspaceId),
    usageToday(team.workspaceId),
    Number.isInteger(viewId) && viewId > 0 ? getAnalysis(team.workspaceId, viewId) : Promise.resolve(null),
  ]);

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><ScanSearch size={22} />تحلیل ریسک قرارداد</h1>
      <p className="mb-5 text-xs text-ink/72">بندهای ناقص، عبارت‌های یک‌طرفه و جریمه‌های سنگین را پیش از امضا شناسایی کنید.</p>

      {viewed && (
        <div className="mb-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-bold">گزارش ذخیره‌شده — {viewed.row.title}</h2>
            <Link href="/admin/risk" className="btn-ghost btn-sm">بستن</Link>
          </div>
          <RiskReport title={viewed.row.title} result={viewed.result} engine={viewed.row.engine} />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div>
          {canWrite ? (
            <RiskAnalyzer contracts={list} initialContractId={Number.isInteger(contractParam) && list.some((c) => c.id === contractParam) ? contractParam : undefined} aiReady={aiReady} aiLeft={Math.max(0, usage.limit - usage.used)} />
          ) : (
            <p className="panel-solid p-6 text-sm text-ink/75">نقش «ناظر» فقط می‌تواند گزارش‌های قبلی را ببیند.</p>
          )}
        </div>
        <aside className="panel-solid h-fit p-5">
          <h2 className="mb-3 text-sm font-bold">تحلیل‌های اخیر</h2>
          <ul className="space-y-2">
            {history.map((h) => (
              <li key={h.id}>
                <Link href={`/admin/risk?view=${h.id}`} className="flex items-center justify-between gap-2 rounded-xl border border-ink/[.07] p-3 transition hover:bg-ink/[.03]">
                  <span className="min-w-0">
                    <b className="block truncate text-[13px]">{h.title}</b>
                    <span className="text-xs text-ink/72">{faTime(h.createdAt)}</span>
                  </span>
                  <span className={`badge ${COLOR[h.level] ?? COLOR.medium}`}>{fn(h.score)} · {LEVEL_LABELS[h.level as Level] ?? h.level}</span>
                </Link>
              </li>
            ))}
            {history.length === 0 && <li className="py-6 text-center text-xs text-ink/72">هنوز تحلیلی انجام نشده است.</li>}
          </ul>
        </aside>
      </div>
    </Shell>
  );
}
