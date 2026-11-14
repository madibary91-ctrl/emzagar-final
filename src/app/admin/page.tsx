import Link from "next/link";
import { Archive, BellRing, CheckCircle2, MessageCircleWarning, ChevronLeft, ChevronRight, Clock3, Download, Files, FilePlus2, FilePen, Hourglass, SlidersHorizontal, Search, Timer, TrendingUp, XCircle } from "lucide-react";
import Shell from "@/components/Shell";
import StatusBadge from "@/components/StatusBadge";
import { requireTeam } from "@/modules/tenancy/context";
import { can } from "@/modules/tenancy/roles";
import ContractsTable from "@/components/ContractsTable";
import { db } from "@/db";
import { templates } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { adminCounts, adminStats, listTags, queryContracts, SORTS } from "@/modules/contracts/service";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "all", label: "همه", icon: Files, color: "bg-[#e5eee8]" },
  { key: "sent", label: "ارسال شده", icon: Clock3, color: "bg-amber-100" },
  { key: "signed", label: "امضا شده", icon: CheckCircle2, color: "bg-emerald-100" },
  { key: "rejected", label: "رد شده", icon: XCircle, color: "bg-rose-100" },
  { key: "draft", label: "پیش‌نویس", icon: FilePen, color: "bg-sky-100" },
  { key: "expired", label: "منقضی", icon: Hourglass, color: "bg-stone-200" },
];
const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

type Sp = { status?: string; q?: string; issued?: string; denied?: string; from?: string; to?: string; templateId?: string; source?: string; sort?: string; expiring?: string; page?: string; archived?: string; tag?: string; requests?: string };

