import { and, eq, gte, sql } from "drizzle-orm";
import { BarChart3, Sparkles } from "lucide-react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { db } from "@/db";
import { aiGenerations } from "@/db/schema";
import { requireTeam } from "@/modules/tenancy/context";
import { adminStats, reportData } from "@/modules/contracts/service";
import { fa } from "@/lib/jalali";

export const dynamic = "force-dynamic";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const month = (m: string) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { month: "long", year: "numeric" }).format(new Date(`${m}-15T12:00:00`));
const hours = (h: number | null) => (h === null ? "—" : h < 1 ? "کمتر از ۱ ساعت" : h < 48 ? `${fn(Math.round(h))} ساعت` : `${fn(Math.round(h / 24))} روز`);

/** گزارش‌های مدیریتی: روند ماهانه، عملکرد قالب‌ها، قراردادهای معطل و مصرف هوش مصنوعی */
export default async function ReportsPage() {
  const admin = await requireTeam("view");
  const [stats, data, [ai]] = await Promise.all([
    adminStats(admin.workspaceId),
    reportData(admin.workspaceId),
    db
      .select({ n: sql<number>`count(*)::int`, tokens: sql<number>`coalesce(sum(${aiGenerations.tokens}),0)::int` })
      .from(aiGenerations)
      .where(and(eq(aiGenerations.workspaceId, admin.workspaceId), eq(aiGenerations.status, "ok"), gte(aiGenerations.createdAt, new Date(Date.now() - 30 * 86400_000)))),
  ]);
  const max = Math.max(1, ...data.monthly.map((m) => m.issued));

  return (
    <Shell user={admin} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><BarChart3 size={22} />گزارش‌ها</h1>
      <p className="mb-5 text-xs text-ink/72">عملکرد امضا در فضای کاری «{admin.workspaceName}»</p>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["قراردادهای ارسال‌شده", fn(stats.total)],
          ["امضا شده", `${fn(stats.signed)} (${fn(stats.rate)}٪)`],
          ["در انتظار امضا", fn(stats.pending)],
          ["میانگین زمان امضا", hours(stats.avgHours)],
        ].map(([l, v]) => (
          <div key={l} className="panel-solid p-5">
            <b className="block text-2xl font-black">{v}</b>
            <span className="text-xs font-semibold text-ink/75">{l}</span>
          </div>
        ))}
      </div>

      <section className="panel-solid mb-5 p-5">
        <h2 className="mb-4 font-bold">روند ۶ ماه اخیر</h2>
        {data.monthly.length === 0 ? (
          <p className="py-8 text-center text-xs text-ink/72">هنوز داده‌ای برای نمایش وجود ندارد.</p>
        ) : (
          <div className="flex h-56 items-end gap-3 overflow-x-auto sm:gap-6" role="img" aria-label="نمودار ستونی قراردادهای ماهانه">
            {data.monthly.map((m) => (
              <div key={m.month} className="flex min-w-[56px] flex-1 flex-col items-center gap-2">
                <div className="flex h-44 w-full items-end justify-center gap-1.5">
                  <div className="w-1/2 max-w-8 rounded-t-lg bg-ink/25" style={{ height: `${Math.max(4, (m.issued / max) * 100)}%` }} title={`صدور: ${m.issued}`} />
                  <div className="w-1/2 max-w-8 rounded-t-lg bg-mint" style={{ height: `${Math.max(4, (m.signed / max) * 100)}%` }} title={`امضا: ${m.signed}`} />
                </div>
                <span className="text-center text-xs font-semibold text-ink/75">{month(m.month)}</span>
                <span className="text-xs text-ink/72">{fn(m.issued)} / {fn(m.signed)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-4 text-xs text-ink/75">
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-ink/25" />صادرشده</span>
          <span className="flex items-center gap-1.5"><i className="h-3 w-3 rounded bg-mint" />امضاشده</span>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel-solid overflow-x-auto">
          <h2 className="px-5 pt-5 font-bold">عملکرد قالب‌ها</h2>
          <table className="w-full">
            <thead><tr><th className="th">قالب</th><th className="th">ارسال</th><th className="th">امضا</th><th className="th">میانگین زمان</th></tr></thead>
            <tbody>
              {data.byTemplate.map((t) => (
                <tr key={t.title} className="border-t border-ink/[.07]">
                  <td className="td font-bold">{t.title}</td>
                  <td className="td">{fn(t.total)}</td>
                  <td className="td">{fn(t.total ? Math.round((t.signed / t.total) * 100) : 0)}٪</td>
                  <td className="td text-xs">{hours(t.avgHours ? Number(t.avgHours) : null)}</td>
                </tr>
              ))}
              {data.byTemplate.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-xs text-ink/72">داده‌ای نیست.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="panel-solid overflow-x-auto">
          <h2 className="px-5 pt-5 font-bold">قدیمی‌ترین قراردادهای در انتظار امضا</h2>
          <table className="w-full">
            <tbody>
              {data.slowest.map((c) => (
                <tr key={c.id} className="border-t border-ink/[.07]">
                  <td className="td"><Link href={`/contracts/${c.id}`} className="font-bold hover:underline">{c.title}</Link><div className="text-xs text-ink/72">{c.userName}</div></td>
                  <td className="td whitespace-nowrap text-xs">از {fa(c.issuedAt)}</td>
                </tr>
              ))}
              {data.slowest.length === 0 && <tr><td className="py-10 text-center text-xs text-ink/72">قرارداد معطلی وجود ندارد 🎉</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel-solid mt-5 flex flex-wrap items-center gap-4 p-5">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-ink text-mint"><Sparkles size={19} /></span>
        <div>
          <b className="block">دستیار هوش مصنوعی — ۳۰ روز اخیر</b>
          <span className="text-xs text-ink/75">{fn(ai?.n ?? 0)} تولید متن • حدود {fn(ai?.tokens ?? 0)} توکن مصرف‌شده</span>
        </div>
      </section>
    </Shell>
  );
}
