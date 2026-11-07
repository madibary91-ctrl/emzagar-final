import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contractSigners, users, wcOrders, workspaces, wpConnections } from "@/db/schema";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";
import { getInsights } from "@/modules/insights/service";
import { adminStats } from "@/modules/contracts/service";

/**
 * «مرکز فرماندهی کسب‌وکار» (Business Hub)
 * ─────────────────────────────────────────
 * سمت ابر برای افزونه‌ی وردپرس:
 *  • pulse    — نبض لحظه‌ای کسب‌وکار (شاخص‌ها، صف اقدام، روند، ارزش‌آفرینی، عمق یکپارچگی)
 *  • access   — «آیا این مشتری قرارداد امضاشده دارد؟» (دروازه‌ی محتوا/محصول/نقش در وردپرس)
 *  • customer — کارت ۳۶۰ درجه‌ی مشتری (قراردادها + سفارش‌ها) برای پروفایل کاربر و صفحه‌ی سفارش
 *  • trust    — پروفایل اعتماد عمومی کسب‌وکار (نشان اعتماد روی سایت مشتری)
 *  • depth    — امتیاز «عمق یکپارچگی» و گام‌های بعدی پیشنهادی
 */

const DAY = 86400000;
const MANUAL_HOURS_PER_CONTRACT = 0.75; // برآورد کار دستی حذف‌شده برای هر قرارداد (چاپ، پیگیری، بایگانی، تطبیق)

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const normEmail = (v: unknown) => String(v ?? "").trim().toLowerCase().slice(0, 254);
export const isEmail = (v: string) => EMAIL.test(v);

/* ───────────── عمق یکپارچگی ───────────── */

export type Features = {
  gates: number;
  productContracts: number;
  orderAutomation: boolean;
  roles: boolean;
  badge: boolean;
  digest: boolean;
  adminBar: boolean;
  widget: boolean;
  portal: boolean;
  syncOrders: boolean;
  wcActive: boolean;
  gateChecks: number;
  gateAllowed: number;
  /** قوانین اتوماسیون فعال در وردپرس */
  automations: number;
  /** تعداد اجرای موفق اتوماسیون‌ها (۳۰ روز اخیر) */
  automationRuns: number;
  /** فرم‌هایی که به صدور خودکار قرارداد وصل شده‌اند */
  forms: number;
  /** میز کار قراردادها داخل وردپرس حداقل یک بار استفاده شده */
  workspaceUsed: boolean;
  /** اعلان زنده و پالت فرمان فعال است */
  live: boolean;
  /** تعداد کنش‌هایی که مدیر بدون خروج از وردپرس انجام داده (یادآوری، لغو، صدور، دانلود) */
  actions: number;
};

const num = (v: unknown, max = 1_000_000) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};
const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "yes";

/** فقط کلیدهای شناخته‌شده با نوع و سقف مشخص پذیرفته می‌شوند */
export function sanitizeFeatures(raw: unknown): Features {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    gates: num(r.gates),
    productContracts: num(r.productContracts),
    orderAutomation: bool(r.orderAutomation),
    roles: bool(r.roles),
    badge: bool(r.badge),
    digest: bool(r.digest),
    adminBar: bool(r.adminBar),
    widget: bool(r.widget),
    portal: bool(r.portal),
    syncOrders: bool(r.syncOrders),
    wcActive: bool(r.wcActive),
    gateChecks: num(r.gateChecks, 1e9),
    gateAllowed: num(r.gateAllowed, 1e9),
    automations: num(r.automations, 500),
    automationRuns: num(r.automationRuns, 1e9),
    forms: num(r.forms, 500),
    workspaceUsed: bool(r.workspaceUsed),
    live: bool(r.live),
    actions: num(r.actions, 1e9),
  };
}

export function parseFeatures(json: string): Features {
  try {
    return sanitizeFeatures(JSON.parse(json));
  } catch {
    return sanitizeFeatures({});
  }
}

export type DepthStep = { key: string; label: string; hint: string; weight: number; done: boolean; applies: boolean; where: string };
export type Depth = { score: number; level: string; levelIndex: number; steps: DepthStep[]; next: DepthStep | null };

export const DEPTH_LEVELS = ["شروع", "فعال", "یکپارچه", "هسته‌ی کسب‌وکار"];

