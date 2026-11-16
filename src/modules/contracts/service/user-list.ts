import { type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { jalaliTokenRanges } from "@/lib/jalali-search";
import { searchTokens, searchVariants } from "@/lib/search-text";

/**
 * «قراردادهای من» (داشبورد مشتری) — کاملاً در سطح SQL (P-01).
 *
 * قبلاً `listContractsForUser(userId, "all")` همه‌ی قراردادهای کاربر را (همراه با همه‌ی امضاکنندگان در انتظار) به Node می‌آورد؛
 * سپس جستجو، شمارنده‌ی تب‌ها و صفحه‌بندی (۲۰ تایی!) در جاوااسکریپت انجام می‌شد؛ یعنی هزینه‌ی هر بازدید با «تعداد کل قراردادها»
 * رشد می‌کرد، نه با اندازه‌ی صفحه. اکنون:
 *  - «وضعیت من» (نوبت من / منتظر / امضاشده / رد / منقضی / لغو) در خودِ SQL محاسبه می‌شود (همان قاعده‌ی stageOf: کمترین مرحله‌ی در انتظار).
 *  - جستجو (عنوان، شماره، فرستنده، نقش، تاریخ شمسی) به WHERE می‌رود؛ همه‌ی واژه‌ها باید پیدا شوند (AND) مثل قبل.
 *  - شمارنده‌ی همه‌ی تب‌ها = یک GROUP BY؛ فقط «یک صفحه» ردیف به Node برمی‌گردد (LIMIT/OFFSET).
 */
export type UserFilter = "all" | "pending" | "signed" | "my_turn" | "closed";
export type UserState = "my_turn" | "waiting" | "signed" | "rejected" | "expired" | "cancelled";

export interface UserContractRow {
  id: number;
  number: string;
  title: string;
  status: string;
  issuedAt: Date;
  signedAt: Date | null;
  mySignerStatus: string;
  myLabel: string;
  myPosition: number;
  myStage: number;
  workspaceName: string;
  state: UserState;
}

export type UserCounts = Record<UserState, number> & { all: number; pending: number; closed: number };

const FILTER_STATES: Record<UserFilter, UserState[] | null> = {
  all: null,
  pending: ["my_turn", "waiting"],
  signed: ["signed"],
  my_turn: ["my_turn"],
  closed: ["rejected", "expired", "cancelled"],
};

/** مرحله‌ی مؤثر (قاعده‌ی stageOf): stage>0 وگرنه position */
const EFF = (a: string) => sql.raw(`(case when ${a}.stage > 0 then ${a}.stage else ${a}.position end)`);

/** «وضعیت من» برای هر ردیف (aliasها: cs = امضاکننده‌ی من، c = قرارداد) */
const STATE_SQL = sql`case
  when cs.status = 'signed' then 'signed'
  when c.status = 'rejected' then 'rejected'
  when c.status = 'expired' then 'expired'
  when c.status = 'cancelled' then 'cancelled'
  when (select min(${EFF("p")}) from contract_signers p where p.contract_id = c.id and p.status = 'pending') = ${EFF("cs")} then 'my_turn'
  else 'waiting' end`;

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

/** شرط جستجو: برای هر واژه، «یکی از ستون‌ها شامل گونه‌های املایی واژه» یا «تاریخ صدور/تکمیل در بازه‌ی شمسی واژه» */
function searchCondition(q: string): SQL | null {
  const tokens = searchTokens(q);
  if (tokens.length === 0) return null;
  const cols = ["c.title", "c.number", "w.name", "cs.label"];
  const parts = tokens.map((tok) => {
    const likes = searchVariants(tok).map((v) => `%${escapeLike(v)}%`);
    const textMatch = sql.join(
      cols.flatMap((col) => likes.map((l) => sql`${sql.raw(col)} ilike ${l}`)),
      sql` or `,
    );
    const ranges = jalaliTokenRanges(tok);
    if (!ranges) return sql`(${textMatch})`;
    const lit = (pick: (r: { from: Date; to: Date }) => Date) => `{${ranges.map((r) => `"${pick(r).toISOString()}"`).join(",")}}`;
    const dateMatch = sql`exists (select 1 from unnest(${lit((r) => r.from)}::timestamp[], ${lit((r) => r.to)}::timestamp[]) as r(a, b)
      where (c.issued_at >= r.a and c.issued_at < r.b) or (c.signed_at is not null and c.signed_at >= r.a and c.signed_at < r.b))`;
    return sql`(${textMatch} or ${dateMatch})`;
  });
  return sql.join(parts, sql` and `);
}

function mineSql(userId: number, search: SQL | null): SQL {
  return sql`select c.id, c.number, c.title, c.status,
      (extract(epoch from c.issued_at) * 1000)::float8 as issued_ms,
      (extract(epoch from c.signed_at) * 1000)::float8 as signed_ms,
      cs.status as my_signer_status, cs.label as my_label, cs.position as my_position, cs.stage as my_stage,
      w.name as workspace_name, ${STATE_SQL} as state
    from contract_signers cs
    inner join contracts c on c.id = cs.contract_id
    inner join workspaces w on w.id = c.workspace_id
    where cs.user_id = ${userId} and c.status <> 'draft'${search ? sql` and (${search})` : sql``}`;
}

const stateWhere = (filter: UserFilter): SQL => {
  const st = FILTER_STATES[filter];
  return st ? sql` where m.state in (${sql.join(st.map((s) => sql`${s}`), sql`, `)})` : sql``;
};

type RawRow = {
  id: number;
  number: string;
  title: string;
  status: string;
  issued_ms: number;
  signed_ms: number | null;
  my_signer_status: string;
  my_label: string;
  my_position: number;
  my_stage: number;
  workspace_name: string;
  state: UserState;
};

async function fetchRows(userId: number, filter: UserFilter, search: SQL | null, limit?: number, offset = 0): Promise<UserContractRow[]> {
  const res = await db.execute<RawRow>(sql`
    select m.* from (${mineSql(userId, search)}) m${stateWhere(filter)}
    order by m.issued_ms desc, m.id desc${limit !== undefined ? sql` limit ${limit} offset ${offset}` : sql``}`);
  return res.rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    status: r.status,
    issuedAt: new Date(Number(r.issued_ms)),
    signedAt: r.signed_ms === null || r.signed_ms === undefined ? null : new Date(Number(r.signed_ms)),
    mySignerStatus: r.my_signer_status,
    myLabel: r.my_label,
    myPosition: r.my_position,
    myStage: r.my_stage,
    workspaceName: r.workspace_name,
    state: r.state,
  }));
}

