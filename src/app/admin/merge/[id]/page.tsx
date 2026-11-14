import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, FileSpreadsheet } from "lucide-react";
import Shell from "@/components/Shell";
import LiveRefresh from "@/components/LiveRefresh";
import MergeReview from "@/components/merge/MergeReview";
import MergeActions from "@/components/merge/MergeActions";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { batchHeaders, batchMapping, batchOptions, batchStats, getBatch, listBatchRows, reviveStuck, rowData } from "@/modules/merge/service";
import { detectPlaceholders, MERGE_STATUS_LABELS } from "@/modules/merge/pure";
import { db } from "@/db";
import { mergeRows } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const metadata = { title: "ارسال انبوه" };

const TONE: Record<string, string> = {
  sent: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  invalid: "border-rose-200 bg-rose-50 text-rose-700",
  skipped: "border-ink/10 bg-stone-50 text-ink/65",
  queued: "border-sky-200 bg-sky-50 text-sky-800",
  processing: "border-sky-200 bg-sky-50 text-sky-800",
  pending: "border-amber-200 bg-amber-50 text-amber-800",
};

export default async function MergeBatchPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string }> }) {
  const team = await requireTeam("view");
  const { id } = await params;
  const { status: filter } = await searchParams;
  const batch = await getBatch(Number(id), team.workspaceId);
  if (!batch) notFound();
  const canWrite = can(team.wsRole, "write");
  const headers = batchHeaders(batch);

  if (batch.status === "draft") {
    if (!canWrite) notFound();
    const first = await db.select().from(mergeRows).where(and(eq(mergeRows.batchId, batch.id))).orderBy(asc(mergeRows.rowNo)).limit(4);
    const stats = await batchStats(batch.id);
    const total = Object.values(stats).reduce((s, n) => s + n, 0);
    return (
      <Shell user={team} wide>
        <Link href="/admin/merge" className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-ink/70 hover:underline"><ArrowRight size={13} />ارسال انبوه</Link>
        <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><FileSpreadsheet size={22} />{batch.title}</h1>
        <p className="mb-5 text-xs text-ink/72">فایل: {batch.fileName} — بازبینی و تأیید؛ تا زمانی که «ارسال» را نزنید هیچ قراردادی ساخته نمی‌شود.</p>
        <MergeReview
          batchId={batch.id}
          headers={headers}
          placeholders={detectPlaceholders(batch.bodyHtml, batch.contractTitle)}
          initialMapping={batchMapping(batch)}
          initialOptions={batchOptions(batch)}
          sampleRows={first.map((r) => headers.map((h) => rowData(r)[h] ?? ""))}
          total={total}
        />
      </Shell>
    );
  }

  if (batch.status === "running") await reviveStuck(batch.id);
  const st = await batchStats(batch.id);
  const total = Object.values(st).reduce((s, n) => s + n, 0);
  const finished = (st.sent ?? 0) + (st.failed ?? 0) + (st.invalid ?? 0) + (st.skipped ?? 0);
  const pct = total ? Math.round((finished / total) * 100) : 0;
  const rows = await listBatchRows(batch.id, { status: filter && MERGE_STATUS_LABELS[filter] ? filter : undefined, limit: 300 });
  const chips = ["sent", "failed", "invalid", "skipped", "queued", "processing"].filter((k) => (st[k] ?? 0) > 0);

  return (
    <Shell user={team} wide>
      {batch.status === "running" && <LiveRefresh seconds={4} />}
      <Link href="/admin/merge" className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-ink/70 hover:underline"><ArrowRight size={13} />ارسال انبوه</Link>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><FileSpreadsheet size={22} />{batch.title}</h1>
      <p className="mb-4 text-xs text-ink/72">فایل: {batch.fileName} — {batch.status === "running" ? "در حال ارسال… (می‌توانید صفحه را ببندید)" : batch.status === "done" ? "ارسال پایان یافت" : "لغو شد"}</p>
      <section className="panel-solid mb-5 space-y-4 p-5">
        <div className="h-3 overflow-hidden rounded-full bg-stone-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="پیشرفت ارسال"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} /></div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <b>{pct.toLocaleString("fa-IR")}٪ — {finished.toLocaleString("fa-IR")} از {total.toLocaleString("fa-IR")}</b>
          <Link href={`/admin/merge/${batch.id}`} className={`badge border ${!filter ? "border-ink bg-ink text-white" : "border-ink/10 bg-white"}`}>همه</Link>
          {chips.map((k) => <Link key={k} href={`/admin/merge/${batch.id}?status=${k}`} className={`badge border ${filter === k ? "border-ink bg-ink text-white" : TONE[k]}`}>{MERGE_STATUS_LABELS[k]}: {(st[k] ?? 0).toLocaleString("fa-IR")}</Link>)}
        </div>
        {canWrite && <MergeActions batchId={batch.id} status={batch.status} failed={(st.failed ?? 0)} canDelete={can(team.wsRole, "delete")} />}
      </section>
      <div className="panel-solid overflow-x-auto !p-0">
        <table className="w-full min-w-[640px]">
          <thead className="bg-stone-50"><tr><th className="th">ردیف</th><th className="th">گیرنده</th><th className="th">وضعیت</th><th className="th">قرارداد</th><th className="th">توضیح</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="td py-8 text-center text-ink/72">ردیفی با این فیلتر نیست.</td></tr>}
            {rows.map(({ row, number, cstatus }) => (
              <tr key={row.id} className="border-b border-ink/[.06]">
                <td className="td">{row.rowNo.toLocaleString("fa-IR")}</td>
                <td className="td">{row.name || "—"}<span dir="ltr" className="block text-xs text-ink/65">{row.mobile}</span></td>
                <td className="td"><span className={`badge border ${TONE[row.status] ?? ""}`}>{MERGE_STATUS_LABELS[row.status] ?? row.status}</span></td>
                <td className="td">{row.contractId ? <Link href={`/contracts/${row.contractId}`} className="font-mono text-xs font-bold hover:underline" dir="ltr">{number}</Link> : "—"}{cstatus === "signed" && <span className="mr-2 text-xs text-emerald-700">امضا شد</span>}</td>
                <td className="td text-xs text-rose-700">{row.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
