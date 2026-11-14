import { sql } from "drizzle-orm";
import { db } from "@/db";

/** ساعت/تاریخ تهران از ستون‌های timestamp (ذخیره‌شده به UTC) */
const TEH = (col: string) => `((${col} at time zone 'UTC') at time zone 'Asia/Tehran')`;

export interface Insights {
  funnel: { issued: number; opened: number; signed: number };
  daily: { day: string; issued: number; signed: number }[];
  hours: number[];
  aging: { label: string; count: number }[];
  slowest: { id: number; number: string; title: string; days: number }[];
  kpi: { medianHours: number | null; conv7d: number | null; pendingValue: number; signedValue30: number; reminded: number };
  tips: string[];
}

export async function getInsights(workspaceId: number): Promise<Insights> {
  const ws = sql`${workspaceId}`;

  const funnelQ = db.execute<{ issued: number; opened: number; signed: number }>(sql`
    select count(*) filter (where c.status <> 'draft')::int as issued,
           count(*) filter (where c.status <> 'draft' and (c.status = 'signed' or exists (select 1 from short_links s where s.contract_id = c.id and s.clicks > 0)))::int as opened,
           count(*) filter (where c.status = 'signed')::int as signed
    from contracts c where c.workspace_id = ${ws} and c.issued_at >= now() - interval '90 days'`);

  const dailyQ = db.execute<{ day: string; issued: number; signed: number }>(sql`
    select to_char(d::date, 'YYYY-MM-DD') as day,
      (select count(*)::int from contracts c where c.workspace_id = ${ws} and c.status <> 'draft' and ${sql.raw(TEH("c.issued_at"))}::date = d::date) as issued,
      (select count(*)::int from contracts c where c.workspace_id = ${ws} and c.status = 'signed' and ${sql.raw(TEH("c.signed_at"))}::date = d::date) as signed
    from generate_series((now() at time zone 'Asia/Tehran')::date - 29, (now() at time zone 'Asia/Tehran')::date, interval '1 day') d
    order by d`);

  const hoursQ = db.execute<{ h: number; n: number }>(sql`
    select extract(hour from ${sql.raw(TEH("c.signed_at"))})::int as h, count(*)::int as n
    from contracts c where c.workspace_id = ${ws} and c.status = 'signed' and c.signed_at is not null group by 1`);

  const agingQ = db.execute<{ b: number; n: number }>(sql`
    select case when now() - c.issued_at < interval '1 day' then 0
                when now() - c.issued_at < interval '3 days' then 1
                when now() - c.issued_at < interval '7 days' then 2 else 3 end as b, count(*)::int as n
    from contracts c where c.workspace_id = ${ws} and c.status = 'sent' group by 1`);

  const slowQ = db.execute<{ id: number; number: string; title: string; days: number }>(sql`
    select c.id, c.number, c.title, floor(extract(epoch from (now() - c.issued_at)) / 86400)::int as days
    from contracts c where c.workspace_id = ${ws} and c.status = 'sent' order by c.issued_at asc limit 6`);

  const kpiQ = db.execute<{ median: number | null; conv_total: number; conv_ok: number; pending_value: number; signed_value: number; reminded: number }>(sql`
    select
      (select percentile_cont(0.5) within group (order by extract(epoch from (signed_at - issued_at)) / 3600)
         from contracts where workspace_id = ${ws} and status = 'signed' and signed_at is not null) as median,
      (select count(*)::int from contracts where workspace_id = ${ws} and status <> 'draft' and issued_at between now() - interval '90 days' and now() - interval '8 days') as conv_total,
      (select count(*)::int from contracts where workspace_id = ${ws} and status = 'signed' and issued_at between now() - interval '90 days' and now() - interval '8 days' and signed_at <= issued_at + interval '7 days') as conv_ok,
      coalesce((select sum(o.amount) from orders o join contracts c on c.id = o.contract_id where c.workspace_id = ${ws} and c.status = 'sent'), 0)::bigint as pending_value,
      coalesce((select sum(o.amount) from orders o join contracts c on c.id = o.contract_id where c.workspace_id = ${ws} and c.status = 'signed' and c.signed_at >= now() - interval '30 days'), 0)::bigint as signed_value,
      (select count(*)::int from contracts where workspace_id = ${ws} and status = 'sent' and reminder_count > 0) as reminded`);

  const [f, d, h, a, s, k] = await Promise.all([funnelQ, dailyQ, hoursQ, agingQ, slowQ, kpiQ]);
  const funnel = f.rows[0] ?? { issued: 0, opened: 0, signed: 0 };
  const hours = Array.from({ length: 24 }, () => 0);
  for (const r of h.rows) if (r.h >= 0 && r.h < 24) hours[r.h] = Number(r.n);
  const agingLabels = ["کمتر از ۱ روز", "۱ تا ۳ روز", "۳ تا ۷ روز", "بیش از ۷ روز"];
  const aging = agingLabels.map((label, i) => ({ label, count: Number(a.rows.find((r) => Number(r.b) === i)?.n ?? 0) }));
  const kr = k.rows[0];
  const kpi = {
    medianHours: kr?.median !== null && kr?.median !== undefined ? Number(kr.median) : null,
    conv7d: kr && Number(kr.conv_total) >= 3 ? Math.round((Number(kr.conv_ok) / Number(kr.conv_total)) * 100) : null,
    pendingValue: Number(kr?.pending_value ?? 0),
    signedValue30: Number(kr?.signed_value ?? 0),
    reminded: Number(kr?.reminded ?? 0),
  };

  // توصیه‌های خودکار بر پایه‌ی داده‌ها
  const tips: string[] = [];
  const stale = aging[3].count + aging[2].count;
  if (stale > 0) tips.push(`${stale} قرارداد بیش از ۳ روز بی‌پاسخ مانده‌اند؛ از «عملیات گروهی ← یادآوری» برای پیگیری استفاده کنید.`);
  if (kpi.conv7d !== null && kpi.conv7d < 50) tips.push(`فقط ${kpi.conv7d}٪ قراردادها در ۷ روز اول امضا می‌شوند. کوتاه‌کردن متن، لینک رمزدار ساده‌تر و یادآوری خودکار را بررسی کنید.`);
  const peak = hours.reduce((bi, v, i, arr) => (v > arr[bi] ? i : bi), 0);
  if (hours[peak] >= 3) tips.push(`بیشترین امضاها حدود ساعت ${new Intl.NumberFormat("fa-IR").format(peak)} انجام می‌شود؛ ارسال قراردادها کمی قبل از این ساعت نرخ امضا را بالا می‌برد.`);
  if (funnel.issued >= 5 && funnel.opened / Math.max(1, funnel.issued) < 0.6) tips.push("بیش از ۴۰٪ لینک‌ها هرگز باز نشده‌اند؛ پیام ارسال (ایمیل/پیامک) و آدرس درست مشتری را بررسی کنید.");
  if (funnel.opened > 0 && funnel.signed / funnel.opened < 0.6) tips.push("بسیاری از مشتریان لینک را باز می‌کنند اما امضا نمی‌کنند؛ متن را با «تحلیل ریسک» بازبینی و بندهای مبهم را ساده کنید.");
  if (tips.length === 0) tips.push(funnel.issued === 0 ? "با صدور اولین قراردادها، توصیه‌های هوشمند اینجا ظاهر می‌شود." : "روند امضای شما سالم است؛ همین الگو را حفظ کنید.");

  return { funnel, daily: d.rows.map((r) => ({ day: r.day, issued: Number(r.issued), signed: Number(r.signed) })), hours, aging, slowest: s.rows.map((r) => ({ ...r, days: Number(r.days) })), kpi, tips };
}
