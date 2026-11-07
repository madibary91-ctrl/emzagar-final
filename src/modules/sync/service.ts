import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { contracts, contractSigners, users, wcContractLinks, wcOrders, workspaceMembers, wpConnections, wpInbound, wpOutbox } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { assertSafeUrl, safeFetch } from "@/lib/ssrf";
import { logAudit } from "@/modules/audit/service";
import { isLocalSite } from "@/modules/connect/service";
import { newEventId, newSyncSecret, signBody } from "./sign";

/**
 * موتور همگام‌سازی دوطرفه‌ی ووکامرس ↔ ابر امضاگیر
 * ───────────────────────────────────────────────
 * وردپرس → ابر : سفارش‌ها، تغییر وضعیت، استرداد، مشتریان (دسته‌ای، ایدمپوتنت، با امضای HMAC)
 * ابر → وردپرس : وضعیت قرارداد (صدور/امضا/تکمیل/رد/انقضا/لغو) از طریق صف خروجی (Outbox):
 *   ۱) Push فوری و امضاشده به /wp-json/emzagar/v1/events (برای سایت‌های قابل‌دسترس)
 *   ۲) Pull توسط افزونه (برای سایت‌های پشت فایروال/لوکال) + تایید دریافت (ACK)
 *   ۳) تلاش مجدد با backoff نمایی؛ رویداد تحویل‌نشده تا ۷ روز نگه داشته می‌شود.
 */

export type Conn = typeof wpConnections.$inferSelect;

const MAX_BATCH = 50;
const DEAD_AFTER_MS = 7 * 24 * 3600_000;
const FINAL_ORDER_BAD = new Set(["cancelled", "failed", "refunded"]);
export const SYNC_CONTRACT_EVENTS = ["contract.issued", "contract.signed", "contract.completed", "contract.rejected", "contract.expired", "contract.cancelled", "contract.reminder"] as const;

const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n < 2_000_000_000 ? n : 0;
};
const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? n.toFixed(2) : "0.00";
};
function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "" || v === 0) return null;
  const n = Number(v);
  const d = Number.isFinite(n) && n > 0 ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) || d.getFullYear() < 2000 || d.getFullYear() > 2100 ? null : d;
}

/* ───────────── اتصال و راز مشترک ───────────── */

export async function connectionByKey(keyId: number): Promise<Conn | null> {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.apiKeyId, keyId), eq(wpConnections.status, "active")));
  return c ?? null;
}

export function secretOf(c: Conn): string {
  return decryptSecret(c.syncSecret);
}

/** دست‌دادن همگام‌سازی: اگر راز نبود (یا rotate) ساخته می‌شود؛ قابلیت‌های افزونه ثبت می‌گردد */
export async function syncHandshake(c: Conn, opts: { rotate?: boolean; capabilities?: string } = {}) {
  let secret = secretOf(c);
  let at = c.syncSecretAt;
  if (!secret || opts.rotate) {
    secret = newSyncSecret();
    at = new Date();
  }
  const caps = clean(opts.capabilities, 200)
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[a-z_]{2,20}$/.test(x))
    .join(",");
  await db
    .update(wpConnections)
    .set({ syncSecret: encryptSecret(secret), syncSecretAt: at, capabilities: caps || c.capabilities, lastSeenAt: new Date() })
    .where(eq(wpConnections.id, c.id));
  return { secret, secretAt: Math.floor((at ?? new Date()).getTime() / 1000) };
}

export async function rotateSyncSecret(workspaceId: number, connId: number) {
  const [c] = await db.select().from(wpConnections).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
  if (!c) return false;
  await syncHandshake(c, { rotate: true });
  await logAudit({ action: "apikey.created", workspaceId, detail: `چرخش راز همگام‌سازی ${c.siteHost}`, actor: "wp-sync" });
  return true;
}

export async function setSyncEnabled(workspaceId: number, connId: number, enabled: boolean) {
  await db.update(wpConnections).set({ syncEnabled: enabled }).where(and(eq(wpConnections.id, connId), eq(wpConnections.workspaceId, workspaceId)));
}

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

/* ───────────── پیوند قرارداد ↔ سفارش ───────────── */

export type ExternalRef = { source: "woocommerce"; orderId: number; productId: number; key: string };

export function parseExternal(raw: unknown): ExternalRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const key = clean(r.key, 80);
  if (r.source !== "woocommerce" || !/^[A-Za-z0-9_.:-]{3,80}$/.test(key)) return null;
  return { source: "woocommerce", orderId: int(r.orderId), productId: int(r.productId), key };
}

export async function findLinkByKey(connectionId: number, key: string) {
  const [l] = await db.select().from(wcContractLinks).where(and(eq(wcContractLinks.connectionId, connectionId), eq(wcContractLinks.externalKey, key)));
  return l ?? null;
}

export async function createLink(c: Conn, contractId: number, ref: ExternalRef) {
  await db
    .insert(wcContractLinks)
    .values({ workspaceId: c.workspaceId, connectionId: c.id, contractId, wcOrderId: ref.orderId, wcProductId: ref.productId, externalKey: ref.key })
    .onConflictDoNothing();
}

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
