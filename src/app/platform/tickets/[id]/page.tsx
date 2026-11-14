import Link from "next/link";
import { notFound } from "next/navigation";
import { Star } from "lucide-react";
import Shell from "@/components/Shell";
import { PriorityBadge, TicketStatusBadge, TicketThread } from "@/components/TicketBits";
import { StaffReplyForm } from "@/components/TicketForms";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { getTicketForStaff } from "@/modules/tickets/service";
import { CATEGORIES } from "@/modules/tickets/meta";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function PlatformTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requirePlatformAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const data = await getTicketForStaff(id);
  if (!data) notFound();
  const { ticket: t, messages } = data;
  return (
    <Shell user={admin}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-stone-600" dir="ltr">{t.number}</p>
          <h1 className="break-words text-xl font-black sm:text-2xl">{t.subject}</h1>
        </div>
        <Link href="/platform/tickets" className="btn-secondary">همه‌ی تیکت‌ها</Link>
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-5">
          <TicketThread messages={messages} staffView />
          <StaffReplyForm ticketId={t.id} status={t.status} />
        </div>
        <aside className="card h-fit space-y-3 text-xs">
          <h2 className="text-sm font-bold">اطلاعات تیکت</h2>
          <div className="flex flex-wrap gap-2"><TicketStatusBadge status={t.status} /><PriorityBadge priority={t.priority} /></div>
          <dl className="space-y-2.5">
            <div><dt className="text-stone-600">کاربر</dt><dd className="font-bold">{data.userName}</dd></div>
            <div><dt className="text-stone-600">ایمیل</dt><dd dir="ltr" className="break-all text-right">{data.userEmail}</dd></div>
            {data.userMobile && <div><dt className="text-stone-600">موبایل</dt><dd dir="ltr" className="text-right">{data.userMobile}</dd></div>}
            <div><dt className="text-stone-600">فضای کاری</dt><dd>{data.workspaceName ?? "—"}</dd></div>
            <div><dt className="text-stone-600">دسته‌بندی</dt><dd>{CATEGORIES[t.category] ?? t.category}</dd></div>
            <div><dt className="text-stone-600">ثبت</dt><dd>{faTime(t.createdAt)}</dd></div>
            {t.closedAt && <div><dt className="text-stone-600">بسته‌شدن</dt><dd>{faTime(t.closedAt)}</dd></div>}
            {t.rating && <div><dt className="text-stone-600">امتیاز رضایت</dt><dd className="flex items-center gap-1 font-bold"><Star size={13} className="text-amber-500" />{t.rating.toLocaleString("fa-IR")} از ۵</dd></div>}
          </dl>
        </aside>
      </div>
    </Shell>
  );
}
