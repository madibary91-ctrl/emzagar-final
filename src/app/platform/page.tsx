import Link from "next/link";
import { desc, gte, sql } from "drizzle-orm";
import { Bot, Building2, CreditCard, FileSignature, LifeBuoy, Star, Users } from "lucide-react";
import Shell from "@/components/Shell";
import { PriorityBadge, TicketStatusBadge } from "@/components/TicketBits";
import { db } from "@/db";
import { aiGenerations, contracts, users, workspaces } from "@/db/schema";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { platformRevenue } from "@/modules/billing/service";
import { queryTickets, ticketCounts, ticketSatisfaction } from "@/modules/tickets/service";
import { faTime } from "@/lib/jalali";
import { backupOverview } from "@/modules/backup/service";
import { runBackupNowAction, verifyBackupAction } from "@/modules/backup/actions";
import { DatabaseBackup, ShieldCheck } from "lucide-react";
import RecoveryKeyCard from "@/components/RecoveryKeyCard";

export const dynamic = "force-dynamic";

const count = async (table: typeof users | typeof workspaces | typeof contracts) => {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return r?.n ?? 0;
};

/** نمای کلی پلتفرم برای مدیر کل: کاربران، فضاهای کاری، قراردادها، پشتیبانی و مصرف هوش مصنوعی */
export default async function PlatformHome({ searchParams }: { searchParams: Promise<{ backup?: string }> }) {
  const { backup } = await searchParams;
  const admin = await requirePlatformAdmin();
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const [nUsers, nWs, nContracts, tc, sat, recent, wsRows, ai, rev] = await Promise.all([
    count(users),
    count(workspaces),
    count(contracts),
    ticketCounts(),
    ticketSatisfaction(),
    queryTickets({ waiting: true }),
    db.select().from(workspaces).orderBy(desc(workspaces.createdAt)).limit(8),
    db.select({ n: sql<number>`count(*)::int`, tokens: sql<number>`coalesce(sum(${aiGenerations.tokens}),0)::int` }).from(aiGenerations).where(gte(aiGenerations.createdAt, since)),
    platformRevenue(),
  ]);
  const bk = await backupOverview();
  const fa = (n: number) => n.toLocaleString("fa-IR");
  const bkMsg: Record<string, [string, string]> = {
    ok: ["بک‌آپ با موفقیت ساخته و صحت آن تأیید شد.", "emerald"],
    verified: ["آخرین بک‌آپ سالم است (هش همه‌ی فایل‌ها مطابقت دارد).", "emerald"],
    failed: ["ساخت بک‌آپ ناموفق بود؛ جزئیات در «آخرین اجرا» نمایش داده می‌شود.", "rose"],
    corrupt: ["هشدار: آخرین بک‌آپ ناسالم است!", "rose"],
    none: ["هنوز هیچ بک‌آپ کاملی وجود ندارد.", "amber"],
    limited: ["تعداد درخواست‌ها زیاد است؛ بعداً تلاش کنید.", "amber"],
  };
  const msg = backup ? bkMsg[backup] : undefined;
  const cards = [
    { icon: Users, label: "کاربران", value: fa(nUsers) },
    { icon: Building2, label: "فضاهای کاری", value: fa(nWs) },
    { icon: FileSignature, label: "قراردادها", value: fa(nContracts) },
    { icon: LifeBuoy, label: "تیکت باز / منتظر پاسخ", value: `${fa(tc.open + tc.in_progress)} / ${fa(tc.waiting)}` },
    { icon: Bot, label: "تولید AI در ۷ روز", value: fa(ai[0]?.n ?? 0), hint: `${fa(ai[0]?.tokens ?? 0)} توکن` },
    { icon: CreditCard, label: "درآمد این ماه (تومان)", value: fa(rev.month), hint: `کل: ${fa(rev.total)}` },
    { icon: Users, label: "اشتراک‌های فعال پولی", value: fa(rev.paying) },
    { icon: Star, label: "رضایت پشتیبانی", value: sat.avg ? `${sat.avg.toLocaleString("fa-IR")} از ۵` : "—", hint: `${fa(sat.n)} نظر` },
  ];
  return (
    <Shell user={admin} wide>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-black">مدیریت پلتفرم</h1>
        <Link href="/platform/tickets" className="btn-primary"><LifeBuoy size={15} />صندوق تیکت‌ها</Link>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="card flex items-center gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-ink text-mint"><c.icon size={20} /></span>
            <div className="min-w-0"><p className="text-xs text-stone-600">{c.label}</p><b className="text-xl">{c.value}</b>{c.hint && <span className="mr-2 text-xs text-stone-600">{c.hint}</span>}</div>
          </div>
        ))}
      </div>
      <section className="card mb-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-bold"><DatabaseBackup size={18} />بک‌آپ دیتابیس، امضاها/PDFها، مدارک KYC و کلید امنیتی</h2>
          <div className="flex flex-wrap gap-2">
            <form action={verifyBackupAction}><button className="btn-secondary btn-sm"><ShieldCheck size={14} />بررسی صحت آخرین بک‌آپ</button></form>
            <form action={runBackupNowAction}><button className="btn-primary btn-sm">بک‌آپ فوری</button></form>
          </div>
        </div>
        {msg && <p role="alert" className={`rounded-xl border p-3 text-xs ${msg[1] === "emerald" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : msg[1] === "rose" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}>{msg[0]}</p>}
        <p className="text-xs leading-7 text-stone-600">
          {bk.cfg.enabled ? `بک‌آپ خودکار هر ${fa(bk.cfg.intervalHours)} ساعت و نگهداری ${fa(bk.cfg.keep)} نسخه‌ی آخر.` : "بک‌آپ خودکار خاموش است (BACKUP_ENABLED=0)."}
          {" "}آخرین اجرا: {bk.last ? <>{faTime(bk.last.at)} — {bk.last.ok ? "موفق" : <b className="text-rose-600">ناموفق: {bk.last.error}</b>}</> : "—"}
        </p>
        <RecoveryKeyCard
          configured={bk.recovery.configured}
          fingerprint={bk.recovery.fingerprint}
          fromEnv={bk.recovery.fromEnv}
          insideDataVolume={bk.insideDataVolume}
          mirrorCount={bk.mirrorCount}
          warnings={bk.last?.warnings ?? []}
          mirrorErrors={bk.last?.mirrorErrors ?? []}
        />
        {bk.list.length > 0 && (
          <ul className="grid gap-1 text-xs text-stone-600 sm:grid-cols-2">
            {bk.list.map((b) => (<li key={b.name} className="flex justify-between gap-3 rounded-lg bg-stone-50 px-3 py-1.5"><span dir="ltr" className="font-mono">{b.name}</span><span>{b.ok ? faTime(b.createdAt) : "ناتمام"}</span></li>))}
          </ul>
        )}
      </section>
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="card overflow-x-auto !p-0">
          <h2 className="p-5 pb-3 font-bold">تیکت‌های منتظر پاسخ</h2>
          <table className="w-full min-w-[480px]"><tbody>
            {recent.rows.slice(0, 8).map(({ ticket: t, userName }) => (
              <tr key={t.id} className="border-t border-stone-100">
                <td className="td"><Link href={`/platform/tickets/${t.id}`} className="font-bold hover:underline">{t.subject}</Link><span className="block text-xs text-stone-600">{userName} · {faTime(t.updatedAt)}</span></td>
                <td className="td"><PriorityBadge priority={t.priority} /></td><td className="td"><TicketStatusBadge status={t.status} /></td>
              </tr>
            ))}
            {recent.rows.length === 0 && <tr><td className="td py-10 text-center text-stone-600">همه‌ی تیکت‌ها پاسخ داده شده‌اند 🎉</td></tr>}
          </tbody></table>
        </section>
        <section className="card overflow-x-auto !p-0">
          <h2 className="p-5 pb-3 font-bold">جدیدترین فضاهای کاری</h2>
          <table className="w-full min-w-[420px]"><tbody>
            {wsRows.map((w) => (
              <tr key={w.id} className="border-t border-stone-100"><td className="td font-bold">{w.name}</td><td className="td font-mono text-xs" dir="ltr">{w.slug}</td><td className="td text-xs text-stone-600">{faTime(w.createdAt)}</td></tr>
            ))}
          </tbody></table>
        </section>
      </div>
    </Shell>
  );
}
