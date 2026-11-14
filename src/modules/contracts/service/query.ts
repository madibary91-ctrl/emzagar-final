import { ADMIN_STATUSES, parseTags } from "./core";
import { type SessionUser } from "@/modules/auth/session";
import { type TeamRole, isTeamRole } from "@/modules/tenancy/roles";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { contractComments, contractSigners, contracts, templates, users, workspaceMembers, workspaces } from "@/db/schema";
import { db } from "@/db";
import { getSigners } from "./signers";
import { isIsolatedWorkspace } from "@/modules/tenancy/isolation";
import { logAudit } from "@/modules/audit/service";
import { stageOf } from "@/modules/signing/stages";

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
export type UserFilter = "all" | "pending" | "signed";
export async function listContractsForUser(userId: number, filter: UserFilter) {
  const rows = await db
    .select({
      id: contracts.id,
      number: contracts.number,
      title: contracts.title,
      status: contracts.status,
      issuedAt: contracts.issuedAt,
      signedAt: contracts.signedAt,
      mySignerStatus: contractSigners.status,
      myLabel: contractSigners.label,
      myPosition: contractSigners.position,
      myStage: contractSigners.stage,
      workspaceName: workspaces.name,
    })
    .from(contractSigners)
    .innerJoin(contracts, eq(contracts.id, contractSigners.contractId))
    .innerJoin(workspaces, eq(workspaces.id, contracts.workspaceId))
    .where(and(eq(contractSigners.userId, userId), ne(contracts.status, "draft")))
    .orderBy(desc(contracts.issuedAt));

  // محاسبه‌ی «نوبت من» برای هر قرارداد
  const ids = rows.map((r) => r.id);
  const pendingSigners = ids.length
    ? await db
        .select({ contractId: contractSigners.contractId, position: contractSigners.position, stage: contractSigners.stage })
        .from(contractSigners)
        .where(and(inArray(contractSigners.contractId, ids), eq(contractSigners.status, "pending")))
    : [];
  // مرحله‌ی فعلی هر قرارداد (در امضای هم‌زمان چند نفر هم‌مرحله‌اند)
  const minPending = new Map<number, number>();
  for (const s of pendingSigners) {
    const st = stageOf(s);
    const cur = minPending.get(s.contractId);
    if (cur === undefined || st < cur) minPending.set(s.contractId, st);
  }

  const mapped = rows.map((r) => {
    let state: "my_turn" | "waiting" | "signed" | "rejected" | "expired" | "cancelled" = "waiting";
    if (r.mySignerStatus === "signed") state = "signed";
    else if (r.status === "rejected") state = "rejected";
    else if (r.status === "expired") state = "expired";
    else if (r.status === "cancelled") state = "cancelled";
    else if (minPending.get(r.id) === stageOf({ position: r.myPosition, stage: r.myStage })) state = "my_turn";
    return { ...r, state };
  });

  if (filter === "pending") return mapped.filter((r) => r.state === "my_turn" || r.state === "waiting");
  if (filter === "signed") return mapped.filter((r) => r.state === "signed");
  return mapped;
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
    const like = `%${escapeLike(f.q)}%`;
    // PERF-02: OR روی ستون‌های دو جدول (contracts و users) هیچ ایندکسی را نمی‌گیرد. جستجو به دو زیرپرس‌وجوی جدا (هرکدام روی
    // یک جدول با BitmapOr روی ایندکس‌های trigram) شکسته و با UNION ادغام می‌شود؛ ILIKE '%q%' دیگر اسکن کامل نیست.
    conds.push(sql`${contracts.id} in (
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and (c.number ilike ${like} or c.title ilike ${like} or c.tags ilike ${like})
      union
      select c.id from contracts c
        where c.workspace_id = ${workspaceId} and c.customer_id in (select u.id from users u where u.name ilike ${like} or u.email ilike ${like})
    )`);
  }
  if (f.from && DATE_RE.test(f.from)) conds.push(gte(contracts.issuedAt, new Date(`${f.from}T00:00:00`)));
  if (f.to && DATE_RE.test(f.to)) conds.push(lt(contracts.issuedAt, new Date(new Date(`${f.to}T00:00:00`).getTime() + 86400000)));
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
  return { rows: rows.map((r) => ({ ...r, openRequests: open.get(r.id) ?? 0 })), total, totalCapped, page, pages, pageSize };
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
/** برچسب‌های پرکاربرد فضای کاری (برای فیلتر و پیشنهاد) */
export async function listTags(workspaceId: number): Promise<{ tag: string; n: number }[]> {
  const rows = await db.select({ tags: contracts.tags }).from(contracts).where(and(eq(contracts.workspaceId, workspaceId), ne(contracts.tags, "")));
  const m = new Map<string, number>();
  for (const r of rows) for (const t of parseTags(r.tags)) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, 40);
}
