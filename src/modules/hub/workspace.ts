import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, contractSigners, contracts, templates, users, wcContractLinks } from "@/db/schema";
import { ACTION_LABELS } from "@/modules/audit/service";
import { STATUS_LABELS } from "@/modules/contracts/service";
import { getOrCreateSigningLink, signingUrl } from "@/modules/signing/links";

/**
 * «میز کار قرارداد» (Contract Workspace) — سمت ابر برای صفحه‌ی «قراردادها» و پالت فرمان وردپرس.
 *  • search   — جستجوی یکپارچه‌ی قرارداد، مشتری و قالب (برای Ctrl+K)
 *  • pipeline — قیف زنده‌ی قراردادها به‌صورت ستون‌های کانبان
 *  • detail   — جزئیات کامل یک قرارداد + خط زمانی رویدادها + لینک امضا
 */

const esc = (q: string) => q.replace(/[\\%_]/g, (m) => `\\${m}`);

export type SearchResult = {
  contracts: { id: number; number: string; title: string; status: string; statusLabel: string; customer: string; email: string }[];
  customers: { email: string; name: string; contracts: number; signed: number }[];
  templates: { id: number; title: string }[];
};

export async function searchHub(workspaceId: number, raw: string): Promise<SearchResult> {
  const q = raw.trim().slice(0, 80);
  if (q.length < 2) return { contracts: [], customers: [], templates: [] };
  const like = `%${esc(q)}%`;
  const [cs, cu, ts] = await Promise.all([
    db.execute<{ id: number; number: string; title: string; status: string; name: string; email: string }>(sql`
      select c.id, c.number, c.title, c.status, u.name, u.email
      from contracts c join users u on u.id = c.customer_id
      where c.workspace_id = ${workspaceId} and c.status <> 'draft'
        and (c.title ilike ${like} or c.number ilike ${like} or u.name ilike ${like} or u.email ilike ${like})
      order by c.issued_at desc limit 6`),
    db.execute<{ email: string; name: string; n: number; signed: number }>(sql`
      select u.email, u.name, count(*)::int as n, (count(*) filter (where c.status = 'signed'))::int as signed
      from contracts c join users u on u.id = c.customer_id
      where c.workspace_id = ${workspaceId} and c.status <> 'draft' and (u.name ilike ${like} or u.email ilike ${like} or u.mobile ilike ${like})
      group by u.email, u.name order by max(c.issued_at) desc limit 5`),
    db.execute<{ id: number; title: string }>(sql`
      select id, title from templates where workspace_id = ${workspaceId} and title ilike ${like} order by title limit 4`),
  ]);
  return {
    contracts: cs.rows.map((r) => ({ id: r.id, number: r.number, title: r.title, status: r.status, statusLabel: STATUS_LABELS[r.status] ?? r.status, customer: r.name, email: r.email })),
    customers: cu.rows.map((r) => ({ email: r.email, name: r.name, contracts: Number(r.n), signed: Number(r.signed) })),
    templates: ts.rows.map((r) => ({ id: r.id, title: r.title })),
  };
}

/* ───────────── قیف (کانبان) ───────────── */

export const STAGES = [
  { key: "sent", label: "ارسال‌شده" },
  { key: "viewed", label: "مشاهده‌شده" },
  { key: "signed", label: "امضاشده" },
  { key: "rejected", label: "ردشده" },
  { key: "expired", label: "منقضی/لغو" },
] as const;

export type PipelineCard = { id: number; number: string; title: string; customer: string; email: string; ageDays: number; value: number | null; expiresInHours: number | null };
export type Pipeline = { stages: { key: string; label: string; count: number; value: number; items: PipelineCard[] }[]; total: number };

