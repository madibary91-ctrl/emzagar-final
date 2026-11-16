import Link from "next/link";
import { Plus, QrCode } from "lucide-react";
import Shell from "@/components/Shell";
import { requireTeam } from "@/modules/tenancy/context";
import { listCampaigns } from "@/modules/collect/service";
import { faTime } from "@/lib/jalali";
import { can } from "@/modules/tenancy/roles";

export const dynamic = "force-dynamic";
export const metadata = { title: "جمع‌آوری امضای عمومی" };

const ST: Record<string, [string, string]> = { open: ["باز", "bg-emerald-50 text-emerald-700"], paused: ["متوقف", "bg-amber-50 text-amber-700"], closed: ["بسته", "bg-stone-100 text-stone-600"] };
const fd = (n: number) => n.toLocaleString("fa-IR");

export default async function CollectListPage() {
  const admin = await requireTeam("view");
  const list = await listCampaigns(admin.workspaceId);
  return (
    <Shell user={admin} wide>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black">جمع‌آوری امضای عمومی</h1>
          <p className="mt-1 text-sm leading-7 text-ink/70">یک متن یا فایل، یک لینک و QR؛ هر کس باز کند مستقیم فرم را پر و امضا می‌کند. همه‌ی امضاها اینجا جمع می‌شود.</p>
        </div>
        {can(admin.wsRole, "write") && <Link href="/admin/collect/new" className="btn-primary btn-mint"><Plus size={16} />فرم جدید</Link>}
      </div>
      {list.length === 0 ? (
        <div className="card text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-ink text-mint"><QrCode size={26} /></span>
          <h2 className="mt-4 font-black">هنوز فرمی نساخته‌اید</h2>
          <p className="mt-1 text-xs leading-7 text-ink/70">برای باشگاه، کلینیک، آموزشگاه یا رویداد: رضایت‌نامه را یک‌بار بسازید و QR آن را روی میز پذیرش بگذارید.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {list.map((c) => (
            <Link key={c.id} href={`/admin/collect/${c.id}`} className="card block transition hover:-translate-y-0.5 hover:shadow-lg">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-black">{c.title}</h2>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${ST[c.status]?.[1] ?? ""}`}>{ST[c.status]?.[0] ?? c.status}</span>
              </div>
              <p className="mt-3 text-3xl font-black tabular-nums">{fd(c.submissions)}<span className="mr-1 text-xs font-bold text-ink/60">امضا{c.maxSubmissions ? ` از ${fd(c.maxSubmissions)}` : ""}</span></p>
              <p className="mt-1 text-[11px] text-ink/60">{c.lastAt ? `آخرین امضا: ${faTime(c.lastAt)}` : "هنوز امضایی ثبت نشده"} • {fd(c.views)} بازدید</p>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  );
}
