import Link from "next/link";
import { notFound } from "next/navigation";
import { Star } from "lucide-react";
import Shell from "@/components/Shell";
import { PriorityBadge, TicketStatusBadge, TicketThread } from "@/components/TicketBits";
import { CustomerReplyForm } from "@/components/TicketForms";
import { requireUser } from "@/modules/auth/session";
import { getTicketForOwner } from "@/modules/tickets/service";
import { customerCloseAction } from "@/modules/tickets/actions";
import { CATEGORIES } from "@/modules/tickets/meta";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const data = await getTicketForOwner(user.id, id);
  if (!data) notFound();
  const { ticket: t, messages } = data;
  return (
    <Shell user={user}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-stone-600" dir="ltr">{t.number}</p>
          <h1 className="break-words text-xl font-black sm:text-2xl">{t.subject}</h1>
        </div>
        <Link href="/support" className="btn-secondary">همه‌ی تیکت‌ها</Link>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
        <TicketStatusBadge status={t.status} />
        <PriorityBadge priority={t.priority} />
        <span className="badge bg-stone-100">{CATEGORIES[t.category] ?? t.category}</span>
        <span className="text-stone-600">ثبت: {faTime(t.createdAt)}</span>
        {t.rating && <span className="badge bg-amber-50 text-amber-700"><Star size={12} /> امتیاز شما: {t.rating.toLocaleString("fa-IR")}</span>}
      </div>

      <div className="max-w-4xl space-y-5">
        <TicketThread messages={messages} />
        {t.status === "closed" ? (
          <>
            <p className="rounded-2xl bg-stone-100 p-4 text-center text-xs text-stone-600">این تیکت بسته شده است. اگر هنوز مشکل دارید، پیام بفرستید تا دوباره باز شود.</p>
            <CustomerReplyForm ticketId={t.id} closed />
          </>
        ) : (
          <>
            <CustomerReplyForm ticketId={t.id} closed={false} />
            <form action={customerCloseAction} className="card flex flex-wrap items-center gap-3">
              <input type="hidden" name="ticketId" value={t.id} />
              <span className="text-xs font-bold">مشکل حل شد؟ تیکت را ببندید و امتیاز دهید:</span>
              <select name="rating" defaultValue="" className="input !min-h-10 !w-auto" aria-label="امتیاز">
                <option value="">بدون امتیاز</option>
                {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n.toLocaleString("fa-IR")} ستاره</option>)}
              </select>
              <button className="btn-secondary">بستن تیکت</button>
            </form>
          </>
        )}
      </div>
    </Shell>
  );
}