function href(sp: Sp, patch: Partial<Sp>) {
  const m = { ...sp, ...patch } as Record<string, string | undefined>;
  delete m.issued;
  delete m.denied;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(m)) if (v && !(k === "status" && v === "all") && !(k === "page" && v === "1")) qs.set(k, v);
  const s = qs.toString();
  return `/admin${s ? `?${s}` : ""}`;
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const user = await requireTeam("view");
  const sp = await searchParams;
  const status = sp.status || "all";
  const q = (sp.q || "").trim().slice(0, 100);
  const filters = {
    status,
    q,
    from: sp.from,
    to: sp.to,
    templateId: Number(sp.templateId) || undefined,
    source: sp.source,
    sort: sp.sort,
    expiring: sp.expiring === "1",
    archived: sp.archived === "1",
    tag: (sp.tag || "").trim().slice(0, 24) || undefined,
    openRequests: sp.requests === "1",
    page: Number(sp.page) || 1,
    pageSize: 20,
  };
  const [list, counts, stats, tpls, tagList] = await Promise.all([
    queryContracts(user.workspaceId, filters),
    adminCounts(user.workspaceId),
    adminStats(user.workspaceId),
    db.select({ id: templates.id, title: templates.title }).from(templates).where(eq(templates.workspaceId, user.workspaceId)).orderBy(asc(templates.title)),
    listTags(user.workspaceId),
  ]);
  const canWrite = can(user.wsRole, "write");
  const canDelete = can(user.wsRole, "delete");
  const advancedActive = !!(sp.from || sp.to || sp.templateId || sp.source || sp.expiring || (sp.sort && sp.sort !== "newest") || sp.tag || sp.requests);
  const exportQs = new URLSearchParams(Object.entries({ status, q, from: sp.from, to: sp.to, templateId: sp.templateId, source: sp.source, expiring: sp.expiring, archived: sp.archived, tag: sp.tag, requests: sp.requests }).filter(([, v]) => !!v) as [string, string][]).toString();
  const rows = list.rows.map((r) => ({
    ...r,
    issuedAt: r.issuedAt.toISOString(),
    signedAt: r.signedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
  }));

  return (
    <Shell user={user} wide>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black">قراردادهای صادر شده</h1>
          <p className="mt-1 text-xs text-ink/72">پیگیری وضعیت امضا، فیلتر پیشرفته و عملیات گروهی — فضای کاری «{user.workspaceName}»</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`/api/admin/export?${exportQs}`} className="btn-secondary"><Download size={16} />خروجی CSV</a>
          {canWrite && <Link href="/admin/new" className="btn-primary btn-mint"><FilePlus2 size={16} />صدور قرارداد جدید</Link>}
        </div>
      </div>

      {sp.denied && <p role="alert" className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">نقش شما اجازه‌ی انجام آن عملیات را ندارد.</p>}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "نرخ تکمیل امضا", value: `${fn(stats.rate)}٪`, icon: TrendingUp, color: "bg-mint/30" },
          { label: "میانگین زمان امضا", value: stats.avgHours === null ? "—" : stats.avgHours < 1 ? "کمتر از ۱ ساعت" : stats.avgHours < 48 ? `${fn(Math.round(stats.avgHours))} ساعت` : `${fn(Math.round(stats.avgHours / 24))} روز`, icon: Timer, color: "bg-sky-100" },
          { label: "در آستانه‌ی انقضا (۳ روز)", value: fn(stats.expiringSoon), icon: Hourglass, color: "bg-amber-100", href: href(sp, { expiring: "1", status: "sent", page: "1" }) },
          { label: "یادآوری‌های ارسال‌شده", value: fn(stats.reminders), icon: BellRing, color: "bg-emerald-100" },
        ].map((x) => {
          const inner = (
            <>
              <span className={`grid h-12 w-12 place-items-center rounded-2xl ${x.color}`}><x.icon size={21} /></span>
              <div>
                <b className="block text-xl font-black">{x.value}</b>
                <span className="text-xs font-semibold text-ink/75">{x.label}</span>
              </div>
            </>
          );
          return x.href ? (
            <Link key={x.label} href={x.href} className="panel-solid flex items-center gap-4 p-5 transition hover:-translate-y-0.5">{inner}</Link>
          ) : (
            <div key={x.label} className="panel-solid flex items-center gap-4 p-5">{inner}</div>
          );
        })}
      </div>
      {sp.issued && <p role="status" className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800">{sp.issued} قرارداد با موفقیت صادر و ارسال شد.</p>}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-7">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={href(sp, { status: t.key, page: "1", archived: undefined })}
            aria-current={status === t.key && sp.archived !== "1" ? "page" : undefined}
            className={`panel-solid flex items-center gap-3 p-4 transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(16,44,49,.07)] ${status === t.key && sp.archived !== "1" ? "!border-ink ring-4 ring-ink/5" : ""}`}
          >
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${t.color}`}><t.icon size={20} /></span>
            <div>
              <b className="block text-2xl font-black">{fn(t.key === "all" ? counts.active : counts[t.key] ?? 0)}</b>
              <span className="text-xs font-semibold text-ink/75">{t.label}</span>
            </div>
          </Link>
        ))}
        <Link
          href={href(sp, { archived: "1", status: "all", page: "1" })}
          aria-current={sp.archived === "1" ? "page" : undefined}
          className={`panel-solid flex items-center gap-3 p-4 transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(16,44,49,.07)] ${sp.archived === "1" ? "!border-ink ring-4 ring-ink/5" : ""}`}
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-stone-200"><Archive size={20} /></span>
          <div>
            <b className="block text-2xl font-black">{fn(counts.archived ?? 0)}</b>
            <span className="text-xs font-semibold text-ink/75">بایگانی</span>
          </div>
        </Link>
      </div>

      <form className="panel-solid mb-5 space-y-3 p-4">
        <input type="hidden" name="status" value={status} />
        {sp.archived === "1" && <input type="hidden" name="archived" value="1" />}
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink/72" />
            <input name="q" defaultValue={q} placeholder="جستجو: شماره، عنوان، نام یا ایمیل مشتری…" className="input !pr-11" aria-label="جستجو" />
          </div>
          <select name="sort" defaultValue={sp.sort || "newest"} className="input !w-auto" aria-label="مرتب‌سازی">
            {Object.entries(SORTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <button className="btn-primary">اعمال</button>
          {(q || advancedActive || status !== "all" || sp.archived === "1") && <Link href="/admin" className="btn-secondary">پاک‌کردن فیلترها</Link>}
        </div>
        <details open={advancedActive} className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-xs font-bold text-ink/75 hover:text-ink">
            <SlidersHorizontal size={14} />فیلترهای پیشرفته
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="label" htmlFor="f-from">صدور از تاریخ</label>
              <input id="f-from" type="date" name="from" defaultValue={sp.from} className="input" dir="ltr" />
            </div>
            <div>
              <label className="label" htmlFor="f-to">تا تاریخ</label>
              <input id="f-to" type="date" name="to" defaultValue={sp.to} className="input" dir="ltr" />
            </div>
            <div>
              <label className="label" htmlFor="f-tpl">قالب</label>
              <select id="f-tpl" name="templateId" defaultValue={sp.templateId || ""} className="input">
                <option value="">همه‌ی قالب‌ها</option>
                {tpls.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-src">منبع صدور</label>
              <select id="f-src" name="source" defaultValue={sp.source || ""} className="input">
                <option value="">همه</option>
                <option value="admin">صدور دستی / API</option>
                <option value="shop">خرید از فروشگاه</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-tag">برچسب</label>
              <select id="f-tag" name="tag" defaultValue={sp.tag || ""} className="input">
                <option value="">همه‌ی برچسب‌ها</option>
                {tagList.map((t) => <option key={t.tag} value={t.tag}>#{t.tag} ({fn(t.n)})</option>)}
              </select>
            </div>
            <label className="flex items-end gap-2 pb-3 text-xs font-semibold text-ink/72">
              <input type="checkbox" name="requests" value="1" defaultChecked={sp.requests === "1"} className="h-4 w-4 accent-[var(--ink)]" />
              <MessageCircleWarning size={14} />دارای درخواست اصلاح باز
            </label>
            <label className="flex items-end gap-2 pb-3 text-xs font-semibold text-ink/72">
              <input type="checkbox" name="expiring" value="1" defaultChecked={sp.expiring === "1"} className="h-4 w-4 accent-[var(--ink)]" />
              فقط در آستانه‌ی انقضا
            </label>
          </div>
        </details>
      </form>

      <div className="mb-2 flex items-center justify-between text-xs text-ink/72">
        <span>{fn(list.total)} قرارداد یافت شد</span>
        <span>صفحه {fn(list.page)} از {fn(list.pages)}</span>
      </div>

      <ContractsTable rows={rows} canWrite={canWrite} canDelete={canDelete} />

      {list.pages > 1 && (
        <nav className="mt-5 flex items-center justify-center gap-2" aria-label="صفحه‌بندی">
          {list.page > 1 && <Link href={href(sp, { page: String(list.page - 1) })} className="btn-secondary btn-sm"><ChevronRight size={14} />قبلی</Link>}
          <span className="rounded-xl bg-white px-3 py-2 text-xs font-bold">{fn(list.page)} / {fn(list.pages)}</span>
          {list.page < list.pages && <Link href={href(sp, { page: String(list.page + 1) })} className="btn-secondary btn-sm">بعدی<ChevronLeft size={14} /></Link>}
        </nav>
      )}
      <div className="h-20" />
    </Shell>
  );
}
