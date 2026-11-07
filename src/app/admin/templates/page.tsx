import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import Shell from "@/components/Shell";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { deleteTemplateAction } from "@/modules/templates/actions";
import { fa } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const admin = await requireTeam("view");
  const rows = await db.select().from(templates).where(eq(templates.workspaceId, admin.workspaceId)).orderBy(desc(templates.updatedAt));
  return (
    <Shell user={admin}>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-black">قالب‌های قرارداد</h1>
        <Link href="/admin/templates/new" className="btn btn-primary">+ قالب جدید</Link>
      </div>
      <div className="grid gap-3">
        {rows.map((t) => (
          <div key={t.id} className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">{t.title}</div>
              <div className="text-xs text-stone-600">{t.description} • آخرین ویرایش: {fa(t.updatedAt)}</div>
            </div>
            <div className="flex gap-2">
              <Link href={`/admin/templates/${t.id}`} className="btn btn-secondary">ویرایش</Link>
              <form action={deleteTemplateAction}>
                <input type="hidden" name="id" value={t.id} />
                <button className="btn btn-secondary text-red-700">حذف</button>
              </form>
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="card text-stone-600">هنوز قالبی ساخته نشده است.</div>}
      </div>
    </Shell>
  );
}
