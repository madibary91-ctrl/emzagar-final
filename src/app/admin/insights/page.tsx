import Link from "next/link";
import { Activity, Lightbulb, Gauge } from "lucide-react";
import Shell from "@/components/Shell";
import { requireTeam } from "@/modules/tenancy/context";
import { getInsights } from "@/modules/insights/service";

export const dynamic = "force-dynamic";

const fn = (n: number) => new Intl.NumberFormat("fa-IR").format(n);
const hoursLabel = (h: number | null) => (h === null ? "—" : h < 1 ? "کمتر از ۱ ساعت" : h < 48 ? `${fn(Math.round(h))} ساعت` : `${fn(Math.round(h / 24))} روز`);
const dayLabel = (d: string) => new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00Z`));

function LineChart({ data }: { data: { day: string; issued: number; signed: number }[] }) {
  const W = 600, H = 190, P = 24;
  const max = Math.max(3, ...data.flatMap((d) => [d.issued, d.signed]));
  const x = (i: number) => P + (i * (W - P * 2)) / Math.max(1, data.length - 1);
  const y = (v: number) => H - P - (v / max) * (H - P * 2);
  const path = (k: "issued" | "signed") => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d[k]).toFixed(1)}`).join(" ");
  const area = `${path("signed")} L${x(data.length - 1)} ${H - P} L${x(0)} ${H - P} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="نمودار خطی صدور و امضای ۳۰ روز اخیر">
      {[0, 0.5, 1].map((t) => (<line key={t} x1={P} x2={W - P} y1={y(max * t)} y2={y(max * t)} stroke="rgba(16,44,49,.08)" />))}
      <path d={area} fill="rgba(65,228,173,.18)" />
      <path d={path("issued")} fill="none" stroke="rgba(16,44,49,.45)" strokeWidth="2" strokeDasharray="5 4" />
      <path d={path("signed")} fill="none" stroke="#1fbf8c" strokeWidth="2.5" strokeLinejoin="round" />
      {[0, 14, 29].map((i) => data[i] && (<text key={i} x={x(i)} y={H - 4} textAnchor="middle" fontSize="10" fill="rgba(16,44,49,.5)">{dayLabel(data[i].day)}</text>))}
      <text x={P} y={12} fontSize="10" fill="rgba(16,44,49,.45)">{fn(max)}</text>
    </svg>
  );
}

/** هوش تجاری: قیف تبدیل، روند، ساعت‌های اوج، انباشت قراردادهای معطل و توصیه‌های خودکار */
export default async function InsightsPage() {
  const team = await requireTeam("view");
  const ins = await getInsights(team.workspaceId);
  const { funnel } = ins;
  const steps = [
    { label: "صادرشده", v: funnel.issued, c: "bg-ink/70" },
    { label: "باز شده توسط مشتری", v: funnel.opened, c: "bg-sky-500" },
    { label: "امضا شده", v: funnel.signed, c: "bg-mint" },
  ];
  const maxHour = Math.max(1, ...ins.hours);
  const maxAging = Math.max(1, ...ins.aging.map((a) => a.count));

  return (
    <Shell user={team} wide>
      <h1 className="mb-1 flex items-center gap-2 text-2xl font-black"><Activity size={22} />هوش تجاری</h1>
      <p className="mb-5 text-xs text-ink/72">تحلیل رفتار امضا در «{team.workspaceName}» (۹۰ روز اخیر)</p>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["میانه‌ی زمان امضا", hoursLabel(ins.kpi.medianHours)],
          ["نرخ امضا در ۷ روز اول", ins.kpi.conv7d === null ? "داده‌ی کافی نیست" : `${fn(ins.kpi.conv7d)}٪`],
          ["ارزش سفارش‌های منتظر امضا", `${fn(ins.kpi.pendingValue)} تومان`],
          ["ارزش امضاشده (۳۰ روز)", `${fn(ins.kpi.signedValue30)} تومان`],
        ].map(([l, v]) => (
          <div key={l} className="panel-solid p-5">
            <b className="block text-xl font-black">{v}</b>
            <span className="text-xs font-semibold text-ink/75">{l}</span>
          </div>
        ))}
      </div>

      <section className="mb-5 rounded-3xl border border-violet-200 bg-violet-50/60 p-5">
        <h2 className="mb-3 flex items-center gap-2 font-bold text-violet-900"><Lightbulb size={18} />توصیه‌های هوشمند</h2>
        <ul className="space-y-2 text-sm leading-7 text-violet-950">
          {ins.tips.map((t) => (<li key={t} className="flex gap-2"><span aria-hidden>•</span>{t}</li>))}
        </ul>
      </section>

      <div className="mb-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section className="panel-solid p-5">
          <h2 className="mb-3 font-bold">روند ۳۰ روز اخیر</h2>
          <LineChart data={ins.daily} />
          <div className="mt-2 flex gap-4 text-xs text-ink/75">
            <span className="flex items-center gap-1.5"><i className="h-0.5 w-5 border-t-2 border-dashed border-ink/50" />صادرشده</span>
            <span className="flex items-center gap-1.5"><i className="h-1 w-5 rounded bg-mint" />امضاشده</span>
          </div>
        </section>
        <section className="panel-solid p-5">
          <h2 className="mb-4 font-bold">قیف تبدیل</h2>
          <div className="space-y-4">
            {steps.map((s, i) => (
              <div key={s.label}>
                <div className="mb-1 flex justify-between text-[13px]"><span className="font-semibold">{s.label}</span><b>{fn(s.v)}{i > 0 && funnel.issued > 0 && <span className="mr-1 text-xs font-medium text-ink/72">({fn(Math.round((s.v / funnel.issued) * 100))}٪)</span>}</b></div>
                <div className="h-3 overflow-hidden rounded-full bg-ink/10"><div className={`h-full rounded-full ${s.c}`} style={{ width: `${funnel.issued ? Math.max(2, (s.v / funnel.issued) * 100) : 0}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel-solid p-5">
          <h2 className="mb-4 flex items-center gap-2 font-bold"><Gauge size={16} />ساعت‌های اوج امضا (وقت تهران)</h2>
          <div className="flex h-36 items-end gap-[3px]" role="img" aria-label="نمودار ستونی امضا بر حسب ساعت شبانه‌روز">
            {ins.hours.map((n, h) => (
              <div key={h} className="flex flex-1 flex-col items-center justify-end gap-1" title={`ساعت ${h}: ${n} امضا`}>
                <div className="w-full rounded-t bg-mint" style={{ height: `${n ? Math.max(6, (n / maxHour) * 100) : 2}%`, opacity: n ? 1 : 0.25 }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-ink/72" dir="ltr"><span>۰</span><span>۶</span><span>۱۲</span><span>۱۸</span><span>۲۳</span></div>
        </section>

        <section className="panel-solid p-5">
          <h2 className="mb-4 font-bold">قراردادهای منتظر امضا بر اساس مدت انتظار</h2>
          <div className="space-y-3">
            {ins.aging.map((a, i) => (
              <div key={a.label} className="flex items-center gap-3 text-[13px]">
                <span className="w-24 shrink-0 text-ink/75">{a.label}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-ink/10"><div className={`h-full rounded-full ${i >= 2 ? "bg-coral" : "bg-ink/40"}`} style={{ width: `${a.count ? Math.max(4, (a.count / maxAging) * 100) : 0}%` }} /></div>
                <b className="w-8 text-left">{fn(a.count)}</b>
              </div>
            ))}
          </div>
          {ins.slowest.length > 0 && (
            <ul className="mt-5 space-y-1.5 border-t border-ink/10 pt-4">
              {ins.slowest.map((c) => (
                <li key={c.id}>
                  <Link href={`/contracts/${c.id}`} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-[13px] hover:bg-ink/[.04]">
                    <span className="truncate"><span className="font-mono text-xs text-ink/72" dir="ltr">{c.number}</span> {c.title}</span>
                    <span className="shrink-0 text-[#bf4128]">{fn(c.days)} روز</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}
