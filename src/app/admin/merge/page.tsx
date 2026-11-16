import Link from "next/link";
import { eq } from "drizzle-orm";
import { FileSpreadsheet } from "lucide-react";
import Shell from "@/components/Shell";
import MergeUploadForm from "@/components/merge/MergeUploadForm";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { faTime } from "@/lib/jalali";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import { listBatches } from "@/modules/merge/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "ارسال انبوه از اکسل" };

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "در انتظار بازبینی", cls: "border-amber-200 bg-amber-50 text-amber-800" },
  running: { label: "در حال ارسال", cls: "border-sky-200 bg-sky-50 text-sky-800" },
  done: { label: "پایان‌یافته", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  cancelled: { label: "لغوشده", cls: "border-ink/10 bg-stone-50 text-ink/65" },
};

export default async function MergePage() {
  const team = await requireTeam("view");
  const canWrite = can(team.wsRole, "write");
  const [tpls, batches] = await Promise.all([
    canWrite ? db.select({ id: templates.id, title: templates.title }).from(templates).where(eq(templates.workspaceId, team.workspaceId)) : Promise.resolve([]),
    listBatches(team.workspaceId),
  ]);
  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><FileSpreadsheet size={22} />ارسال انبوه از اکسل</h1>
      <p className="mb-5 max-w-3xl text-xs leading-7 text-ink/72">یک قالب را با فایل اکسل یا CSV بارگذاری کنید؛ سامانه برای هر ردیف یک قرارداد شخصی‌سازی‌شده (نام، سمت، مبلغ و هر ستون دلخواه) می‌سازد و لینک امضا را برای همه می‌فرستد. گیرنده‌ها بدون ثبت‌نام و فقط با کد پیامکی امضا می‌کنند. می‌توانید بیعانه و اقساط را هم همراه هر قرارداد تعریف کنید.</p>
      {canWrite && (
        <section className="panel-solid mb-6 p-5 sm:p-6">
          <h2 className="mb-4 text-sm font-black">دسته‌ی جدید</h2>
          <MergeUploadForm templates={tpls} />
        </section>
      )}
      <div className="panel-solid overflow-x-auto !p-0">
        <table className="w-full min-w-[640px]">
          <thead className="bg-stone-50"><tr><th className="th">دسته</th><th className="th">وضعیت</th><th className="th">ارسال‌شده</th><th className="th">ناموفق/نامعتبر</th><th className="th">تاریخ</th></tr></thead>
          <tbody>
            {batches.length === 0 && <tr><td colSpan={5} className="td py-10 text-center text-ink/72">هنوز ارسال انبوهی انجام نشده است.</td></tr>}
            {batches.map(({ batch, counts, total }) => (
              <tr key={batch.id} className="border-b border-ink/[.06]">
                <td className="td"><Link href={`/admin/merge/${batch.id}`} className="font-bold hover:underline">{batch.title}</Link><span className="block text-xs text-ink/65">{batch.fileName}</span></td>
                <td className="td"><span className={`badge border ${STATUS[batch.status]?.cls ?? ""}`}>{STATUS[batch.status]?.label ?? batch.status}</span></td>
                <td className="td">{(counts.sent ?? 0).toLocaleString("fa-IR")} از {total.toLocaleString("fa-IR")}</td>
                <td className="td">{((counts.failed ?? 0) + (counts.invalid ?? 0)).toLocaleString("fa-IR")}</td>
                <td className="td whitespace-nowrap text-xs">{faTime(batch.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
