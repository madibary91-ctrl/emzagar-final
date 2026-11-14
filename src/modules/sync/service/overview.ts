import { type Conn } from "./util";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { contractSnapshot } from "./outbound";
import { contracts, wcContractLinks, wcOrders, wpConnections, wpInbound, wpOutbox } from "@/db/schema";
import { db } from "@/db";

/* ───────────── گزارش‌ها ───────────── */

export type Health = { state: "healthy" | "stale" | "degraded" | "offline" | "disconnected" | "paused"; label: string; hints: string[] };
export function connectionHealth(c: Conn, backlog: number): Health {
  const hints: string[] = [];
  if (c.status !== "active") return { state: "disconnected", label: "قطع‌شده", hints: ["با فعال‌سازی دوباره‌ی افزونه، اتصال برقرار می‌شود."] };
  if (!c.syncEnabled) return { state: "paused", label: "همگام‌سازی متوقف", hints: ["همگام‌سازی از پنل متوقف شده است."] };
  const age = c.lastSeenAt ? Date.now() - c.lastSeenAt.getTime() : Infinity;
  if (!c.syncSecret) hints.push("افزونه هنوز نسخه‌ی ۲ را اجرا نکرده یا دست‌دادن همگام‌سازی انجام نشده است.");
  if (c.lastPushError) hints.push(`ارسال مستقیم به سایت ناموفق است (${c.lastPushError}). رویدادها از مسیر Pull تحویل می‌شوند.`);
  if (backlog > 20) hints.push(`${backlog.toLocaleString("fa-IR")} رویداد در صف تحویل است.`);
  if (age > 3 * 24 * 3600_000) return { state: "offline", label: "بدون ارتباط", hints: [...hints, "بیش از ۳ روز از آخرین ارتباط می‌گذرد؛ سایت یا WP-Cron را بررسی کنید."] };
  if (age > 36 * 3600_000) return { state: "stale", label: "ارتباط قدیمی", hints: [...hints, "بیش از ۳۶ ساعت از آخرین ارتباط می‌گذرد."] };
  if (hints.length) return { state: "degraded", label: "نیازمند توجه", hints };
  return { state: "healthy", label: "سالم و همگام", hints };
}
export async function syncOverview(workspaceId: number) {
  const conns = await db.select().from(wpConnections).where(eq(wpConnections.workspaceId, workspaceId)).orderBy(desc(wpConnections.createdAt));
  const backlogRows = await db
    .select({ id: wpOutbox.connectionId, n: sql<number>`count(*)::int` })
    .from(wpOutbox)
    .where(and(eq(wpOutbox.workspaceId, workspaceId), eq(wpOutbox.status, "pending")))
    .groupBy(wpOutbox.connectionId);
  const backlog = new Map(backlogRows.map((r) => [r.id, r.n]));
  const [o] = await db
    .select({
      orders: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(case when ${wcOrders.status} in ('processing','completed','on-hold') then ${wcOrders.total} - ${wcOrders.refunded} else 0 end),0)::text`,
      customers: sql<number>`count(distinct nullif(${wcOrders.customerEmail}, ''))::int`,
    })
    .from(wcOrders)
    .where(eq(wcOrders.workspaceId, workspaceId));
  const [l] = await db
    .select({
      total: sql<number>`count(*)::int`,
      signed: sql<number>`count(*) filter (where ${contracts.status} = 'signed')::int`,
      waiting: sql<number>`count(*) filter (where ${contracts.status} = 'sent')::int`,
    })
    .from(wcContractLinks)
    .innerJoin(contracts, eq(contracts.id, wcContractLinks.contractId))
    .where(eq(wcContractLinks.workspaceId, workspaceId));
  const [ob] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${wpOutbox.status} = 'pending')::int`,
      dead: sql<number>`count(*) filter (where ${wpOutbox.status} = 'dead')::int`,
      delivered24: sql<number>`count(*) filter (where ${wpOutbox.status} = 'delivered' and ${wpOutbox.deliveredAt} > now() - interval '24 hours')::int`,
    })
    .from(wpOutbox)
    .where(eq(wpOutbox.workspaceId, workspaceId));
  const [ib] = await db
    .select({ in24: sql<number>`count(*) filter (where ${wpInbound.createdAt} > now() - interval '24 hours')::int`, errors24: sql<number>`count(*) filter (where ${wpInbound.status} = 'error' and ${wpInbound.createdAt} > now() - interval '24 hours')::int` })
    .from(wpInbound)
    .where(eq(wpInbound.workspaceId, workspaceId));
  return {
    connections: conns.map((c) => ({ conn: c, backlog: backlog.get(c.id) ?? 0, health: connectionHealth(c, backlog.get(c.id) ?? 0) })),
    stats: { orders: o?.orders ?? 0, revenue: Number(o?.revenue ?? 0), customers: o?.customers ?? 0, contracts: l?.total ?? 0, signed: l?.signed ?? 0, waiting: l?.waiting ?? 0, pending: ob?.pending ?? 0, dead: ob?.dead ?? 0, delivered24: ob?.delivered24 ?? 0, in24: ib?.in24 ?? 0, errors24: ib?.errors24 ?? 0 },
  };
}
export async function listSyncedOrders(workspaceId: number, limit = 25) {
  const rows = await db.select().from(wcOrders).where(eq(wcOrders.workspaceId, workspaceId)).orderBy(desc(wcOrders.wcCreatedAt), desc(wcOrders.id)).limit(limit);
  if (rows.length === 0) return [];
  const links = await db
    .select({ connectionId: wcContractLinks.connectionId, wcOrderId: wcContractLinks.wcOrderId, contractId: contracts.id, number: contracts.number, status: contracts.status })
    .from(wcContractLinks)
    .innerJoin(contracts, eq(contracts.id, wcContractLinks.contractId))
    .where(and(eq(wcContractLinks.workspaceId, workspaceId), inArray(wcContractLinks.wcOrderId, rows.map((r) => r.wcOrderId))));
  return rows.map((o) => ({ order: o, contracts: links.filter((l) => l.connectionId === o.connectionId && l.wcOrderId === o.wcOrderId) }));
}
export async function recentSyncLog(workspaceId: number, limit = 30) {
  const [inb, outb] = await Promise.all([
    db.select().from(wpInbound).where(eq(wpInbound.workspaceId, workspaceId)).orderBy(desc(wpInbound.createdAt)).limit(limit),
    db.select().from(wpOutbox).where(eq(wpOutbox.workspaceId, workspaceId)).orderBy(desc(wpOutbox.createdAt)).limit(limit),
  ]);
  const items = [
    ...inb.map((r) => ({ key: `i${r.id}`, dir: "in" as const, event: r.type, status: r.status, detail: r.detail ?? "", at: r.createdAt })),
    ...outb.map((r) => ({ key: `o${r.id}`, dir: "out" as const, event: r.event, status: r.status === "delivered" ? `delivered:${r.deliveredVia ?? ""}` : r.status, detail: r.lastError ?? "", at: r.createdAt })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}
/** وضعیت چند قرارداد (برای هم‌ترازسازی افزونه در صورت از دست رفتن رویداد) */
export async function statusesForContracts(workspaceId: number, ids: number[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: contracts.id })
    .from(contracts)
    .where(and(eq(contracts.workspaceId, workspaceId), inArray(contracts.id, ids.slice(0, 50)), gt(contracts.id, 0)));
  const out = [];
  for (const r of rows) {
    const s = await contractSnapshot(r.id);
    if (s) out.push(s);
  }
  return out;
}