async function fetchCounts(userId: number, search: SQL | null): Promise<UserCounts> {
  const res = await db.execute<{ state: UserState; n: number }>(sql`select m.state, count(*)::int as n from (${mineSql(userId, search)}) m group by m.state`);
  const c: UserCounts = { my_turn: 0, waiting: 0, signed: 0, rejected: 0, expired: 0, cancelled: 0, all: 0, pending: 0, closed: 0 };
  for (const r of res.rows) c[r.state] = Number(r.n);
  c.pending = c.my_turn + c.waiting;
  c.closed = c.rejected + c.expired + c.cancelled;
  c.all = c.pending + c.signed + c.closed;
  return c;
}

/** فهرست قراردادهای کاربر (فیلتر وضعیت در SQL). `limit` اختیاری است؛ بدون آن همه (برای فراخواننده‌های داخلی مثل ربات) */
export async function listContractsForUser(userId: number, filter: UserFilter, opts: { limit?: number } = {}): Promise<UserContractRow[]> {
  return fetchRows(userId, filter, null, opts.limit, 0);
}

export interface UserContractsPage {
  rows: UserContractRow[];
  /** شمارنده‌ی تب‌ها «با اعمال جستجو» */
  counts: UserCounts;
  /** شمارنده‌ی کل «بدون جستجو» (برای کارت‌های آمار و حالت خالی) */
  totals: UserCounts;
  /** تعداد نتایج فیلتر فعلی */
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

/** یک صفحه از «قراردادهای من» + شمارنده‌ها؛ هزینه با اندازه‌ی صفحه می‌سنجد، نه تعداد کل قراردادها */
export async function queryUserContracts(userId: number, o: { filter?: UserFilter; q?: string; page?: number; pageSize?: number } = {}): Promise<UserContractsPage> {
  const filter = o.filter ?? "all";
  const pageSize = Math.min(Math.max(Math.trunc(o.pageSize ?? 20), 1), 200);
  const search = o.q ? searchCondition(o.q) : null;
  const want = Math.max(Math.trunc(o.page ?? 1), 1);
  const [counts, totals, firstRows] = await Promise.all([
    fetchCounts(userId, search),
    search ? fetchCounts(userId, null) : null,
    fetchRows(userId, filter, search, pageSize, (want - 1) * pageSize),
  ]);
  const total = counts[filter];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(want, pages);
  const rows = page === want ? firstRows : await fetchRows(userId, filter, search, pageSize, (page - 1) * pageSize);
  return { rows, counts, totals: totals ?? counts, total, page, pages, pageSize };
}
