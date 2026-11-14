import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { ChevronLeft, GitCompareArrows, History, RotateCcw } from "lucide-react";
import Shell from "@/components/Shell";
import StatusBadge from "@/components/StatusBadge";
import DiffView from "@/components/DiffView";
import ConfirmButton from "@/components/ConfirmButton";
import { db } from "@/db";
import { contracts } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { compareRevisions, listRevisions, REVISION_KIND_LABELS } from "@/modules/contracts/revisions";
import { restoreRevisionAction } from "@/modules/contracts/actions";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const fn = (n: number) => n.toLocaleString("fa-IR");

/** تاریخچه‌ی نسخه‌های متن؛ مقایسه‌ی کلمه‌به‌کلمه‌ی هر دو نسخه و بازگشت به نسخه‌ی قبل (فقط در پیش‌نویس) */
export default async function HistoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string; error?: string }> }) {
  const team = await requireTeam("view");
  const id = Number((await params).id);
  const sp = await searchParams;
  if (!Number.isInteger(id)) notFound();
  const [c] = await db.select().from(contracts).where(and(eq(contracts.id, id), eq(contracts.workspaceId, team.workspaceId)));
  if (!c) notFound();
  const revs = await listRevisions(id);
  const latest = revs[0]?.version ?? 0;
  const to = Number(sp.to) || latest;
  const from = Number(sp.from) || Math.max(1, to - 1);
  const cmp = revs.length >= 2 ? await compareRevisions(id, from, to) : null;
  const canRestore = c.status === "draft" && can(team.wsRole, "write");

  return (
    <Shell user={team} wide>
      <div className="mb-3 flex items-center gap-2 text-xs text-ink/72">
        <Link href={`/contracts/${id}`} className="hover:text-ink">{c.title}</Link>
        <ChevronLeft size={12} />
        <span>تاریخچه‌ی نسخه‌ها</span>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><History size={20} /></span>
        <div>
          <h1 className="text-2xl font-black">تاریخچه‌ی نسخه‌ها</h1>
          <p className="mt-1 text-xs text-ink/72"><span dir="ltr" className="font-mono">{c.number}</span> • هر ذخیره‌ی تغییردار یک نسخه‌ی جدید می‌سازد و هیچ نسخه‌ای حذف نمی‌شود.</p>
        </div>
        <StatusBadge status={c.status} />
        <span className="flex-1" />
        {c.status === "draft" && can(team.wsRole, "write") && <Link href={`/admin/contracts/${id}/edit`} className="btn-primary btn-mint">ادامه‌ی ویرایش</Link>}
      </div>
      {sp.error && <p role="alert" className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-700">{sp.error}</p>}

      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <aside className="panel-solid h-fit p-4">
          <h2 className="mb-3 text-xs font-black">نسخه‌ها ({fn(revs.length)})</h2>
          {revs.length === 0 && <p className="text-xs text-ink/72">برای این قرارداد هنوز نسخه‌ای ثبت نشده است.</p>}
          <ol className="space-y-2">
            {revs.map((r) => {
              const active = r.version === to || r.version === from;
              return (
                <li key={r.id} className={`rounded-2xl border p-3 text-xs ${active ? "border-ink bg-stone-50" : "border-ink/10"}`}>
                  <div className="flex items-center gap-2">
                    <b className="grid h-7 min-w-7 place-items-center rounded-full bg-ink px-1 text-[11px] text-mint">{fn(r.version)}</b>
                    <span className="font-bold">{REVISION_KIND_LABELS[r.kind] ?? r.kind}</span>
                    {r.version === latest && <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-700">آخرین</span>}
                  </div>
                  <p className="mt-1 text-ink/72">{faTime(r.createdAt)} • {r.authorName ?? "سیستم"} • {fn(r.wordCount)} کلمه</p>
                  {r.note && <p className="mt-1 text-ink/80">{r.note}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.version > 1 && <Link href={`?from=${r.version - 1}&to=${r.version}`} className="btn-secondary btn-sm"><GitCompareArrows size={12} />با قبلی</Link>}
                    {r.version !== latest && <Link href={`?from=${r.version}&to=${latest}`} className="btn-secondary btn-sm">با آخرین</Link>}
                    {canRestore && r.version !== latest && (
                      <form action={restoreRevisionAction}>
                        <input type="hidden" name="id" value={id} />
                        <input type="hidden" name="version" value={r.version} />
                        <ConfirmButton message={`متن فعلی با نسخه‌ی ${r.version} جایگزین شود؟ (نسخه‌ی فعلی در تاریخچه می‌ماند.)`} className="btn-ghost btn-sm"><RotateCcw size={12} />بازگردانی</ConfirmButton>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </aside>

        <section aria-live="polite">
          {!cmp ? (
            <div className="panel-solid p-6 text-center text-xs text-ink/72">برای مقایسه حداقل دو نسخه لازم است. پس از اولین ویرایش، تفاوت‌ها اینجا نمایش داده می‌شود.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <b>مقایسه‌ی نسخه‌ی {fn(cmp.from.version)} با نسخه‌ی {fn(cmp.to.version)}</b>
                <span className="badge border border-emerald-200 bg-emerald-50 text-emerald-700">+{fn(cmp.stats.added)} کلمه افزوده</span>
                <span className="badge border border-rose-200 bg-rose-50 text-rose-700">−{fn(cmp.stats.removed)} کلمه حذف</span>
                {cmp.titleChanged && <span className="badge border border-amber-200 bg-amber-50 text-amber-800">عنوان تغییر کرده: «{cmp.from.title}» ← «{cmp.to.title}»</span>}
                {!cmp.stats.changed && !cmp.titleChanged && <span className="text-ink/72">تفاوتی در متن نیست.</span>}
              </div>
              <DiffView parts={cmp.parts} />
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
