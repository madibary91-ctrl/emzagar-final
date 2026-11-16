import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import Shell from "@/components/Shell";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { ACTION_LABELS, getRecentAudit } from "@/modules/audit/service";
import { faTime } from "@/lib/jalali";

export const dynamic = "force-dynamic";

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const admin = await requireTeam("view");
  const { tab = "audit" } = await searchParams;
  const audit = tab === "audit" ? await getRecentAudit(admin.workspaceId, 300) : [];
  const outbox = tab === "outbox" ? await db.select().from(notifications).where(eq(notifications.workspaceId, admin.workspaceId)).orderBy(desc(notifications.createdAt)).limit(200) : [];

  return (
    <Shell user={admin} wide>
      <h1 className="mb-4 text-2xl font-black">لاگ‌های سیستم</h1>
      <div className="mb-4 flex gap-2">
        <Link href="/admin/logs?tab=audit" className={`btn ${tab === "audit" ? "btn-primary" : "btn-secondary"}`}>لاگ تغییرات و امنیت</Link>
        <Link href="/admin/logs?tab=outbox" className={`btn ${tab === "outbox" ? "btn-primary" : "btn-secondary"}`}>ایمیل‌ها و پیامک‌ها</Link>
      </div>
      <div className="card overflow-x-auto !p-0">
        {tab === "audit" ? (
          <table className="w-full">
            <thead className="bg-stone-50">
              <tr>
                <th className="th">زمان</th><th className="th">رویداد</th><th className="th">کاربر</th>
                <th className="th">قرارداد</th><th className="th">IP</th><th className="th">User-Agent</th><th className="th">جزئیات</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-t border-stone-100 align-top">
                  <td className="td whitespace-nowrap text-xs">{faTime(a.createdAt)}</td>
                  <td className="td">{ACTION_LABELS[a.action] ?? a.action}</td>
                  <td className="td">{a.userName ?? "—"}</td>
                  <td className="td">{a.contractId ? <Link className="text-emerald-700 underline" href={`/contracts/${a.contractId}`}>#{a.contractId}</Link> : "—"}</td>
                  <td className="td font-mono text-xs" dir="ltr">{a.ip}</td>
                  <td className="td max-w-[220px] truncate text-xs text-stone-600" title={a.userAgent ?? ""} dir="ltr">{a.userAgent}</td>
                  <td className="td text-xs text-stone-600">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full">
            <thead className="bg-stone-50">
              <tr>
                <th className="th">زمان</th><th className="th">کانال</th><th className="th">گیرنده</th>
                <th className="th">موضوع / درگاه</th><th className="th">وضعیت</th><th className="th">خطا</th>
              </tr>
            </thead>
            <tbody>
              {outbox.map((n) => (
                <tr key={n.id} className="border-t border-stone-100">
                  <td className="td whitespace-nowrap text-xs">{faTime(n.createdAt)}</td>
                  <td className="td">{n.channel === "sms" ? "پیامک" : "ایمیل"}</td>
                  <td className="td font-mono text-xs" dir="ltr">{n.recipient}</td>
                  <td className="td text-xs">{n.subject}</td>
                  <td className="td text-xs">{n.status === "sent" ? "ارسال شد" : n.status === "logged" ? "ثبت در لاگ (بدون ارسال)" : "ناموفق"}</td>
                  <td className="td text-xs text-red-600">{n.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