export async function getPipeline(workspaceId: number, perStage = 8): Promise<Pipeline> {
  const per = Math.max(1, Math.min(20, perStage));
  const [counts, rows] = await Promise.all([
    db.execute<{ stage: string; n: number; v: number }>(sql`
      select t.stage, count(*)::int as n, coalesce(sum(t.value), 0)::bigint as v from (
        select c.contract_value as value,
               case when c.status = 'sent' and exists (select 1 from audit_logs a where a.contract_id = c.id and a.action = 'contract.viewed') then 'viewed'
                    when c.status in ('expired', 'cancelled') then 'expired' else c.status end as stage
        from contracts c
        where c.workspace_id = ${workspaceId} and c.status <> 'draft' and c.archived_at is null
          and coalesce(c.signed_at, c.issued_at) > now() - interval '90 days'
      ) t group by t.stage`),
    db.execute<{ id: number; number: string; title: string; stage: string; days: number; value: number | null; hrs: number | null; name: string; email: string }>(sql`
      select * from (
        select c.id, c.number, c.title, u.name, u.email, c.contract_value as value,
               case when c.status = 'sent' and exists (select 1 from audit_logs a where a.contract_id = c.id and a.action = 'contract.viewed') then 'viewed'
                    when c.status in ('expired', 'cancelled') then 'expired' else c.status end as stage,
               floor(extract(epoch from (now() - coalesce(c.signed_at, c.issued_at))) / 86400)::int as days,
               case when c.expires_at is null or c.status <> 'sent' then null else extract(epoch from (c.expires_at - now())) / 3600 end as hrs,
               row_number() over (
                 partition by (case when c.status = 'sent' and exists (select 1 from audit_logs a where a.contract_id = c.id and a.action = 'contract.viewed') then 'viewed'
                                    when c.status in ('expired', 'cancelled') then 'expired' else c.status end)
                 order by coalesce(c.signed_at, c.issued_at) desc) as rn
        from contracts c join users u on u.id = c.customer_id
        where c.workspace_id = ${workspaceId} and c.status <> 'draft' and c.archived_at is null
          and coalesce(c.signed_at, c.issued_at) > now() - interval '90 days'
      ) t where t.rn <= ${per}`),
  ]);
  const cmap = new Map(counts.rows.map((r) => [r.stage, r]));
  const stages = STAGES.map((s) => {
    const items = rows.rows
      .filter((r) => r.stage === s.key)
      .map((r) => ({ id: r.id, number: r.number, title: r.title, customer: r.name, email: r.email, ageDays: Math.max(0, Number(r.days)), value: r.value === null ? null : Number(r.value), expiresInHours: r.hrs === null ? null : Math.round(Number(r.hrs)) }));
    const c = cmap.get(s.key);
    return { key: s.key, label: s.label, count: c ? Number(c.n) : 0, value: c ? Number(c.v) : 0, items };
  });
  return { stages, total: stages.reduce((a, s) => a + s.count, 0) };
}

/* ───────────── جزئیات قرارداد ───────────── */

const TIMELINE_ACTIONS = new Set(["contract.issued", "contract.viewed", "contract.signed", "contract.completed", "contract.rejected", "contract.cancelled", "contract.expired", "contract.reminder", "contract.published", "document.downloaded"]);

export async function getContractDetail(workspaceId: number, id: number) {
  const [row] = await db
    .select({ c: contracts, name: users.name, email: users.email, mobile: users.mobile })
    .from(contracts)
    .innerJoin(users, eq(users.id, contracts.customerId))
    .where(and(eq(contracts.id, id), eq(contracts.workspaceId, workspaceId)));
  if (!row) return null;
  const c = row.c;
  const [signers, logs, tplRows, linkRows] = await Promise.all([
    db
      .select({ id: contractSigners.id, position: contractSigners.position, label: contractSigners.label, status: contractSigners.status, signedAt: contractSigners.signedAt, name: users.name })
      .from(contractSigners)
      .innerJoin(users, eq(users.id, contractSigners.userId))
      .where(eq(contractSigners.contractId, id))
      .orderBy(asc(contractSigners.position)),
    db.select({ action: auditLogs.action, detail: auditLogs.detail, at: auditLogs.createdAt }).from(auditLogs).where(eq(auditLogs.contractId, id)).orderBy(desc(auditLogs.createdAt)).limit(60),
    c.templateId ? db.select({ id: templates.id, title: templates.title }).from(templates).where(eq(templates.id, c.templateId)) : Promise.resolve([] as { id: number; title: string }[]),
    db.select({ order: wcContractLinks.wcOrderId }).from(wcContractLinks).where(eq(wcContractLinks.contractId, id)),
  ]);
  const tpl = tplRows[0];
  const link = linkRows[0];
  const pending = signers.find((s) => s.status === "pending");
  let signUrl: string | null = null;
  if (c.status === "sent" && pending) {
    const sl = await getOrCreateSigningLink(pending.id).catch(() => null);
    if (sl) signUrl = await signingUrl(sl.token, workspaceId);
  }
  return {
    id: c.id,
    number: c.number,
    title: c.title,
    status: c.status,
    statusLabel: STATUS_LABELS[c.status] ?? c.status,
    issuedAt: c.issuedAt,
    signedAt: c.signedAt,
    expiresAt: c.expiresAt,
    termEndsAt: c.termEndsAt,
    value: c.contractValue,
    reminders: c.reminderCount,
    lastReminderAt: c.lastReminderAt,
    customer: { name: row.name, email: row.email, mobile: row.mobile },
    template: tpl ? { id: tpl.id, title: tpl.title } : null,
    orderId: link?.order || null,
    signers: signers.map((s) => ({ position: s.position, label: s.label, name: s.name, status: s.status, signedAt: s.signedAt })),
    nextSigner: pending ? { label: pending.label, name: pending.name } : null,
    signUrl,
    canRemind: c.status === "sent",
    canCancel: c.status === "sent",
    canDownload: c.status === "signed",
    timeline: logs
      .filter((l) => TIMELINE_ACTIONS.has(l.action))
      .map((l) => ({ action: l.action, label: ACTION_LABELS[l.action] ?? l.action, detail: (l.detail ?? "").slice(0, 160), at: l.at })),
  };
}
