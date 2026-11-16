import { desc, eq } from "drizzle-orm";
import { BookMarked, Trash2 } from "lucide-react";
import Shell from "@/components/Shell";
import ClauseForm from "@/components/ClauseForm";
import ConfirmButton from "@/components/ConfirmButton";
import { db } from "@/db";
import { clauses } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { deleteClauseAction } from "@/modules/clauses/actions";
import { BUILTIN_CLAUSES, CLAUSE_CATEGORIES } from "@/modules/clauses/builtin";
import { fa } from "@/lib/jalali";

export const dynamic = "force-dynamic";

/** کتابخانه‌ی بندهای آماده‌ی فضای کاری: بندهای اختصاصی شما + بندهای حقوقی پیش‌فرض */
export default async function ClausesPage() {
  const team = await requireTeam("view");
  const canWrite = can(team.wsRole, "write");
  const rows = await db.select().from(clauses).where(eq(clauses.workspaceId, team.workspaceId)).orderBy(desc(clauses.createdAt));
  return (
    <Shell user={team}>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-ink text-mint"><BookMarked size={20} /></span>
        <div>
          <h1 className="text-2xl font-black">کتابخانه‌ی بندها</h1>
          <p className="mt-1 text-xs text-ink/72">بندهای پرکاربرد را یک‌بار بنویسید و در هر قرارداد یا قالب، با یک کلیک از نوار ویرایشگر درج کنید.</p>
        </div>
      </div>

      {canWrite && (
        <section className="panel-solid mb-6 space-y-3 p-5 sm:p-6">
          <h2 className="text-sm font-black">بند جدید</h2>
          <ClauseForm />
        </section>
      )}

      <h2 className="mb-3 text-sm font-black">بندهای اختصاصی شما ({rows.length.toLocaleString("fa-IR")})</h2>
      <div className="mb-8 grid gap-3">
        {rows.length === 0 && <p className="panel-solid p-5 text-xs text-ink/72">هنوز بند اختصاصی نساخته‌اید. در ویرایشگر هم می‌توانید متن انتخاب‌شده را «به‌عنوان بند ذخیره» کنید.</p>}
        {rows.map((c) => (
          <details key={c.id} className="panel-solid p-4">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-bold">
              {c.title}
              <span className="badge border border-ink/10 bg-stone-50 text-ink/75">{CLAUSE_CATEGORIES[c.category] ?? "عمومی"}</span>
              <span className="text-xs font-normal text-ink/60">{fa(c.createdAt)}</span>
            </summary>
            <div className="mt-4 space-y-4">
              {canWrite ? (
                <>
                  <ClauseForm initial={{ id: c.id, title: c.title, category: c.category, body: c.body }} />
                  <form action={deleteClauseAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <ConfirmButton message="این بند حذف شود؟" className="btn-danger btn-sm"><Trash2 size={14} />حذف بند</ConfirmButton>
                  </form>
                </>
              ) : (
                <article className="contract-paper contract-body !min-h-0 !p-5" dangerouslySetInnerHTML={{ __html: c.body }} />
              )}
            </div>
          </details>
        ))}
      </div>

      <h2 className="mb-3 text-sm font-black">بندهای آماده‌ی سیستم ({BUILTIN_CLAUSES.length.toLocaleString("fa-IR")})</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {BUILTIN_CLAUSES.map((c) => (
          <div key={c.id} className="panel-solid p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold">{c.title}<span className="badge border border-ink/10 bg-stone-50 text-ink/75">{CLAUSE_CATEGORIES[c.category]}</span></div>
            <p className="text-xs leading-7 text-ink/75">{c.body.replace(/<[^>]*>/g, " ").trim()}</p>
          </div>
        ))}
      </div>
    </Shell>
  );
}
