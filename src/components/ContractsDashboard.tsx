import Link from "next/link";
import { ArrowUpLeft, CheckCircle2, Clock3, FileText, PenLine } from "lucide-react";
import { listContractsForUser, type UserFilter } from "@/modules/contracts/service";
import StatusBadge from "@/components/StatusBadge";
import { fa } from "@/lib/jalali";

const TABS: { key: UserFilter; label: string }[] = [
  { key: "all", label: "همه قراردادها" },
  { key: "pending", label: "در انتظار امضا" },
  { key: "signed", label: "امضا شده" },
];

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

/** معادل شورت‌کد [contracts_dashboard]: قابل استفاده در هر صفحه (و از طریق /embed/dashboard در سایت‌های دیگر) */
export default async function ContractsDashboard({
  userId,
  filter,
  basePath = "/dashboard",
}: {
  userId: number;
  filter: UserFilter;
  basePath?: string;
}) {
  const rows = await listContractsForUser(userId, filter);
  const all = filter === "all" ? rows : await listContractsForUser(userId, "all");
  const myTurn = all.filter((r) => r.state === "my_turn").length;
  const signed = all.filter((r) => r.state === "signed").length;
  const waiting = all.filter((r) => r.state === "waiting").length;

  const stats = [
    { label: "نوبت امضای شما", value: myTurn, icon: PenLine, color: "bg-mint/30" },
    { label: "در انتظار دیگران", value: waiting, icon: Clock3, color: "bg-amber-100" },
    { label: "امضا شده", value: signed, icon: CheckCircle2, color: "bg-emerald-100" },
  ];

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="panel-solid flex items-center gap-4 p-5">
            <span className={`grid h-12 w-12 place-items-center rounded-2xl ${s.color}`}><s.icon size={21} /></span>
            <div>
              <b className="block text-2xl font-black">{fn(s.value)}</b>
              <span className="text-xs font-semibold text-ink/75">{s.label}</span>
            </div>
          </div>
        ))}
      </section>

      <div className="inline-flex flex-wrap gap-1 rounded-2xl bg-stone-100 p-1.5">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`${basePath}?status=${t.key}`}
            aria-current={filter === t.key ? "page" : undefined}
            className={`rounded-xl px-4 py-2.5 text-xs font-bold transition ${filter === t.key ? "bg-white text-ink shadow-sm" : "text-ink/72 hover:text-ink"}`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="panel-solid grid place-items-center px-6 py-16 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-stone-100 text-ink/72"><FileText size={24} /></span>
          <p className="mt-4 text-sm font-bold">قراردادی برای نمایش وجود ندارد</p>
          <p className="mt-1 text-xs text-ink/72">وقتی قراردادی برای شما صادر شود، اینجا نمایش داده می‌شود.</p>
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
    </div>
  );
}
