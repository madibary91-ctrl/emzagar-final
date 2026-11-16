import { type AttentionKind, MANUAL_HOURS_PER_CONTRACT, trustCode } from "./core";
import { adminStats } from "@/modules/contracts/service";
import { computeDepth } from "./depth";
import { db } from "@/db";
import { eq, sql } from "drizzle-orm";
import { getInsights } from "@/modules/insights/service";
import { parseFeatures } from "./features";
import { workspaces } from "@/db/schema";

export type AttentionItem = { id: number; number: string; title: string; kind: AttentionKind; ageDays: number; customer: string; hint: string; canRemind: boolean };
export async function getPulse(workspaceId: number, conn: { id: number; verified: boolean; syncEnabled: boolean; integrationJson: string; siteHost: string }) {
  const ws = sql`${workspaceId}`;
  const [insights, stats, attentionQ, renewalsQ, signedQ, wsRow, firstQ] = await Promise.all([
    getInsights(workspaceId),
    adminStats(workspaceId),
    db.execute<{ id: number; number: string; title: string; status: string; days: number; expires_hours: number | null; cname: string; reminders: number }>(sql`
      select c.id, c.number, c.title, c.status,
             floor(extract(epoch from (now() - c.issued_at)) / 86400)::int as days,
             case when c.expires_at is null then null else extract(epoch from (c.expires_at - now())) / 3600 end as expires_hours,
             coalesce(u.name, '') as cname, c.reminder_count as reminders
      from contracts c left join users u on u.id = c.customer_id
      where c.workspace_id = ${ws} and (
        (c.status = 'sent' and (c.issued_at < now() - interval '3 days' or (c.expires_at is not null and c.expires_at < now() + interval '48 hours')))
        or (c.status = 'rejected' and c.issued_at > now() - interval '30 days'))
      order by (c.status = 'sent') desc, c.expires_at asc nulls last, c.issued_at asc limit 12`),
    db.execute<{ id: number; number: string; title: string; ended: boolean; days: number; cname: string }>(sql`
      select c.id, c.number, c.title, (c.term_ends_at <= now()) as ended,
             floor(abs(extract(epoch from (c.term_ends_at - now()))) / 86400)::int as days, coalesce(u.name, '') as cname
      from contracts c left join users u on u.id = c.customer_id
      where c.workspace_id = ${ws} and c.status = 'signed' and c.term_ends_at is not null
        and c.term_ends_at - (c.renewal_notice_days || ' days')::interval <= now()
        and not exists (select 1 from contracts r where r.renewed_from_id = c.id)
      order by c.term_ends_at asc limit 6`),
    db.execute<{ n: number; hours: number | null; value: number; since: Date | null }>(sql`
      select count(*)::int as n,
             coalesce(sum(extract(epoch from (c.signed_at - c.issued_at)) / 3600), 0) as hours,
             coalesce(sum(coalesce(c.contract_value, o.amount)), 0)::bigint as value,
             min(c.signed_at) as since
      from contracts c left join orders o on o.contract_id = c.id
      where c.workspace_id = ${ws} and c.status = 'signed' and c.signed_at >= now() - interval '30 days'`),
    db.select({ slug: workspaces.slug, name: workspaces.name, createdAt: workspaces.createdAt }).from(workspaces).where(eq(workspaces.id, workspaceId)),
    db.execute<{ n: number }>(sql`select count(*)::int as n from contracts where workspace_id = ${ws} and status = 'signed'`),
  ]);

  const attention: AttentionItem[] = [];
  for (const r of attentionQ.rows) {
    const hrs = r.expires_hours === null ? null : Number(r.expires_hours);
    const expiring = hrs !== null && hrs <= 48;
    const rejected = r.status === "rejected";
    attention.push({
      id: r.id,
      number: r.number,
      title: r.title,
      kind: rejected ? "rejected" : expiring ? "expiring" : "stale",
      ageDays: Number(r.days),
      customer: r.cname,
      canRemind: r.status === "sent",
      hint: rejected ? "مشتری رد کرده؛ دلیل را بررسی و در صورت نیاز با اصلاح دوباره صادر کنید." : expiring ? (hrs! <= 0 ? "مهلت امضا در حال پایان است." : `کمتر از ${Math.max(1, Math.ceil(hrs! / 24))} روز تا انقضا`) : `${Number(r.days)} روز بی‌پاسخ`,
    });
  }
  for (const r of renewalsQ.rows) {
    attention.push({ id: r.id, number: r.number, title: r.title, kind: "renewal", ageDays: Number(r.days), customer: r.cname, canRemind: false, hint: r.ended ? `مدت قرارداد ${Number(r.days)} روز پیش تمام شده؛ تمدید کنید.` : `${Number(r.days)} روز تا پایان مدت؛ زمان تمدید است.` });
  }

  const s = signedQ.rows[0];
  const signed30 = Number(s?.n ?? 0);
  const daily = insights.daily.slice(-14);
  const hoursSavedManual = signed30 * MANUAL_HOURS_PER_CONTRACT;
  const f = parseFeatures(conn.integrationJson);
  const w = wsRow[0];

  return {
    workspace: w?.name ?? "",
    kpi: {
      pending: stats.pending,
      pendingValue: insights.kpi.pendingValue,
      signed30,
      signedValue30: insights.kpi.signedValue30,
      medianHours: insights.kpi.medianHours === null ? null : Math.round(insights.kpi.medianHours * 10) / 10,
      conv7d: insights.kpi.conv7d,
      expiringSoon: stats.expiringSoon,
      renewalsDue: renewalsQ.rows.length,
      attention: attention.length,
    },
    attention,
    trend: daily,
    roi: {
      signed30,
      hoursSaved: Math.round(hoursSavedManual * 10) / 10,
      valueUnlocked: Number(s?.value ?? 0),
      avgSignHours: stats.avgHours === null ? null : Math.round(stats.avgHours * 10) / 10,
      note: "برآورد: هر قرارداد دیجیتال حدود ۴۵ دقیقه کار دستی (چاپ، پیگیری، بایگانی) حذف می‌کند.",
    },
    trust: { slug: trustCode(w?.slug ?? ""), name: w?.name ?? "", signedTotal: Number(firstQ.rows[0]?.n ?? 0), since: w?.createdAt?.toISOString() ?? null },
    depth: computeDepth(f, conn),
  };
}
