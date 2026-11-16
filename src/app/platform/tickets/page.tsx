import Link from "next/link";
import Shell from "@/components/Shell";
import { PriorityBadge, TicketStatusBadge } from "@/components/TicketBits";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { queryTickets, ticketCounts } from "@/modules/tickets/service";
import { CATEGORIES, PRIORITIES } from "@/modules/tickets/meta";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
type SP = { status?: string; priority?: string; category?: string; q?: string; waiting?: string; page?: string };

export default async function PlatformTickets({ searchParams }: { searchParams: Promise<SP> }) {
  const admin = await requirePlatformAdmin();
  const sp = await searchParams;
  const status = ["open", "in_progress", "closed"].includes(sp.status || "") ? sp.status! : "all";
  const q = (sp.q || "").trim().slice(0, 100);
  const priority = sp.priority && sp.priority in PRIORITIES ? sp.priority : undefined;
  const category = sp.category && sp.category in CATEGORIES ? sp.category : undefined;
  const waiting = sp.waiting === "1";
  const [counts, list] = await Promise.all([
    ticketCounts(),
    queryTickets({ status, priority, category, q, waiting, page: Number(sp.page) || 1 }),
  ]);
  const tabs = [
    { id: "all", label: "همه", n: counts.total },
    { id: "open", label: "باز", n: counts.open },
    { id: "in_progress", label: "در حال بررسی", n: counts.in_progress },
    { id: "closed", label: "بسته", n: counts.closed },
  ];
  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = { status: status === "all" ? undefined : status, priority, category, q: q || undefined, waiting: waiting ? "1" : undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/platform/tickets${s ? `?${s}` : ""}`;
  };
  return (
    <Shell user={admin} wide>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black">مدیریت تیکت‌ها</h1>
        <Link href={href({ waiting: waiting ? undefined : "1", page: undefined })} className={waiting ? "btn-primary" : "btn-secondary"}>
          منتظر پاسخ ما ({counts.waiting.toLocaleString("fa-IR")})
        </Link>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <Link key={t.id} href={href({ status: t.id === "all" ? undefined : t.id, page: undefined })} className={`btn ${status === t.id ? "btn-primary" : "btn-secondary"}`}>
            {t.label} <span className="opacity-60">{t.n.toLocaleString("fa-IR")}</span>
          </Link>
        ))}
      </div>
      <form className="card mb-4 flex flex-wrap items-end gap-3" action="/platform/tickets">
        {status !== "all" && <input type="hidden" name="status" value={status} />}
        <div className="min-w-[200px] flex-1"><label htmlFor="q" className="label">جستجو</label><input id="q" name="q" defaultValue={q} className="input" placeholder="موضوع، شماره، نام یا ایمیل" /></div>
        <div><label htmlFor="priority" className="label">اولویت</label>
          <select id="priority" name="priority" defaultValue={priority || ""} className="input"><option value="">همه</option>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
        <div><label htmlFor="category" className="label">دسته</label>
          <select id="category" name="category" defaultValue={category || ""} className="input"><option value="">همه</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <button className="btn-primary">اعمال</button>
      </form>
      <div className="card overflow-x-auto !p-0">
        <table className="w-full min-w-[820px]">
          <thead className="bg-stone-50"><tr><th className="th">شماره</th><th className="th">موضوع</th><th className="th">کاربر</th><th className="th">فضای کاری</th><th className="th">دسته</th><th className="th">اولویت</th><th className="th">وضعیت</th><th className="th">به‌روزرسانی</th></tr></thead>
          <tbody>
            {list.rows.map(({ ticket: t, userName, userEmail, workspaceName }) => (
              <tr key={t.id} className="border-t border-stone-100 hover:bg-stone-50/60">
                <td className="td font-mono text-xs" dir="ltr">{t.number}</td>
                <td className="td max-w-[280px]">
                  <Link href={`/platform/tickets/${t.id}`} className="font-bold hover:underline">{t.subject}</Link>
                  {t.status !== "closed" && t.lastReplyBy === "customer" && <span className="badge mr-2 bg-rose-50 text-rose-700">منتظر پاسخ</span>}
                </td>
                <td className="td text-xs"><b className="block">{userName}</b><span className="text-stone-600" dir="ltr">{userEmail}</span></td>
                <td className="td text-xs">{workspaceName ?? "—"}</td>
                <td className="td text-xs">{CATEGORIES[t.category] ?? t.category}</td>
                <td className="td"><PriorityBadge priority={t.priority} /></td>
                <td className="td"><TicketStatusBadge status={t.status} /></td>
                <td className="td whitespace-nowrap text-xs text-stone-600">{faTime(t.updatedAt)}</td>
              </tr>
            ))}
            {list.rows.length === 0 && <tr><td colSpan={8} className="td py-12 text-center text-stone-600">تیکتی با این فیلتر پیدا نشد.</td></tr>}
          </tbody>
        </table>
      </div>
      {list.pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-xs">
          {list.page > 1 && <Link className="btn-secondary btn-sm" href={href({ page: String(list.page - 1) })}>قبلی</Link>}
          <span>صفحه {list.page.toLocaleString("fa-IR")} از {list.pages.toLocaleString("fa-IR")}</span>
          {list.page < list.pages && <Link className="btn-secondary btn-sm" href={href({ page: String(list.page + 1) })}>بعدی</Link>}
        </div>
      )}
    </Shell>
  );
}
