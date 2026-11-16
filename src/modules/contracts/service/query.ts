import { ADMIN_STATUSES } from "./core";
import { searchVariants } from "@/lib/search-text";
import { type SessionUser } from "@/modules/auth/session";
import { type TeamRole, isTeamRole } from "@/modules/tenancy/roles";
import { type SQL, and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { contractComments, contractSigners, contracts, templates, users, workspaceMembers, workspaces } from "@/db/schema";
import { db } from "@/db";
import { getSigners } from "./signers";
import { isIsolatedWorkspace } from "@/modules/tenancy/isolation";
import { logAudit } from "@/modules/audit/service";
import { stageOf } from "@/modules/signing/stages";
import { buildTsQuery, ftsMatch, ftsSnippets } from "./fulltext";
import type { UserFilter } from "./user-list";

/**
 * جداسازی کاربران: فقط مدیر، مشتری و امضاکنندگان همین قرارداد دسترسی دارند.
 * در غیر این صورت null برمی‌گردد (و تلاش در لاگ ثبت می‌شود).
 */
export async function getContractForUser(user: SessionUser, id: number) {
  if (!Number.isInteger(id)) return null;
  const [contract] = await db.select().from(contracts).where(eq(contracts.id, id));
  if (!contract) return null;
  // نقش کاربر در فضای کاری همین قرارداد (نه فضای کاری فعال او!)
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, contract.workspaceId), eq(workspaceMembers.userId, user.id)));
  // فضای ایزوله‌ی ارسال سریع: نقش تیمی (اگر به‌هر دلیل وجود داشت) اعتبار ندارد؛ فقط خودِ امضاکنندگان به سندشان دسترسی دارند
  const isolated = await isIsolatedWorkspace(contract.workspaceId);
  const teamRole: TeamRole | null = !isolated && m && isTeamRole(m.role) ? m.role : null;
  // پیش‌نویس فقط برای تیم قابل مشاهده است
  if (contract.status === "draft" && !teamRole) return null;
  const signers = await getSigners(id);
  const allowed = !!teamRole || contract.customerId === user.id || signers.some((s) => s.userId === user.id);
  if (!allowed) {
    await logAudit({ action: "access.denied", contractId: id, userId: user.id });
    return null;
  }
  const [customer] = await db.select().from(users).where(eq(users.id, contract.customerId));
  return { contract, signers, customer, teamRole };
}
export type { UserFilter };
// P-01: فهرست «قراردادهای من» در user-list.ts (SQL، صفحه‌بندی‌شده)؛ اینجا فقط برای سازگاری آدرس import بازصادر می‌شود
export { listContractsForUser, queryUserContracts } from "./user-list";
/** فیلتر وضعیت فهرست «قراردادهای من» (تابع خالص؛ هم در سرویس و هم در داشبورد استفاده می‌شود) */
export function filterUserRows<T extends { state: string }>(rows: T[], filter: UserFilter): T[] {
  if (filter === "pending") return rows.filter((r) => r.state === "my_turn" || r.state === "waiting");
  if (filter === "signed") return rows.filter((r) => r.state === "signed");
  if (filter === "my_turn") return rows.filter((r) => r.state === "my_turn");
  if (filter === "closed") return rows.filter((r) => r.state === "rejected" || r.state === "expired" || r.state === "cancelled");
  return rows;
}
export interface ContractFilters {
  status?: string;
  q?: string;
  /** YYYY-MM-DD (بازه‌ی تاریخ صدور) */
  from?: string;
  to?: string;
  templateId?: number;
  source?: string;
  /** فقط قراردادهای در آستانه‌ی انقضا (۳ روز) */
  expiring?: boolean;
  sort?: string;
  page?: number;
  pageSize?: number;
  /** برای خروجی فقط موارد انتخاب‌شده */
  ids?: number[];
  /** true = فقط بایگانی‌شده‌ها؛ در غیر این صورت بایگانی‌شده‌ها از لیست حذف می‌شوند */
  archived?: boolean;
  /** فیلتر برچسب */
  tag?: string;
  /** فقط قراردادهایی که درخواست اصلاح بازِ طرف مقابل دارند */
  openRequests?: boolean;
}
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** سقف شمارش کل نتایج جستجو (فقط برای صفحه‌بندی؛ بیش از آن «+۱۰۰۰۰» است و کاربر باید فیلتر را دقیق‌تر کند) */
const COUNT_CAP = 10_000;
export const SORTS: Record<string, string> = {
  newest: "جدیدترین صدور",
  oldest: "قدیمی‌ترین صدور",
  signed: "آخرین امضا",
  title: "عنوان (الفبایی)",
};
/** جستجوی پیشرفته‌ی قراردادهای یک فضای کاری (فیلتر، مرتب‌سازی، صفحه‌بندی) */
export async function queryContracts(workspaceId: number, f: ContractFilters) {
  const conds = [eq(contracts.workspaceId, workspaceId)];
  if (f.status && ADMIN_STATUSES.includes(f.status)) conds.push(eq(contracts.status, f.status));
  if (f.q) {
    // کاربر ایرانی با ارقام فارسی/حروف عربی هم تایپ می‌کند؛ هر گونه‌ی املایی جداگانه (و با ایندکس trigram) سنجیده می‌شود
    const likes = searchVariants(f.q).map((v) => `%${escapeLike(v)}%`);
    const anyLike = (col: string): SQL => sql.join(likes.map((l) => sql`${sql.raw(col)} ilike ${l}`), sql` or `);
    // جستجوی متن کامل: متن قرارداد (نه فقط عنوان) با ایندکس GIN؛ واژه‌های پیشوندی با AND
    const tsq = f.q.trim().length >= 2 ? buildTsQuery(f.q) : null;
    // PERF-02: OR روی ستون‌های دو جدول (contracts و users) هیچ ایندکسی را نمی‌گیرد. جستجو به دو زیرپرس‌وجوی جدا (هرکدام روی
    // یک جدول با BitmapOr روی ایندکس‌های trigram) شکسته و با UNION ادغام می‌شود؛ ILIKE '%q%' دیگر اسکن کامل نیست.
    conds.push(sql`${contracts.id} in (
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and (${anyLike("c.number")} or ${anyLike("c.title")} or ${anyLike("c.tags")})
      union
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and c.customer_id in (select u.id from users u where ${anyLike("u.name")} or ${anyLike("u.email")})
      ${tsq ? sql`union
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and ${ftsMatch(tsq)}` : sql``}
    )`);
  }
  // بازه‌ی تاریخ صدور به وقت تهران (نه منطقه‌ی زمانی سرور) و با تحمل «از» بزرگ‌تر از «تا» (جابه‌جا می‌شود، نه نتیجه‌ی خالی بی‌دلیل)
  const dayStart = (iso: string | undefined): Date | null => {
    if (!iso || !DATE_RE.test(iso)) return null;
    const d = new Date(`${iso}T00:00:00+03:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let fromD = dayStart(f.from);
  let toD = dayStart(f.to);
  if (fromD && toD && fromD > toD) [fromD, toD] = [toD, fromD];
  if (fromD) conds.push(gte(contracts.issuedAt, fromD));
  if (toD) conds.push(lt(contracts.issuedAt, new Date(toD.getTime() + 86400000)));
  if (f.templateId) conds.push(eq(contracts.templateId, f.templateId));
  if (f.source === "admin" || f.source === "shop") conds.push(eq(contracts.source, f.source));
  if (f.expiring) conds.push(sql`${contracts.status} = 'sent' and ${contracts.expiresAt} is not null and ${contracts.expiresAt} < now() + interval '3 days'`);
  if (f.ids && f.ids.length) conds.push(inArray(contracts.id, f.ids.slice(0, 1000)));
  conds.push(f.archived ? sql`${contracts.archivedAt} is not null` : sql`${contracts.archivedAt} is null`);
  if (f.tag) conds.push(sql`(',' || ${contracts.tags} || ',') ilike ${`%,${escapeLike(f.tag.slice(0, 24))},%`}`);
  if (f.openRequests) conds.push(sql`exists (select 1 from contract_comments cc where cc.contract_id = ${contracts.id} and cc.kind = 'change_request' and cc.status = 'open' and cc.parent_id is null)`);
  const where = and(...conds);

  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 5000);
  const order =
    f.sort === "oldest" ? asc(contracts.issuedAt) : f.sort === "signed" ? sql`${contracts.signedAt} desc nulls last` : f.sort === "title" ? asc(contracts.title) : desc(contracts.issuedAt);

  const fetchPage = (pg: number) =>
    db
      .select({
        id: contracts.id,
        number: contracts.number,
        title: contracts.title,
        status: contracts.status,
        source: contracts.source,
        issuedAt: contracts.issuedAt,
        signedAt: contracts.signedAt,
        expiresAt: contracts.expiresAt,
        userName: users.name,
        userEmail: users.email,
        templateTitle: templates.title,
        tags: contracts.tags,
        contractValue: contracts.contractValue,
        archivedAt: contracts.archivedAt,
      })
      .from(contracts)
      .innerJoin(users, eq(users.id, contracts.customerId))
      .leftJoin(templates, eq(templates.id, contracts.templateId))
      .where(where)
      .orderBy(order, desc(contracts.id))
      .limit(pageSize)
      .offset((pg - 1) * pageSize);

  // PERF-02: شمارش کامل در هر نمایش صفحه حذف شد.
  //  • صفحه‌ی ناقص (رایج‌ترین حالت) خودش تعداد کل را می‌گوید → هیچ count اجرا نمی‌شود.
  //  • فقط وقتی صفحه پر است، شمارش «سقف‌دار» (حداکثر COUNT_CAP ردیف خوانده می‌شود، نه کل جدول) اجرا می‌شود.
  let page = Math.max(f.page ?? 1, 1);
  let rows = await fetchPage(page);
  let total: number;
  let totalCapped = false;
  const needCount = rows.length === pageSize || (rows.length === 0 && page > 1);
  if (!needCount) total = (page - 1) * pageSize + rows.length;
  else {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sql`(select 1 from ${contracts} inner join ${users} on ${users.id} = ${contracts.customerId} where ${where} limit ${COUNT_CAP + 1}) as capped`);
    totalCapped = n > COUNT_CAP;
    total = Math.min(n, COUNT_CAP);
  }
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page > pages) {
    page = pages;
    rows = await fetchPage(page);
  }

  // PERF-02: به‌جای یک زیرپرس‌وجوی count(*) برای «هر ردیف»، یک GROUP BY دسته‌ای فقط برای ردیف‌های همین صفحه (با ایندکس جزئی)
  const open = new Map<number, number>();
  if (rows.length) {
    const agg = await db
      .select({ id: contractComments.contractId, n: sql<number>`count(*)::int` })
      .from(contractComments)
      .where(and(inArray(contractComments.contractId, rows.map((r) => r.id)), eq(contractComments.kind, "change_request"), eq(contractComments.status, "open"), isNull(contractComments.parentId)))
      .groupBy(contractComments.contractId);
    for (const a of agg) open.set(a.id, a.n);
  }
  // قطعه‌ی متن قرارداد که عبارت در آن یافت شده (فقط برای ردیف‌های همین صفحه)
  const snippets = f.q && f.q.trim().length >= 2 && rows.length ? await ftsSnippets(rows.map((r) => r.id), f.q).catch(() => new Map<number, string>()) : new Map<number, string>();
  return { rows: rows.map((r) => ({ ...r, openRequests: open.get(r.id) ?? 0, snippet: snippets.get(r.id) ?? null })), total, totalCapped, page, pages, pageSize };
}
export async function adminCounts(workspaceId: number) {
  const rows = await db
    .select({ status: contracts.status, archived: sql<boolean>`(${contracts.archivedAt} is not null)`, n: sql<number>`count(*)::int` })
    .from(contracts)
    .where(eq(contracts.workspaceId, workspaceId))
    .groupBy(contracts.status, sql`(${contracts.archivedAt} is not null)`);
  // all = همه (سازگار با API)، active = بدون بایگانی (نمایش پیش‌فرض لیست)، archived = بایگانی‌شده
  const c = { all: 0, active: 0, archived: 0, draft: 0, sent: 0, signed: 0, rejected: 0, expired: 0, cancelled: 0 } as Record<string, number>;
  for (const r of rows) {
    c.all += r.n;
    if (r.archived) c.archived += r.n;
    else {
      c.active += r.n;
      c[r.status] = (c[r.status] ?? 0) + r.n;
    }
  }
  return c;
}
/**
 * برچسب‌های پرکاربرد فضای کاری (برای فیلتر و پیشنهاد).
 * P-03: تجمیع در خودِ PostgreSQL انجام می‌شود (unnest + GROUP BY + LIMIT 40)؛ فقط حداکثر ۴۰ ردیف به Node برمی‌گردد
 * (قبلاً ستون tags «همه‌ی» قراردادهای فضا به Node می‌آمد و در JS شمرده می‌شد). ایندکس جزئی `contracts_ws_tags_idx` فقط
 * قراردادهای دارای برچسب را اسکن می‌کند. قاعده‌ی شمارش مثل قبل: هر برچسب در هر قرارداد یک‌بار (parseTags + یکتاسازی).
 */
export async function listTags(workspaceId: number): Promise<{ tag: string; n: number }[]> {
  const res = await db.execute<{ tag: string; n: number }>(sql`
    select t.tag, count(*)::int as n
    from (
      select distinct c.id, btrim(x.v) as tag
      from contracts c
      cross join lateral unnest(string_to_array(c.tags, ',')) as x(v)
      where c.workspace_id = ${workspaceId} and c.tags <> ''
    ) t
    where t.tag <> ''
    group by t.tag
    order by n desc, t.tag collate "C" asc
    limit 40`);
  return res.rows.map((r) => ({ tag: r.tag, n: Number(r.n) }));
}
