import Link from "next/link";
import { ArrowUpLeft, Ban, CheckCircle2, ChevronLeft, ChevronRight, Clock3, FileText, PartyPopper, PenLine, Search, X } from "lucide-react";
import { queryUserContracts, type UserFilter } from "@/modules/contracts/service";
import { USER_PAGE_SIZE } from "@/modules/contracts/user-filter";
import StatusBadge from "@/components/StatusBadge";
import { fa } from "@/lib/jalali";

const TABS: { key: UserFilter; label: string }[] = [
  { key: "all", label: "همه قراردادها" },
  { key: "my_turn", label: "نوبت امضای شما" },
  { key: "pending", label: "در انتظار امضا" },
  { key: "signed", label: "امضا شده" },
  { key: "closed", label: "رد / لغو / منقضی" },
];

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** معادل شورت‌کد [contracts_dashboard]: قابل استفاده در هر صفحه (و از طریق /embed/dashboard در سایت‌های دیگر) */
export default async function ContractsDashboard({
  userId,
  filter,
  basePath = "/dashboard",
  q = "",
  page = 1,
}: {
  userId: number;
  filter: UserFilter;
  basePath?: string;
  q?: string;
  page?: number;
}) {
  // P-01: جستجو، شمارنده‌ی تب‌ها و صفحه‌بندی در SQL؛ فقط یک صفحه (۲۰ ردیف) به Node می‌آید، نه همه‌ی قراردادهای کاربر
  const query = q.trim();
  const data = await queryUserContracts(userId, { filter, q: query, page, pageSize: USER_PAGE_SIZE });
  const { rows, counts, totals, pages, page: current } = data;
  const countOf = (f: UserFilter) => counts[f];
  const hasAny = totals.all > 0;

  const link = (patch: { status?: UserFilter; page?: number; keepQuery?: boolean }) => {
    const sp = new URLSearchParams();
    const st = patch.status ?? filter;
    if (st !== "all") sp.set("status", st);
    if (query && patch.keepQuery !== false) sp.set("q", query);
    if ((patch.page ?? 1) > 1) sp.set("page", String(patch.page));
    const s = sp.toString();
    return `${basePath}${s ? `?${s}` : ""}`;
  };

  const stats: { label: string; value: number; icon: typeof PenLine; color: string; to: UserFilter }[] = [
    { label: "نوبت امضای شما", value: totals.my_turn, icon: PenLine, color: "bg-mint/30", to: "my_turn" },
    { label: "در انتظار دیگران", value: totals.waiting, icon: Clock3, color: "bg-amber-100", to: "pending" },
    { label: "امضا شده", value: totals.signed, icon: CheckCircle2, color: "bg-emerald-100", to: "signed" },
    { label: "رد / لغو / منقضی", value: totals.closed, icon: Ban, color: "bg-stone-200", to: "closed" },
  ];

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={`${basePath}?status=${s.to}`} className="panel-solid flex items-center gap-4 p-5 transition hover:-translate-y-0.5">
            <span className={`grid h-12 w-12 place-items-center rounded-2xl ${s.color}`}><s.icon size={21} /></span>
            <div>
              <b className="block text-2xl font-black">{fn(s.value)}</b>
              <span className="text-xs font-semibold text-ink/75">{s.label}</span>
            </div>
          </Link>
        ))}
      </section>

      <form action={basePath} className="flex flex-wrap items-center gap-2" role="search">
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        <div className="relative min-w-52 flex-1">
          <Search size={16} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink/60" />
          <input name="q" defaultValue={query} maxLength={100} placeholder="جستجو در عنوان، شماره، فرستنده یا تاریخ…" aria-label="جستجو در قراردادهای من" className="input !pr-11" />
        </div>
        <button className="btn-primary">جستجو</button>
        {query && <Link href={link({ keepQuery: false })} className="btn-secondary"><X size={14} />پاک‌کردن جستجو</Link>}
      </form>

      <nav aria-label="دسته‌بندی قراردادها" className="inline-flex flex-wrap gap-1 rounded-2xl bg-stone-100 p-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={link({ status: t.key })}
            aria-current={filter === t.key ? "page" : undefined}
            className={`rounded-xl px-4 py-2.5 text-xs font-bold transition ${filter === t.key ? "bg-white text-ink shadow-sm" : "text-ink/72 hover:text-ink"}`}
          >
            {t.label}
            <span className="mr-1.5 opacity-60">{fn(countOf(t.key))}</span>
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="panel-solid grid place-items-center px-6 py-16 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-stone-100 text-ink/72">{filter === "my_turn" && !query && hasAny ? <PartyPopper size={24} /> : <FileText size={24} />}</span>
          {query ? (
            <>
              <p className="mt-4 text-sm font-bold">برای «{query}» قراردادی پیدا نشد</p>
              {(() => {
                const other = TABS.find((t) => t.key !== filter && countOf(t.key) > 0);
                return other ? (
                  <Link href={link({ status: other.key })} className="btn-primary mt-4">{fn(countOf(other.key))} نتیجه در «{other.label}» ببینید</Link>
                ) : (
                  <p className="mt-1 text-xs text-ink/72">املای دیگری را امتحان کنید یا بخشی از شماره‌ی قرارداد را بنویسید.</p>
                );
              })()}
              <Link href={link({ keepQuery: false })} className="btn-secondary mt-3">پاک‌کردن جستجو</Link>
            </>
          ) : filter === "my_turn" && hasAny ? (
            <>
              <p className="mt-4 text-sm font-bold">فعلاً هیچ قراردادی منتظر امضای شما نیست</p>
              <Link href={basePath} className="btn-secondary mt-4">دیدن همه‌ی قراردادها</Link>
            </>
          ) : hasAny ? (
            <>
              <p className="mt-4 text-sm font-bold">در این دسته قراردادی نیست</p>
              <Link href={basePath} className="btn-secondary mt-4">دیدن همه‌ی قراردادها</Link>
            </>
          ) : (
            <>
              <p className="mt-4 text-sm font-bold">قراردادی برای نمایش وجود ندارد</p>
              <p className="mt-1 text-xs text-ink/72">وقتی قراردادی برای شما صادر شود، اینجا نمایش داده می‌شود.</p>
            </>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {rows.map((c) => (
            <Link
              key={c.id}
              href={`/contracts/${c.id}`}
              className={`group flex flex-wrap items-center gap-4 rounded-3xl border bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-[0_18px_44px_rgba(16,44,49,.08)] ${c.state === "my_turn" ? "border-mint ring-4 ring-mint/15" : "border-ink/10"}`}
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-stone-100 text-ink/75 transition group-hover:bg-ink group-hover:text-mint">
                <FileText size={19} />
              </span>
              <div className="min-w-0 flex-1">
                <b className="block truncate text-sm">{c.title}</b>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink/72">
                  <span dir="ltr" className="font-mono">{c.number}</span>
                  {c.workspaceName && <span>فرستنده: {c.workspaceName}</span>}
                  <span>صدور: {fa(c.issuedAt)}</span>
                  <span>نقش شما: {c.myLabel}</span>
                  {c.signedAt && <span>تکمیل: {fa(c.signedAt)}</span>}
                </div>
              </div>
              <StatusBadge status={c.state === "signed" && c.status !== "signed" ? "pending" : c.state === "signed" ? "signed" : c.state} />
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-ink/10 text-ink/72 transition group-hover:bg-ink group-hover:text-mint">
                <ArrowUpLeft size={15} />
              </span>
            </Link>
          ))}
        </div>
      )}

      {pages > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label="صفحه‌بندی">
          {current > 1 && <Link href={link({ page: current - 1 })} className="btn-secondary btn-sm"><ChevronRight size={14} />قبلی</Link>}
          <span className="rounded-xl bg-white px-3 py-2 text-xs font-bold">{fn(current)} / {fn(pages)}</span>
          {current < pages && <Link href={link({ page: current + 1 })} className="btn-secondary btn-sm">بعدی<ChevronLeft size={14} /></Link>}
        </nav>
      )}
    </div>
  );
}
