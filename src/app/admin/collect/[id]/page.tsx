import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { ChevronRight } from "lucide-react";
import Shell from "@/components/Shell";
import CollectAdmin, { type SubRow } from "@/components/CollectAdmin";
import { requireTeam } from "@/modules/tenancy/context";
import { countSubmissions, getCampaign, listSubmissions, publicBase } from "@/modules/collect/service";
import { displayValue, parseCollectFields } from "@/modules/collect/schema";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const fd = (n: number) => n.toLocaleString("fa-IR");

export default async function CollectDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; page?: string; created?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const admin = await requireTeam("view");
  const c = await getCampaign(Number(id), admin.workspaceId);
  if (!c) notFound();
  const page = Math.max(1, Number(sp.page) || 1);
  const [{ rows, total, pageSize }, valid] = await Promise.all([listSubmissions(c.id, { q: sp.q, page }), countSubmissions(c.id)]);
  const defs = parseCollectFields(c.fieldsJson);
  const url = `${await publicBase(c.workspaceId)}/c/${c.code}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 400, errorCorrectionLevel: "M" });
  const table: SubRow[] = rows.map((s) => {
    const v = JSON.parse(s.valuesJson || "{}") as Record<string, string>;
    return { id: s.id, receipt: s.receipt, name: s.fullName, mobile: s.mobile, verified: s.mobileVerified, at: faTime(s.createdAt), voided: !!s.voidedAt, summary: defs.filter((d) => v[d.key] !== undefined).map((d) => `${d.label}: ${displayValue(d, v[d.key])}`).join(" • ") };
  });
  const conv = c.views > 0 ? Math.min(100, Math.round((valid / c.views) * 100)) : 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const qs = (p: number) => `?${new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), page: String(p) })}`;
  return (
    <Shell user={admin} wide>
      <Link href="/admin/collect" className="mb-3 inline-flex items-center gap-1 text-xs font-bold text-ink/70"><ChevronRight size={14} />همه‌ی فرم‌ها</Link>
      <div className="mb-5">
        <h1 className="text-2xl font-black">{c.title}</h1>
        {sp.created && <p className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs leading-7 text-emerald-800">فرم ساخته شد. لینک را بفرستید یا پوستر QR را چاپ کنید.</p>}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["امضاهای معتبر", fd(valid)], ["بازدید", fd(c.views)], ["نرخ تکمیل", `${fd(conv)}٪`], ["ظرفیت", c.maxSubmissions ? fd(c.maxSubmissions) : "نامحدود"]].map(([k, v]) => (
          <div key={k} className="card !p-4"><p className="text-[11px] text-ink/60">{k}</p><p className="mt-1 text-2xl font-black tabular-nums">{v}</p></div>
        ))}
      </div>
      <form className="mb-3 flex gap-2" action="" method="get">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="جستجوی نام، موبایل یا کد رسید…" aria-label="جستجو" className="input max-w-sm" />
        <button className="btn-secondary">جستجو</button>
      </form>
      <CollectAdmin
        campaign={{ id: c.id, status: c.status, title: c.title, maxSubmissions: c.maxSubmissions, closesAt: c.closesAt ? c.closesAt.toISOString().slice(0, 10) : "", successMessage: c.successMessage, locked: valid > 0 }}
        url={url}
        qr={qr}
        rows={table}
      />
      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-3 text-xs" aria-label="صفحه‌بندی">
          {page > 1 && <Link className="btn-secondary btn-sm" href={qs(page - 1)}>قبلی</Link>}
          <span>صفحه {fd(page)} از {fd(pages)}</span>
          {page < pages && <Link className="btn-secondary btn-sm" href={qs(page + 1)}>بعدی</Link>}
        </nav>
      )}
    </Shell>
  );
}
