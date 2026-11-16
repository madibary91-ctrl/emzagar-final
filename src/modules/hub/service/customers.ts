import { DAY, firstSignUrl, isEmail, normEmail } from "./core";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, wcOrders, workspaces, wpConnections } from "@/db/schema";

/**
 * آیا مشتری (با ایمیل) برای یکی از قالب‌های داده‌شده قرارداد امضاشده و معتبر دارد؟
 * templateIds خالی = هر قرارداد امضاشده. قراردادی که مدتش تمام شده معتبر حساب نمی‌شود.
 */
export async function checkAccess(workspaceId: number, emailRaw: string, templateIds: number[]) {
  const email = normEmail(emailRaw);
  if (!isEmail(email)) return { allowed: false, reason: "email_invalid" as const };
  const ids = [...new Set(templateIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  const tpl = ids.length ? sql`and c.template_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})` : sql``;
  const signed = await db.execute<{ id: number; number: string; template_id: number | null; signed_at: Date | null; term_ends_at: Date | null }>(sql`
    select c.id, c.number, c.template_id, c.signed_at, c.term_ends_at
    from contracts c join users u on u.id = c.customer_id
    where c.workspace_id = ${workspaceId} and lower(u.email) = ${email} and c.status = 'signed'
      and (c.term_ends_at is null or c.term_ends_at > now()) ${tpl}
    order by c.signed_at desc nulls last limit 1`);
  const hit = signed.rows[0];
  if (hit) {
    return { allowed: true, reason: "signed" as const, contract: { id: hit.id, number: hit.number, templateId: hit.template_id, signedAt: hit.signed_at ? new Date(hit.signed_at).toISOString() : null, termEndsAt: hit.term_ends_at ? new Date(hit.term_ends_at).toISOString() : null } };
  }
  // قراردادِ در انتظار امضا → لینک امضا برای تبدیل مستقیم به «امضا شده»
  const pending = await db.execute<{ id: number; number: string; title: string }>(sql`
    select c.id, c.number, c.title from contracts c join users u on u.id = c.customer_id
    where c.workspace_id = ${workspaceId} and lower(u.email) = ${email} and c.status = 'sent' ${tpl}
    order by c.issued_at desc limit 1`);
  const p = pending.rows[0];
  if (p) return { allowed: false, reason: "pending" as const, pending: { id: p.id, number: p.number, title: p.title, signUrl: await firstSignUrl(p.id, workspaceId) } };
  return { allowed: false, reason: "none" as const };
}
/* ───────────── کارت ۳۶۰ درجه‌ی مشتری ───────────── */

export async function customerCard(workspaceId: number, emailRaw: string) {
  const email = normEmail(emailRaw);
  if (!isEmail(email)) return null;
  const list = await db.execute<{ id: number; number: string; title: string; status: string; value: number | null; signed_at: Date | null; issued_at: Date; term_ends_at: Date | null }>(sql`
    select c.id, c.number, c.title, c.status, c.contract_value as value, c.signed_at, c.issued_at, c.term_ends_at
    from contracts c join users u on u.id = c.customer_id
    where c.workspace_id = ${workspaceId} and lower(u.email) = ${email} and c.status <> 'draft'
    order by c.issued_at desc limit 12`);
  const [ord] = await db
    .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${wcOrders.total} - ${wcOrders.refunded}) filter (where ${wcOrders.status} in ('processing','completed')), 0)` })
    .from(wcOrders)
    .where(and(eq(wcOrders.workspaceId, workspaceId), sql`lower(${wcOrders.customerEmail}) = ${email}`));
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.email, email));
  const rows = list.rows;
  return {
    email,
    name: u?.name ?? "",
    totals: {
      contracts: rows.length,
      signed: rows.filter((r) => r.status === "signed").length,
      pending: rows.filter((r) => r.status === "sent").length,
      contractValue: rows.filter((r) => r.status === "signed").reduce((a, r) => a + (r.value ?? 0), 0),
      orders: Number(ord?.n ?? 0),
      lifetimeSpend: Math.round(Number(ord?.total ?? 0)),
    },
    contracts: rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      status: r.status,
      value: r.value,
      signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
      issuedAt: new Date(r.issued_at).toISOString(),
      termEndsAt: r.term_ends_at ? new Date(r.term_ends_at).toISOString() : null,
      termDays: r.term_ends_at ? Math.round((new Date(r.term_ends_at).getTime() - Date.now()) / DAY) : null,
    })),
  };
}
/* ───────────── پروفایل اعتماد عمومی ───────────── */

export async function trustProfile(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(slug)) return null;
  const [w] = await db.select().from(workspaces).where(eq(workspaces.slug, slug));
  // فضای ایزوله‌ی ارسال سریع پروفایل عمومی ندارد (حتی آمار تجمیعی)
  if (!w || w.kind !== "team") return null;
  const [agg] = await db.execute<{ total: number; signed: number; signed90: number; median: number | null; last: Date | null }>(sql`
    select count(*) filter (where status <> 'draft')::int as total,
           count(*) filter (where status = 'signed')::int as signed,
           count(*) filter (where status = 'signed' and signed_at >= now() - interval '90 days')::int as signed90,
           (select percentile_cont(0.5) within group (order by extract(epoch from (signed_at - issued_at)) / 3600) from contracts where workspace_id = ${w.id} and status = 'signed' and signed_at is not null) as median,
           max(signed_at) as last
    from contracts where workspace_id = ${w.id}`).then((r) => r.rows);
  const sites = await db
    .select({ host: wpConnections.siteHost })
    .from(wpConnections)
    .where(and(eq(wpConnections.workspaceId, w.id), eq(wpConnections.status, "active"), eq(wpConnections.verified, true)))
    .orderBy(desc(wpConnections.createdAt))
    .limit(3);
  return {
    name: w.name,
    since: w.createdAt,
    total: Number(agg?.total ?? 0),
    signed: Number(agg?.signed ?? 0),
    signed90: Number(agg?.signed90 ?? 0),
    rate: agg && Number(agg.total) > 0 ? Math.round((Number(agg.signed) / Number(agg.total)) * 100) : 0,
    medianHours: agg?.median === null || agg?.median === undefined ? null : Math.round(Number(agg.median) * 10) / 10,
    last: agg?.last ? new Date(agg.last) : null,
    verifiedSites: sites.map((s) => s.host),
  };
}
export async function workspaceSlugOf(workspaceId: number): Promise<string> {
  const [w] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return w?.slug ?? "";
}
