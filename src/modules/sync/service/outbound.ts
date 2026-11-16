import { type Conn, MAX_BATCH } from "./util";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { contractSigners, contracts, users, wcContractLinks, wpConnections, wpOutbox } from "@/db/schema";
import { db } from "@/db";
import { isLocalSite } from "@/modules/connect/service";
import { newEventId, signBody } from "../sign";
import { secretOf } from "./connection";

/* ───────────── خروجی: ابر → وردپرس ───────────── */

export async function enqueueEvent(c: Pick<Conn, "id" | "workspaceId">, event: string, data: Record<string, unknown>) {
  const eventId = newEventId();
  await db.insert(wpOutbox).values({ workspaceId: c.workspaceId, connectionId: c.id, eventId, event, payload: JSON.stringify(data) });
  return eventId;
}
/** وضعیت فعلی یک قرارداد به‌صورت بار رویداد (برای رویداد و برای هم‌ترازسازی) */
export async function contractSnapshot(contractId: number) {
  const [row] = await db
    .select({ c: contracts, l: wcContractLinks })
    .from(contracts)
    .leftJoin(wcContractLinks, eq(wcContractLinks.contractId, contracts.id))
    .where(eq(contracts.id, contractId));
  if (!row) return null;
  const signers = await db
    .select({ label: contractSigners.label, status: contractSigners.status, signedAt: contractSigners.signedAt, position: contractSigners.position })
    .from(contractSigners)
    .where(eq(contractSigners.contractId, contractId))
    .orderBy(asc(contractSigners.position));
  const [cust] = await db.select({ email: users.email, name: users.name, mobile: users.mobile }).from(users).where(eq(users.id, row.c.customerId));
  return {
    contractId: row.c.id,
    number: row.c.number,
    title: row.c.title,
    templateId: row.c.templateId ?? 0,
    value: row.c.contractValue ?? 0,
    termEndsAt: row.c.termEndsAt?.toISOString() ?? null,
    customer: cust ? { email: cust.email, name: cust.name } : null,
    status: row.c.status,
    issuedAt: row.c.issuedAt?.toISOString() ?? null,
    signedAt: row.c.signedAt?.toISOString() ?? null,
    expiresAt: row.c.expiresAt?.toISOString() ?? null,
    wcOrderId: row.l?.wcOrderId ?? 0,
    wcProductId: row.l?.wcProductId ?? 0,
    externalKey: row.l?.externalKey ?? "",
    signers: signers.map((s) => ({ label: s.label, status: s.status, signedAt: s.signedAt?.toISOString() ?? null })),
    pendingSigners: signers.filter((s) => s.status !== "signed").length,
  };
}
/** صف‌کردن رویداد قرارداد برای سایت وردپرسِ پیوندخورده (اگر قرارداد از ووکامرس صادر نشده باشد، کاری نمی‌کند) */
export async function enqueueContractEvent(contractId: number, event: string): Promise<void> {
  const [link] = await db.select().from(wcContractLinks).where(eq(wcContractLinks.contractId, contractId));
  let c: Conn | undefined;
  if (link) {
    [c] = await db.select().from(wpConnections).where(eq(wpConnections.id, link.connectionId));
  } else {
    // قرارداد دستی/شورت‌کد/API: رویداد به سایت وردپرسِ فعالِ همان فضای کاری می‌رسد تا دروازه‌ها، نقش‌ها و اتوماسیون‌های سایت کار کنند
    const [ct] = await db.select({ workspaceId: contracts.workspaceId }).from(contracts).where(eq(contracts.id, contractId));
    if (!ct) return;
    [c] = await db
      .select()
      .from(wpConnections)
      .where(and(eq(wpConnections.workspaceId, ct.workspaceId), eq(wpConnections.status, "active")))
      .orderBy(desc(wpConnections.lastSeenAt))
      .limit(1);
  }
  if (!c || c.status !== "active" || !c.syncEnabled) return;
  const snap = await contractSnapshot(contractId);
  if (!snap) return;
  await enqueueEvent(c, event, snap);
  void dispatchOutbox(c.id).catch(() => undefined);
}
const inflight = new Set<number>();
function canPush(c: Conn): boolean {
  if (c.status !== "active" || !c.syncEnabled || !c.syncSecret) return false;
  if (!c.capabilities.split(",").includes("push")) return false;
  try {
    return !isLocalSite(new URL(c.siteUrl));
  } catch {
    return false;
  }
}
async function pushBatch(c: Conn, rows: (typeof wpOutbox.$inferSelect)[]) {
  const body = JSON.stringify({ events: rows.map((r) => ({ id: r.eventId, type: r.event, at: Math.floor(r.createdAt.getTime() / 1000), data: JSON.parse(r.payload) as unknown })) });
  const ts = Math.floor(Date.now() / 1000);
  const target = await assertSafeUrl(`${c.siteUrl}/?rest_route=${encodeURIComponent("/emzagar/v1/events")}`);
  const res = await safeFetch(target, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(9000),
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "EmzagarCloud/2.0", "X-Emzagar-Timestamp": String(ts), "X-Emzagar-Signature": signBody(secretOf(c), ts, body) },
    body,
  });
  const text = (await res.text()).slice(0, 20_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = JSON.parse(text) as { ok?: boolean; results?: { id?: string; status?: string }[] };
  if (!j.ok || !Array.isArray(j.results)) throw new Error("پاسخ نامعتبر از وردپرس");
  return new Map(j.results.map((r) => [String(r.id), String(r.status)]));
}
/** ارسال رویدادهای سررسیدشده؛ بدون وقفه در جریان اصلی. connectionId نبود = همه‌ی اتصال‌ها */
export async function dispatchOutbox(connectionId?: number): Promise<{ pushed: number; failed: number }> {
  const out = { pushed: 0, failed: 0 };
  await db.update(wpOutbox).set({ status: "dead", lastError: "مهلت ۷ روزه‌ی تحویل تمام شد" }).where(and(eq(wpOutbox.status, "pending"), sql`${wpOutbox.createdAt} < now() - interval '7 days'`));
  const due = await db
    .select({ connectionId: wpOutbox.connectionId })
    .from(wpOutbox)
    .where(and(eq(wpOutbox.status, "pending"), lte(wpOutbox.nextAttemptAt, new Date()), connectionId ? eq(wpOutbox.connectionId, connectionId) : undefined))
    .groupBy(wpOutbox.connectionId)
    .limit(50);
  for (const { connectionId: id } of due) {
    if (inflight.has(id)) continue;
    inflight.add(id);
    try {
      const [c] = await db.select().from(wpConnections).where(eq(wpConnections.id, id));
      if (!c || !canPush(c)) continue; // فقط Pull
      const rows = await db
        .select()
        .from(wpOutbox)
        .where(and(eq(wpOutbox.connectionId, id), eq(wpOutbox.status, "pending"), lte(wpOutbox.nextAttemptAt, new Date())))
        .orderBy(asc(wpOutbox.id))
        .limit(MAX_BATCH);
      if (rows.length === 0) continue;
      try {
        const res = await pushBatch(c, rows);
        const okIds = rows.filter((r) => ["ok", "duplicate", "ignored"].includes(res.get(r.eventId) ?? "")).map((r) => r.id);
        if (okIds.length) await db.update(wpOutbox).set({ status: "delivered", deliveredAt: new Date(), deliveredVia: "push", lastError: null }).where(inArray(wpOutbox.id, okIds));
        for (const r of rows.filter((x) => !okIds.includes(x.id))) await backoff(r.id, r.attempts, res.get(r.eventId) || "no_result");
        out.pushed += okIds.length;
        out.failed += rows.length - okIds.length;
        await db.update(wpConnections).set({ lastSyncOutAt: new Date(), lastPushError: "" }).where(eq(wpConnections.id, id));
      } catch (e) {
        const msg = (e instanceof Error ? e.message : "خطا").slice(0, 200);
        for (const r of rows) await backoff(r.id, r.attempts, msg);
        out.failed += rows.length;
        await db.update(wpConnections).set({ lastPushError: msg }).where(eq(wpConnections.id, id));
      }
    } finally {
      inflight.delete(id);
    }
  }
  return out;
}
async function backoff(id: number, attempts: number, error: string) {
  const next = new Date(Date.now() + Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(attempts, 10)));
  await db.update(wpOutbox).set({ attempts: attempts + 1, lastError: error.slice(0, 300), nextAttemptAt: next }).where(eq(wpOutbox.id, id));
}
/** Pull توسط افزونه: رویدادهای تایید‌شده (ack) بسته می‌شوند و رویدادهای معلق برگردانده می‌شود */
export async function pullEvents(c: Conn, ack: string[], limit: number) {
  const ids = ack.filter((x) => /^[A-Za-z0-9_.:-]{6,64}$/.test(x)).slice(0, 200);
  if (ids.length) {
    await db
      .update(wpOutbox)
      .set({ status: "delivered", deliveredAt: new Date(), deliveredVia: "pull", lastError: null })
      .where(and(eq(wpOutbox.connectionId, c.id), inArray(wpOutbox.eventId, ids), eq(wpOutbox.status, "pending")));
  }
  const rows = await db
    .select()
    .from(wpOutbox)
    .where(and(eq(wpOutbox.connectionId, c.id), eq(wpOutbox.status, "pending")))
    .orderBy(asc(wpOutbox.id))
    .limit(Math.max(1, Math.min(MAX_BATCH, limit)));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(wpOutbox).where(and(eq(wpOutbox.connectionId, c.id), eq(wpOutbox.status, "pending")));
  await db.update(wpConnections).set({ lastPullAt: new Date(), lastSeenAt: new Date() }).where(eq(wpConnections.id, c.id));
  return {
    events: rows.map((r) => ({ id: r.eventId, type: r.event, at: Math.floor(r.createdAt.getTime() / 1000), data: JSON.parse(r.payload) as unknown })),
    pending: n,
    secretAt: c.syncSecretAt ? Math.floor(c.syncSecretAt.getTime() / 1000) : 0,
  };
}
/* ───────────── اقدام‌های مدیر (پنل ابر) ───────────── */

export async function retryOutbox(workspaceId: number, connId?: number) {
  const where = and(eq(wpOutbox.workspaceId, workspaceId), inArray(wpOutbox.status, ["pending", "dead"]), connId ? eq(wpOutbox.connectionId, connId) : undefined);
  const touched = await db.update(wpOutbox).set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null }).where(where).returning({ id: wpOutbox.id });
  const res = await dispatchOutbox(connId);
  return { requeued: touched.length, ...res };
}
export async function sendPing(workspaceId: number, connId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return false;
  await enqueueEvent(c, "sync.ping", { at: new Date().toISOString(), from: "cloud" });
  await dispatchOutbox(c.id).catch(() => undefined);
  return true;
}
/** از افزونه می‌خواهد همه‌ی سفارش‌ها را دوباره بفرستد (هم‌ترازسازی کامل) */
export async function requestResync(workspaceId: number, connId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return false;
  await enqueueEvent(c, "sync.resync", { scope: "orders" });
  await dispatchOutbox(c.id).catch(() => undefined);
  return true;
}
