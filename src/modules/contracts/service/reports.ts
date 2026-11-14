import { and, asc, eq, ne, sql } from "drizzle-orm";
import { contracts, templates, users, workspaces } from "@/db/schema";
import { db } from "@/db";

/** آمار تجاری برای داشبورد مدیر: نرخ تکمیل، میانگین زمان امضا، قراردادهای در آستانه‌ی انقضا */
export async function adminStats(workspaceId: number) {
  const [row] = await db
    .select({
      total: sql<number>`count(*) filter (where ${contracts.status} <> 'draft')::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      pending: sql<number>`count(*) filter (where ${contracts.status} = 'sent')::int`,
      avgHours: sql<number | null>`avg(extract(epoch from (${contracts.signedAt} - ${contracts.issuedAt})) / 3600) filter (where ${contracts.status} = 'signed')`,
      expiringSoon: sql<number>`count(*) filter (where ${contracts.status} = 'sent' and ${contracts.expiresAt} is not null and ${contracts.expiresAt} < now() + interval '3 days')::int`,
      reminders: sql<number>`coalesce(sum(${contracts.reminderCount}), 0)::int`,
    })
    .from(contracts)
    .where(eq(contracts.workspaceId, workspaceId));
  return {
    total: row?.total ?? 0,
    signed: row?.signed ?? 0,
    pending: row?.pending ?? 0,
    rate: row && row.total > 0 ? Math.round((row.signed / row.total) * 100) : 0,
    avgHours: row?.avgHours ? Number(row.avgHours) : null,
    expiringSoon: row?.expiringSoon ?? 0,
    reminders: row?.reminders ?? 0,
  };
}
/** گزارش ماهانه‌ی ۶ ماه اخیر + عملکرد قالب‌ها (برای صفحه‌ی گزارش‌ها) */
export async function reportData(workspaceId: number) {
  const monthly = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${contracts.issuedAt}), 'YYYY-MM')`,
      issued: sql<number>`count(*)::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      rejected: sql<number>`count(*) filter (where ${contracts.status} in ('rejected','expired','cancelled'))::int`,
    })
    .from(contracts)
    .where(and(eq(contracts.workspaceId, workspaceId), ne(contracts.status, "draft"), sql`${contracts.issuedAt} >= date_trunc('month', now()) - interval '5 months'`))
    .groupBy(sql`date_trunc('month', ${contracts.issuedAt})`)
    .orderBy(sql`date_trunc('month', ${contracts.issuedAt})`);
  const byTemplate = await db
    .select({
      title: sql<string>`coalesce(${templates.title}, 'بدون قالب')`,
      total: sql<number>`count(*)::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      avgHours: sql<number | null>`avg(extract(epoch from (${contracts.signedAt} - ${contracts.issuedAt})) / 3600) filter (where ${contracts.status} = 'signed')`,
    })
    .from(contracts)
    .leftJoin(templates, eq(templates.id, contracts.templateId))
    .where(and(eq(contracts.workspaceId, workspaceId), ne(contracts.status, "draft")))
    .groupBy(templates.title)
    .orderBy(sql`count(*) desc`)
    .limit(10);
  const slowest = await db
    .select({ id: contracts.id, number: contracts.number, title: contracts.title, issuedAt: contracts.issuedAt, userName: users.name })
    .from(contracts)
    .innerJoin(users, eq(users.id, contracts.customerId))
    .where(and(eq(contracts.workspaceId, workspaceId), eq(contracts.status, "sent")))
    .orderBy(asc(contracts.issuedAt))
    .limit(8);
  return { monthly, byTemplate, slowest };
}
/** نام فضای کاری (برای نمایش به مشتری) */
export async function workspaceName(workspaceId: number): Promise<string> {
  const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return w?.name ?? "";
}
