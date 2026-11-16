import { type Conn, FINAL_ORDER_BAD, MAX_BATCH, clean, int, money, toDate } from "./util";
import { and, eq, sql } from "drizzle-orm";
import { contracts, users, wcContractLinks, wcOrders, workspaceMembers, wpConnections, wpInbound } from "@/db/schema";
import { db } from "@/db";
import { logAudit } from "@/modules/audit/service";

/* ───────────── ورودی: وردپرس → ابر ───────────── */

export type InboundEvent = { id: string; type: string; at?: unknown; data?: Record<string, unknown> };
export type EventResult = { id: string; status: "ok" | "duplicate" | "ignored" | "error"; error?: string };
export function parseEvents(raw: unknown): InboundEvent[] | null {
  const list = raw && typeof raw === "object" ? (raw as { events?: unknown }).events : null;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH) return null;
  const out: InboundEvent[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") return null;
    const ev = e as Record<string, unknown>;
    const id = clean(ev.id, 64);
    const type = clean(ev.type, 40);
    if (!/^[A-Za-z0-9_.:-]{6,64}$/.test(id) || !/^[a-z_]+\.[a-z_]+$/.test(type)) return null;
    out.push({ id, type, at: ev.at, data: ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>) : {} });
  }
  return out;
}
type Item = { productId: number; name: string; qty: number; total: string; templateId: number };
function parseItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((x) => {
    const i = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return { productId: int(i.productId), name: clean(i.name, 200), qty: Math.max(0, Math.min(100000, Number(i.qty) || 0)), total: money(i.total), templateId: int(i.templateId) };
  });
}
async function applyOrder(c: Conn, type: string, d: Record<string, unknown>): Promise<"ok" | "ignored"> {
  const wcOrderId = int(d.orderId);
  if (!wcOrderId) throw new Error("orderId_invalid");
  const incomingUpdated = toDate(d.updatedAt);
  const status = type === "order.deleted" ? "trash" : clean(d.status, 30).replace(/^wc-/, "") || "pending";
  const [existing] = await db.select().from(wcOrders).where(and(eq(wcOrders.connectionId, c.id), eq(wcOrders.wcOrderId, wcOrderId)));
  // رویداد قدیمی‌تر از داده‌ی ذخیره‌شده (رسیدن نامرتب) هرگز داده‌ی جدیدتر را بازنویسی نمی‌کند
  if (existing?.wcUpdatedAt && incomingUpdated && incomingUpdated.getTime() < existing.wcUpdatedAt.getTime()) return "ignored";

  const base = {
    workspaceId: c.workspaceId,
    connectionId: c.id,
    wcOrderId,
    status,
    syncedAt: new Date(),
    ...(type === "order.deleted"
      ? {}
      : {
          number: clean(d.number, 40) || String(wcOrderId),
          currency: clean(d.currency, 8).toUpperCase(),
          total: money(d.total),
          refunded: money(d.refunded),
          customerEmail: clean(d.email, 200).toLowerCase(),
          customerName: clean(d.name, 120),
          customerPhone: clean(d.phone, 30),
          wcCustomerId: int(d.customerId),
          paymentMethod: clean(d.paymentMethod, 60),
          itemsJson: JSON.stringify(parseItems(d.items)),
          wcCreatedAt: toDate(d.createdAt),
        }),
    wcUpdatedAt: incomingUpdated ?? new Date(),
  };
  if (existing) await db.update(wcOrders).set(base).where(eq(wcOrders.id, existing.id));
  else await db.insert(wcOrders).values(base);

  if (FINAL_ORDER_BAD.has(status) || status === "trash") await cancelLinkedContracts(c, wcOrderId, status);
  return "ok";
}
/** سفارش لغو/ناموفق/مسترد شد → قراردادهای هنوز امضانشده‌ی همان سفارش خودکار لغو می‌شوند */
async function cancelLinkedContracts(c: Conn, wcOrderId: number, orderStatus: string) {
  const rows = await db
    .select({ id: contracts.id, number: contracts.number, title: contracts.title })
    .from(wcContractLinks)
    .innerJoin(contracts, eq(contracts.id, wcContractLinks.contractId))
    .where(and(eq(wcContractLinks.connectionId, c.id), eq(wcContractLinks.wcOrderId, wcOrderId), eq(contracts.status, "sent")));
  if (rows.length === 0) return;
  const { revokeSigningLinks } = await import("@/modules/signing/links");
  const { emitEvent } = await import("@/modules/webhooks/service");
  for (const r of rows) {
    const done = await db.update(contracts).set({ status: "cancelled" }).where(and(eq(contracts.id, r.id), eq(contracts.status, "sent"))).returning({ id: contracts.id });
    if (done.length === 0) continue;
    await revokeSigningLinks({ contractId: r.id });
    await logAudit({ action: "contract.cancelled", workspaceId: c.workspaceId, contractId: r.id, detail: `${r.number} — لغو خودکار: سفارش ووکامرس ${wcOrderId} در وضعیت «${orderStatus}»`, actor: "wp-sync" });
    emitEvent({ event: "contract.cancelled", contractId: r.id, text: `🚫 قرارداد ${r.number} — «${r.title}» به‌دلیل لغو/استرداد سفارش ووکامرس لغو شد.`, data: { number: r.number } });
  }
}
/** به‌روزرسانی نام/موبایل مشتری‌ای که همین فضای کاری او را می‌شناسد (هرگز ادمین یا کاربر بیرونی) */
async function applyCustomer(c: Conn, d: Record<string, unknown>): Promise<"ok" | "ignored"> {
  const email = clean(d.email, 200).toLowerCase();
  if (!email) throw new Error("email_invalid");
  const [u] = await db
    .select({ id: users.id, role: users.role, name: users.name, mobile: users.mobile })
    .from(users)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, users.id), eq(workspaceMembers.workspaceId, c.workspaceId)))
    .where(eq(users.email, email));
  if (!u || u.role !== "user") return "ignored";
  const name = clean(d.name, 100);
  const phone = clean(d.phone, 11);
  const set: { name?: string; mobile?: string } = {};
  if (name && name !== u.name) set.name = name;
  if (/^09\d{9}$/.test(phone) && phone !== u.mobile) set.mobile = phone;
  if (Object.keys(set).length === 0) return "ignored";
  await db.update(users).set(set).where(eq(users.id, u.id));
  return "ok";
}
export async function ingestEvents(c: Conn, events: InboundEvent[]): Promise<EventResult[]> {
  const results: EventResult[] = [];
  for (const ev of events) {
    try {
      const [seen] = await db.select({ status: wpInbound.status }).from(wpInbound).where(and(eq(wpInbound.connectionId, c.id), eq(wpInbound.eventId, ev.id)));
      if (seen && seen.status !== "error") {
        results.push({ id: ev.id, status: "duplicate" });
        continue;
      }
      let outcome: "ok" | "ignored" = "ok";
      if (ev.type.startsWith("order.")) outcome = await applyOrder(c, ev.type, ev.data ?? {});
      else if (ev.type === "customer.upserted") outcome = await applyCustomer(c, ev.data ?? {});
      else if (ev.type === "sync.ping") outcome = "ok";
      else outcome = "ignored";
      await db
        .insert(wpInbound)
        .values({ workspaceId: c.workspaceId, connectionId: c.id, eventId: ev.id, type: ev.type, status: outcome })
        .onConflictDoUpdate({ target: [wpInbound.connectionId, wpInbound.eventId], set: { status: outcome, detail: null } });
      results.push({ id: ev.id, status: outcome });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : "error").slice(0, 200);
      await db
        .insert(wpInbound)
        .values({ workspaceId: c.workspaceId, connectionId: c.id, eventId: ev.id, type: ev.type, status: "error", detail: msg })
        .onConflictDoUpdate({ target: [wpInbound.connectionId, wpInbound.eventId], set: { status: "error", detail: msg } })
        .catch(() => undefined);
      results.push({ id: ev.id, status: "error", error: msg });
    }
  }
  await db.update(wpConnections).set({ lastSyncInAt: new Date(), lastSeenAt: new Date() }).where(eq(wpConnections.id, c.id));
  // پاک‌سازی گاه‌به‌گاه لاگ ورودی قدیمی (۹۰ روز)
  if (Math.random() < 0.02) await db.delete(wpInbound).where(sql`${wpInbound.createdAt} < now() - interval '90 days'`).catch(() => undefined);
  return results;
}
