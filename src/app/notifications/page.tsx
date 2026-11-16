import Link from "next/link";
import { AlertTriangle, Bell, BellRing, CheckCheck, CheckCircle2, Info, ShieldAlert, Trash2 } from "lucide-react";
import Shell from "@/components/Shell";
import { requireUser } from "@/modules/auth/session";
import { listNotifications, unreadCount } from "@/modules/inbox/service";
import { deleteNotificationAction, markAllReadAction, markReadAction } from "@/modules/inbox/actions";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";
export const metadata = { title: "اعلان‌ها" };

const ICON = { success: CheckCircle2, warning: AlertTriangle, security: ShieldAlert, action: BellRing, info: Info } as const;
const TONE = { success: "text-emerald-700", warning: "text-amber-600", security: "text-rose-600", action: "text-sky-600", info: "text-ink/72" } as const;

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const user = await requireUser();
  const { filter } = await searchParams;
  const unreadOnly = filter === "unread";
  const [items, unread] = await Promise.all([listNotifications(user.id, { limit: 100, unreadOnly }), unreadCount(user.id)]);

  return (
    <Shell user={user}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black"><Bell size={22} />اعلان‌ها</h1>
          <p className="mt-1 text-xs text-ink/72">{unread > 0 ? `${unread.toLocaleString("fa-IR")} اعلان خوانده‌نشده` : "همه‌ی اعلان‌ها خوانده شده است"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/notifications" className={unreadOnly ? "btn-secondary btn-sm" : "btn-primary btn-sm"}>همه</Link>
          <Link href="/notifications?filter=unread" className={unreadOnly ? "btn-primary btn-sm" : "btn-secondary btn-sm"}>خوانده‌نشده</Link>
          <form action={markAllReadAction}>
            <button className="btn-secondary btn-sm" disabled={unread === 0}><CheckCheck size={14} />خوانده‌شدن همه</button>
          </form>
        </div>
      </div>

      <div className="panel-solid max-w-4xl overflow-hidden !p-0">
        {items.length === 0 && <p className="p-10 text-center text-sm text-ink/72">{unreadOnly ? "اعلان خوانده‌نشده‌ای ندارید." : "هنوز اعلانی دریافت نکرده‌اید."}</p>}
        <ul>
          {items.map((n) => {
            const kind = (n.kind in ICON ? n.kind : "info") as keyof typeof ICON;
            const Icon = ICON[kind];
            return (
              <li key={n.id} className={`flex items-start gap-3 border-b border-ink/[.06] p-4 last:border-0 ${n.readAt ? "" : "bg-sky-50/50"}`}>
                <span className={`mt-1 shrink-0 ${TONE[kind]}`}><Icon size={18} /></span>
                <div className="min-w-0 flex-1">
                  <b className="block text-sm leading-7">{n.href ? <Link href={n.href} className="hover:underline">{n.title}</Link> : n.title}</b>
                  {n.body && <p className="text-xs leading-7 text-ink/70">{n.body}</p>}
                  <span className="mt-1 block text-[11px] text-ink/72">{faTime(n.createdAt)}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!n.readAt && (
                    <form action={markReadAction}>
                      <input type="hidden" name="id" value={n.id} />
                      <button className="btn-ghost btn-sm" title="علامت‌گذاری به‌عنوان خوانده‌شده" aria-label="علامت‌گذاری به‌عنوان خوانده‌شده"><CheckCheck size={14} /></button>
                    </form>
                  )}
                  <form action={deleteNotificationAction}>
                    <input type="hidden" name="id" value={n.id} />
                    <button className="btn-ghost btn-sm" title="حذف" aria-label="حذف اعلان"><Trash2 size={14} /></button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Shell>
  );
}
