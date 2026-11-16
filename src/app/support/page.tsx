import Link from "next/link";
import { LifeBuoy, Plus } from "lucide-react";
import Shell from "@/components/Shell";
import { PriorityBadge, TicketStatusBadge } from "@/components/TicketBits";
import { requireUser } from "@/modules/auth/session";
import { listUserTickets } from "@/modules/tickets/service";
import { CATEGORIES } from "@/modules/tickets/meta";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const user = await requireUser();
  const rows = await listUserTickets(user.id);
  return (
    <Shell user={user}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black">پشتیبانی</h1>
        <Link href="/support/new" className="btn-primary"><Plus size={15} />تیکت جدید</Link>
      </div>
      {rows.length === 0 ? (
        <div className="card grid place-items-center gap-3 py-14 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-stone-100 text-ink/72"><LifeBuoy size={26} /></span>
          <b>هنوز تیکتی ثبت نکرده‌اید</b>
          <p className="max-w-sm text-xs leading-7 text-stone-600">برای هر سؤال یا مشکل، تیکت بزنید. وضعیت و پاسخ‌ها همین‌جا و با ایمیل به شما اطلاع داده می‌شود.</p>
          <Link href="/support/new" className="btn-primary">ثبت اولین تیکت</Link>
        </div>
      ) : (
        <div className="card overflow-x-auto !p-0">
          <table className="w-full min-w-[640px]">
            <thead className="bg-stone-50">
              <tr><th className="th">شماره</th><th className="th">موضوع</th><th className="th">دسته</th><th className="th">اولویت</th><th className="th">وضعیت</th><th className="th">آخرین به‌روزرسانی</th></tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-t border-stone-100 hover:bg-stone-50/60">
                  <td className="td font-mono text-xs" dir="ltr">{t.number}</td>
                  <td className="td max-w-[320px]">
                    <Link href={`/support/${t.id}`} className="font-bold hover:underline">{t.subject}</Link>
                    {t.status !== "closed" && t.lastReplyBy === "staff" && <span className="badge mr-2 bg-emerald-50 text-emerald-700">پاسخ جدید</span>}
                  </td>
                  <td className="td text-xs">{CATEGORIES[t.category] ?? t.category}</td>
                  <td className="td"><PriorityBadge priority={t.priority} /></td>
                  <td className="td"><TicketStatusBadge status={t.status} /></td>
                  <td className="td whitespace-nowrap text-xs text-stone-600">{faTime(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
