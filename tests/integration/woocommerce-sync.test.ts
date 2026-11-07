/**
 * همگام‌سازی دوطرفه ووکامرس ↔ ابر (پروتکل کامل از طریق همان Route Handlerهای واقعی)
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { contracts, users, wcContractLinks, wcOrders, wpConnections, wpInbound, wpOutbox } from "@/db/schema";
import { completeHandshake, startHandshake } from "@/modules/connect/service";
import { dispatchOutbox, enqueueContractEvent, secretOf } from "@/modules/sync/service";
import { signBody } from "@/modules/sync/sign";
import { POST as handshakePOST } from "@/app/api/v1/sync/handshake/route";
import { POST as eventsPOST } from "@/app/api/v1/sync/events/route";
import { POST as pullPOST } from "@/app/api/v1/sync/pull/route";
import { POST as issuePOST, GET as listGET } from "@/app/api/v1/contracts/route";
import { uniq } from "../helpers";

vi.mock("@/lib/ssrf", async (orig) => {
  const m = await orig<typeof import("@/lib/ssrf")>();
  return { ...m, assertSafeUrl: async (u: string) => new URL(u) };
});

let apiKey = "";
let secret = "";
let workspaceId = 0;
let templateId = 0;
let connId = 0;
const origin = "http://localhost:3000";

const auth = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...extra });
const req = (path: string, body: unknown, headers: Record<string, string>) => new Request(`${origin}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function sendEvents(events: unknown[], opts: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify({ events });
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const res = await eventsPOST(req("/api/v1/sync/events", raw, auth({ "x-emzagar-timestamp": String(ts), "x-emzagar-signature": signBody(opts.secret ?? secret, ts, raw) })));
  return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; results?: { id: string; status: string }[] } };
}

const orderEvent = (id: string, orderId: number, over: Record<string, unknown> = {}) => ({
  id,
  type: "order.upserted",
  at: Math.floor(Date.now() / 1000),
  data: { orderId, number: String(orderId), status: "processing", currency: "IRT", total: "1500000", refunded: "0", email: "buyer@example.com", name: "خریدار", phone: "09120000001", customerId: 0, paymentMethod: "zarinpal", items: [{ productId: 7, name: "دوره", qty: 1, total: "1500000", templateId }], createdAt: 1_760_000_000, updatedAt: 1_760_000_100, ...over },
});

beforeAll(async () => {
  const siteUrl = `http://${uniq("wp")}.test`; // سایت محلی/آزمایشی (حالت Sandbox)
  const hs = await startHandshake({ installId: "a1".repeat(16), siteUrl, siteName: "فروشگاه آزمایشی", adminEmail: `${uniq("owner")}@example.com`, adminName: "مدیر", pluginVersion: "2.0.0", wpVersion: "6.7", wcActive: true, locale: "fa_IR" });
  const done = await completeHandshake(hs.handshakeId);
  apiKey = done.apiKey;
  workspaceId = done.workspaceId;
  templateId = done.defaultTemplateId;
  const [c] = await db.select().from(wpConnections).where(eq(wpConnections.workspaceId, workspaceId));
  connId = c.id;
});

afterEach(() => vi.restoreAllMocks());

describe("دست‌دادن و امنیت", () => {
  it("بدون دست‌دادن، ارسال رویداد 428 می‌دهد؛ سپس راز ساخته می‌شود", async () => {
    const raw = JSON.stringify({ events: [orderEvent("evt_nohandshake1", 1)] });
    const r = await eventsPOST(req("/api/v1/sync/events", raw, auth({ "x-emzagar-timestamp": "1", "x-emzagar-signature": "x" })));
    expect(r.status).toBe(428);
    const h = await handshakePOST(req("/api/v1/sync/handshake", { capabilities: "push,pull,orders" }, auth()));
    const j = (await h.json()) as { ok: boolean; secret: string; secretAt: number };
    expect(j.ok).toBe(true);
    expect(j.secret).toMatch(/^[a-f0-9]{64}$/);
    secret = j.secret;
    // دست‌دادن دوباره همان راز را برمی‌گرداند (چرخش فقط با rotate)
    const again = (await (await handshakePOST(req("/api/v1/sync/handshake", {}, auth()))).json()) as { secret: string };
    expect(again.secret).toBe(secret);
  });

  it("کلید API نامعتبر، امضای اشتباه و برچسب زمان کهنه رد می‌شود", async () => {
    const bad = await sendEvents([orderEvent("evt_badsig0001", 2)], { secret: "f".repeat(64) });
    expect(bad.status).toBe(401);
    expect(bad.json.error).toBe("bad_signature");
    const old = await sendEvents([orderEvent("evt_stale00001", 2)], { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(old.status).toBe(401);
    expect(old.json.error).toBe("stale_timestamp");
    const noKey = await eventsPOST(req("/api/v1/sync/events", "{}", { "content-type": "application/json" }));
    expect(noKey.status).toBe(401);
  });

  it("راز در دیتابیس رمزنگاری‌شده ذخیره می‌شود", async () => {
    const [c] = await db.select().from(wpConnections).where(eq(wpConnections.id, connId));
    expect(c.syncSecret.startsWith("enc:v1:")).toBe(true);
    expect(secretOf(c)).toBe(secret);
  });
});

describe("ورودی: سفارش‌ها (وردپرس → ابر)", () => {
  it("سفارش ثبت می‌شود و ارسال تکراری Duplicate است (ایدمپوتنت)", async () => {
    const ev = orderEvent("evt_order100001", 100);
    const a = await sendEvents([ev]);
    expect(a.json.results?.[0].status).toBe("ok");
    const b = await sendEvents([ev]);
    expect(b.json.results?.[0].status).toBe("duplicate");
    const rows = await db.select().from(wcOrders).where(and(eq(wcOrders.connectionId, connId), eq(wcOrders.wcOrderId, 100)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "processing", customerEmail: "buyer@example.com", currency: "IRT" });
    expect(Number(rows[0].total)).toBe(1_500_000);
  });

  it("رویداد قدیمی‌تر داده‌ی جدیدتر را بازنویسی نمی‌کند (رسیدن نامرتب)", async () => {
    await sendEvents([orderEvent("evt_order200001", 200, { status: "completed", updatedAt: 1_760_000_500 })]);
    const late = await sendEvents([orderEvent("evt_order200002", 200, { status: "processing", updatedAt: 1_760_000_100 })]);
    expect(late.json.results?.[0].status).toBe("ignored");
    const [o] = await db.select().from(wcOrders).where(and(eq(wcOrders.connectionId, connId), eq(wcOrders.wcOrderId, 200)));
    expect(o.status).toBe("completed");
  });

  it("رویداد ناقص خطای همان رویداد است، نه کل دسته", async () => {
    const r = await sendEvents([orderEvent("evt_goodone0001", 300), { id: "evt_broken0001", type: "order.upserted", data: { orderId: "x" } }]);
    expect(r.json.results?.map((x) => x.status)).toEqual(["ok", "error"]);
    const [inb] = await db.select().from(wpInbound).where(and(eq(wpInbound.connectionId, connId), eq(wpInbound.eventId, "evt_broken0001")));
    expect(inb.status).toBe("error");
  });

  it("به‌روزرسانی مشتری: فقط مشتری‌ِ همین فضای کاری (نه ادمین/بیگانه)", async () => {
    const email = `${uniq("cust")}@example.com`;
    const res = await issuePOST(req("/api/v1/contracts", { templateId, customer: { name: "قدیمی", email, mobile: "09121110000" } }, auth()));
    expect(res.status).toBe(201);
    const r = await sendEvents([{ id: "evt_cust0000001", type: "customer.upserted", data: { email, name: "نام جدید", phone: "09123334444" } }]);
    expect(r.json.results?.[0].status).toBe("ok");
    const [u] = await db.select().from(users).where(eq(users.email, email));
    expect(u).toMatchObject({ name: "نام جدید", mobile: "09123334444" });
    const stranger = await sendEvents([{ id: "evt_cust0000002", type: "customer.upserted", data: { email: "nobody-here@example.com", name: "x" } }]);
    expect(stranger.json.results?.[0].status).toBe("ignored");
  });
});

describe("صدور ایدمپوتنت و پیوند سفارش↔قرارداد", () => {
  const external = { source: "woocommerce", orderId: 500, productId: 7, key: "wc:500:7" };
  let contractId = 0;

  it("دو بار صدور با یک کلید، یک قرارداد می‌سازد", async () => {
    const body = { templateId, customer: { name: "مشتری ووکامرس", email: `${uniq("wc")}@example.com`, mobile: "09125550000" }, external };
    const a = await issuePOST(req("/api/v1/contracts", body, auth()));
    const aj = (await a.json()) as { ok: boolean; id: number; signUrl: string | null; reused?: boolean };
    expect(a.status).toBe(201);
    expect(aj.signUrl).toBeTruthy();
    contractId = aj.id;
    const b = await issuePOST(req("/api/v1/contracts", body, auth()));
    const bj = (await b.json()) as { id: number; reused?: boolean; signUrl: string | null };
    expect(b.status).toBe(200);
    expect(bj).toMatchObject({ id: contractId, reused: true });
    const links = await db.select().from(wcContractLinks).where(eq(wcContractLinks.connectionId, connId));
    expect(links.filter((l) => l.externalKey === "wc:500:7")).toHaveLength(1);
  });

  it("مرجع خارجی نامعتبر 422 می‌دهد", async () => {
    const r = await issuePOST(req("/api/v1/contracts", { templateId, customer: { name: "x", email: "z@example.com", mobile: "09125550001" }, external: { source: "evil", key: "k" } }, auth()));
    expect(r.status).toBe(422);
  });

  it("فهرست با ids وضعیت و پیوند سفارش را برمی‌گرداند (هم‌ترازسازی)", async () => {
    const res = await listGET(new Request(`${origin}/api/v1/contracts?ids=${contractId},999999`, { headers: auth() }));
    const j = (await res.json()) as { items: { contractId: number; status: string; wcOrderId: number; pendingSigners: number }[] };
    expect(j.items).toHaveLength(1);
    expect(j.items[0]).toMatchObject({ contractId, status: "sent", wcOrderId: 500 });
  });

  it("لغو سفارش، قرارداد امضانشده را خودکار لغو می‌کند و رویداد به صف خروجی می‌رود", async () => {
    await sendEvents([orderEvent("evt_order500001", 500, { status: "cancelled", updatedAt: 1_760_000_900 })]);
    const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId));
    expect(c.status).toBe("cancelled");
    // رویداد خروجی (ناهمگام) در صف
    let ev: typeof wpOutbox.$inferSelect | undefined;
    for (let i = 0; i < 40 && !ev; i++) {
      [ev] = await db.select().from(wpOutbox).where(and(eq(wpOutbox.connectionId, connId), eq(wpOutbox.event, "contract.cancelled")));
      if (!ev) await new Promise((r) => setTimeout(r, 50));
    }
    expect(ev).toBeTruthy();
    const payload = JSON.parse(ev!.payload) as { contractId: number; wcOrderId: number; status: string };
    expect(payload).toMatchObject({ contractId, wcOrderId: 500, status: "cancelled" });
  });
});

describe("خروجی: صف، Pull/ACK و Push امضاشده", () => {
  it("سایت محلی: Push انجام نمی‌شود؛ Pull رویداد را می‌دهد و ACK آن را می‌بندد", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await dispatchOutbox(connId);
    expect(spy).not.toHaveBeenCalled(); // سایت محلی → فقط Pull
    const p1 = (await (await pullPOST(req("/api/v1/sync/pull", { limit: 10 }, auth()))).json()) as { events: { id: string; type: string }[]; pending: number };
    expect(p1.events.length).toBeGreaterThan(0);
    expect(p1.events.some((e) => e.type === "contract.cancelled")).toBe(true);
    const ids = p1.events.map((e) => e.id);
    const p2 = (await (await pullPOST(req("/api/v1/sync/pull", { ack: ids, limit: 10 }, auth()))).json()) as { events: { id: string }[]; pending: number };
    expect(p2.events.filter((e) => ids.includes(e.id))).toHaveLength(0);
    const delivered = await db.select().from(wpOutbox).where(and(eq(wpOutbox.connectionId, connId), eq(wpOutbox.status, "delivered")));
    expect(delivered.length).toBeGreaterThanOrEqual(ids.length);
    expect(delivered.every((d) => d.deliveredVia === "pull")).toBe(true);
  });

  const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 3000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() > end) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  it("سایت قابل‌دسترس: Push فوری با امضای HMAC معتبر و تایید تحویل", async () => {
    await db.update(wpConnections).set({ siteUrl: "https://shop.realdomain.org", siteHost: "shop.realdomain.org", capabilities: "push,pull,orders", verified: true }).where(eq(wpConnections.id, connId));
    const [link] = await db.select().from(wcContractLinks).where(eq(wcContractLinks.connectionId, connId));
    let seen: { url: string; headers: Headers; body: string } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = String(init?.body ?? "");
      seen = { url: String(input), headers: new Headers(init?.headers), body };
      const evs = (JSON.parse(body) as { events: { id: string }[] }).events;
      return new Response(JSON.stringify({ ok: true, results: evs.map((e) => ({ id: e.id, status: "ok" })) }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await enqueueContractEvent(link.contractId, "contract.reminder"); // Push فوری در پس‌زمینه
    const row = await waitFor(async () => {
      const [r] = await db.select().from(wpOutbox).where(and(eq(wpOutbox.connectionId, connId), eq(wpOutbox.event, "contract.reminder"), eq(wpOutbox.status, "delivered")));
      return r;
    });
    expect(row.deliveredVia).toBe("push");
    const s = seen as unknown as { url: string; headers: Headers; body: string };
    expect(s.url).toContain("rest_route=%2Femzagar%2Fv1%2Fevents");
    const ts = s.headers.get("x-emzagar-timestamp")!;
    expect(s.headers.get("x-emzagar-signature")).toBe(signBody(secret, ts, s.body));
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(30);
  });

  it("شکست Push: backoff نمایی و ماندن در صف (قابل Pull)", async () => {
    const [link] = await db.select().from(wcContractLinks).where(eq(wcContractLinks.connectionId, connId));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));
    await enqueueContractEvent(link.contractId, "contract.expired");
    const row = await waitFor(async () => {
      const [r] = await db.select().from(wpOutbox).where(and(eq(wpOutbox.connectionId, connId), eq(wpOutbox.event, "contract.expired")));
      return r && r.attempts >= 1 ? r : undefined;
    });
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toContain("ECONNREFUSED");
    const [c] = await db.select().from(wpConnections).where(eq(wpConnections.id, connId));
    expect(c.lastPushError).toContain("ECONNREFUSED");
    // با وجود شکست Push، Pull رویداد را تحویل می‌دهد
    const pulled = (await (await pullPOST(req("/api/v1/sync/pull", { limit: 10 }, auth()))).json()) as { events: { type: string }[] };
    expect(pulled.events.some((e) => e.type === "contract.expired")).toBe(true);
  });
});