export function computeDepth(f: Features, conn: { verified: boolean; syncEnabled: boolean }): Depth {
  const wc = f.wcActive;
  const steps: DepthStep[] = [
    { key: "connected", label: "اتصال تاییدشده‌ی دامنه", hint: "مالکیت دامنه‌ی شما تایید شده و سایت به فضای کاری وصل است.", weight: 10, done: conn.verified, applies: true, where: "emzagar" },
    { key: "sync", label: "همگام‌سازی دوطرفه‌ی لحظه‌ای", hint: "وضعیت امضا لحظه‌ای به وردپرس می‌رسد و سفارش‌ها در ابر دیده می‌شوند.", weight: 10, done: conn.syncEnabled, applies: true, where: "emzagar" },
    { key: "products", label: "قرارداد خودکار روی محصولات", hint: "در ویرایش هر محصول، قالب قرارداد را انتخاب کنید تا پس از خرید خودکار صادر شود.", weight: 15, done: f.productContracts > 0, applies: wc, where: "product" },
    { key: "orders", label: "اتوماسیون وضعیت سفارش", hint: "سفارش تا امضا نگه داشته شود و پس از امضا خودکار تکمیل گردد.", weight: 10, done: f.orderAutomation, applies: wc, where: "emzagar" },
    { key: "gates", label: "دروازه‌ی قرارداد روی محتوا و محصول", hint: "صفحه، نوشته یا محصولی را فقط برای کسانی که قرارداد امضا کرده‌اند باز کنید.", weight: 15, done: f.gates > 0, applies: true, where: "post" },
    { key: "roles", label: "نقش خودکار پس از امضا", hint: "با امضای قرارداد، نقش کاربری (مثلاً «مشتری تاییدشده») خودکار داده شود.", weight: 10, done: f.roles, applies: true, where: "emzagar-hub" },
    { key: "badge", label: "نشان اعتماد روی سایت", hint: "نشان «قراردادهای این کسب‌وکار با امضاگیر مستند می‌شود» اعتبار شما را به مشتری نشان می‌دهد.", weight: 10, done: f.badge, applies: true, where: "emzagar-hub" },
    { key: "digest", label: "گزارش هفتگی کسب‌وکار", hint: "هر هفته خلاصه‌ی امضاها، سفارش‌های معطل و ارزش آزاد‌شده به ایمیل شما می‌رسد.", weight: 5, done: f.digest, applies: true, where: "emzagar-hub" },
    { key: "portal", label: "پورتال قراردادهای مشتری", hint: "مشتری قراردادهایش را در «حساب کاربری» یا صفحه‌ی «قراردادهای من» می‌بیند.", weight: 5, done: f.portal, applies: true, where: "emzagar" },
    { key: "cockpit", label: "کابین فرماندهی در پیشخوان", hint: "نوار مدیریت و ویجت پیشخوان وضعیت لحظه‌ای را همیشه جلوی چشم شما می‌گذارد.", weight: 5, done: f.adminBar || f.widget, applies: true, where: "emzagar-hub" },
    { key: "workspace", label: "مدیریت قراردادها بدون خروج از وردپرس", hint: "از «میز کار قراردادها» قرارداد صادر، پیگیری، لغو و دانلود کنید؛ کانبان و پالت فرمان (Ctrl+K) همان‌جاست.", weight: 10, done: f.workspaceUsed, applies: true, where: "emzagar-workspace" },
    { key: "automations", label: "اتوماسیون «اگر ... آنگاه»", hint: "با یک کلیک دستورهای آماده را روشن کنید: پس از امضا نقش بدهید، وضعیت سفارش را عوض کنید، وب‌هوک بزنید یا وظیفه بسازید.", weight: 10, done: f.automations > 0, applies: true, where: "emzagar-automations" },
    { key: "forms", label: "فرم‌های سایت ← قرارداد خودکار", hint: "فرم تماس/ثبت‌نام (CF7، WPForms، Gravity، المنتور) را وصل کنید تا با ارسال فرم، قرارداد برای مشتری صادر شود.", weight: 5, done: f.forms > 0, applies: true, where: "emzagar-automations" },
    { key: "live", label: "اعلان زنده و پالت فرمان", hint: "امضای مشتری لحظه‌ای در همه‌ی صفحه‌های پیشخوان اعلام می‌شود و با Ctrl+K همه‌چیز جستجو می‌شود.", weight: 5, done: f.live, applies: true, where: "emzagar-hub" },
    { key: "usage", label: "دسترسی مشتریان بر پایه‌ی امضا", hint: "حداقل یک بار دسترسی یک مشتری بر پایه‌ی قرارداد امضاشده باز شده است.", weight: 5, done: f.gateAllowed > 0, applies: true, where: "emzagar-hub" },
  ];
  const applicable = steps.filter((s) => s.applies);
  const total = applicable.reduce((a, s) => a + s.weight, 0) || 1;
  const got = applicable.filter((s) => s.done).reduce((a, s) => a + s.weight, 0);
  const score = Math.round((got / total) * 100);
  const levelIndex = score >= 80 ? 3 : score >= 55 ? 2 : score >= 25 ? 1 : 0;
  const next = applicable.filter((s) => !s.done).sort((a, b) => b.weight - a.weight)[0] ?? null;
  return { score, level: DEPTH_LEVELS[levelIndex], levelIndex, steps: applicable, next };
}

export async function saveFeatures(connId: number, raw: unknown): Promise<Features> {
  const f = sanitizeFeatures(raw);
  await db.update(wpConnections).set({ integrationJson: JSON.stringify(f), integrationAt: new Date() }).where(eq(wpConnections.id, connId));
  return f;
}

/* ───────────── نبض کسب‌وکار ───────────── */

type AttentionKind = "stale" | "expiring" | "renewal" | "rejected";
export type AttentionItem = { id: number; number: string; title: string; kind: AttentionKind; ageDays: number; customer: string; hint: string; canRemind: boolean };

function trustCode(slug: string) {
  return slug;
}

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

/* ───────────── دروازه‌ی دسترسی ───────────── */

async function firstSignUrl(contractId: number, workspaceId: number): Promise<string | null> {
  const [first] = await db.select({ id: contractSigners.id }).from(contractSigners).where(eq(contractSigners.contractId, contractId)).orderBy(asc(contractSigners.position)).limit(1);
  const sl = first ? await getOrCreateSigningLink(first.id) : null;
  return sl ? await signingUrl(sl.token, workspaceId) : null;
}

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
  if (!w) return null;
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

/** نمای کوتاه برای صفحه‌ی مدیریت (همه‌ی اتصال‌های فضای کاری با عمق یکپارچگی) */
export async function depthForWorkspace(workspaceId: number) {
  const conns = await db.select().from(wpConnections).where(and(eq(wpConnections.workspaceId, workspaceId), eq(wpConnections.status, "active"))).orderBy(desc(wpConnections.createdAt));
  return conns.map((c) => {
    const f = parseFeatures(c.integrationJson);
    return { conn: c, features: f, depth: computeDepth(f, c), reportedAt: c.integrationAt };
  });
}

export async function workspaceSlugOf(workspaceId: number): Promise<string> {
  const [w] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return w?.slug ?? "";
}
