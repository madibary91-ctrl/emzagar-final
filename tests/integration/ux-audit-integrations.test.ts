import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, userNotifications, users, webhookDeliveries, webhookEndpoints, workspaces, wpConnections } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/modules/auth/session";
import { createWorkspace } from "@/modules/tenancy/service";
import { ConnectError, allowReconnectById, completeHandshake, disconnectById, startHandshake } from "@/modules/connect/service";
import { classifyProbe } from "@/modules/connect/service/probe";
import { createPairingToken } from "@/modules/connect/service/tokens";
import { connectionHealth } from "@/modules/sync/service";
import { explainDeliveryError, explainLine } from "@/modules/webhooks/explain";
import { MAX_ENDPOINTS_PER_WORKSPACE, normalizeEvents } from "@/modules/webhooks/validate";
import { createEndpoint, listEndpointsSafe, sendTest, updateEndpoint } from "@/modules/webhooks/service";
import { recordFailure, retryAllFailed, retryDeliveryNow } from "@/modules/webhooks/retry";
import { retryAllWebhooksAction, retryDeliveryStateAction, saveWebhookAction, testWebhookAction, updateWebhookAction } from "@/modules/webhooks/actions";
import { evaluateBotHealth } from "@/modules/messengers/diagnose";
import { freshBrowser, form, run, uniq } from "../helpers";

/* ═════════ ممیزی UX — بخش یکپارچگی‌ها (وب‌هوک، ربات‌های پیام‌رسان، افزونه‌ی وردپرس) ═════════ */

let seq = 0;
async function mkOwner() {
  const [owner] = await db
    .insert(users)
    .values({ name: "مالک یکپارچگی", email: `${uniq("int")}@example.com`, mobile: `0913${String(Date.now() % 10_000_000).padStart(7, "0").slice(-6)}${String(seq++ % 10)}`.slice(0, 11), passwordHash: hashPassword("Owner123x"), role: "user", emailVerifiedAt: new Date() })
    .returning();
  const ws = await createWorkspace(owner.id, "فضای یکپارچگی");
  return { owner, ws };
}

/* ───────── ۱) ترجمه‌ی خطاهای فنی به علت + راه‌حل ───────── */
describe("explainDeliveryError: خطای فنی ← علت و راه‌حل فارسی", () => {
  it("HTTP 404 برای وب‌هوک عمومی با ربات پیام‌رسان فرق دارد", () => {
    const g = explainDeliveryError("HTTP 404", "generic");
    expect(g.kind).toBe("not_found");
    expect(g.title).toMatch(/آدرس/);
    const t = explainDeliveryError("HTTP 404", "telegram");
    expect(t.title).toMatch(/ربات|توکن/);
    expect(t.hint).toMatch(/توکن/);
  });

  it("۴۰۱/۴۰۳، ۴۰۰ پیام‌رسان، ۴۲۹، ۵xx", () => {
    expect(explainDeliveryError("HTTP 401", "bale").kind).toBe("auth");
    expect(explainDeliveryError("HTTP 403", "generic").kind).toBe("auth");
    expect(explainDeliveryError("HTTP 400", "telegram").kind).toBe("bad_target");
    expect(explainDeliveryError("HTTP 429", "generic").kind).toBe("rate_limit");
    expect(explainDeliveryError("HTTP 503", "generic").kind).toBe("server");
  });

  it("پیام‌های توصیفی پیام‌رسان و خطاهای شبکه/SSRF", () => {
    expect(explainDeliveryError("Bad Request: chat not found", "telegram").kind).toBe("bad_target");
    expect(explainDeliveryError("Forbidden: bot was blocked by the user", "telegram").kind).toBe("bad_target");
    expect(explainDeliveryError("Forbidden: not enough rights to send text messages", "telegram").kind).toBe("auth");
    expect(explainDeliveryError("The operation was aborted due to timeout", "generic").kind).toBe("timeout");
    expect(explainDeliveryError("fetch failed", "generic").kind).toBe("network");
    expect(explainDeliveryError("آدرس داخلی مجاز نیست", "generic").kind).toBe("blocked_url");
    expect(explainDeliveryError("فقط آدرس HTTPS مجاز است", "generic").kind).toBe("blocked_url");
    expect(explainDeliveryError("ارتباط با تلگرام برقرار نشد", "telegram").hint).toMatch(/پروکسی/);
  });

  it("ورودی خالی/ناشناخته هرگز خطا نمی‌دهد و متن خام حفظ می‌شود", () => {
    expect(explainDeliveryError("", "generic").kind).toBe("unknown");
    expect(explainDeliveryError(null).hint).toMatch(/تست/);
    const u = explainDeliveryError("something odd", "generic");
    expect(u.raw).toBe("something odd");
    expect(explainLine("HTTP 500", "generic")).toMatch(/\. /);
  });
});

/* ───────── ۲) ساخت/ویرایش مقصد وب‌هوک ───────── */
describe("مقصد وب‌هوک: کلید امضای خودکار، ویرایش بدون از دست رفتن تاریخچه، سقف", () => {
  let ws = 0;
  let other = 0;
  beforeAll(async () => {
    ws = (await mkOwner()).ws;
    other = (await mkOwner()).ws;
  });

  it("وب‌هوک عمومی بدون کلید: کلید قوی خودکار ساخته و فقط یک‌بار برمی‌گردد؛ در فهرست کلاینت هرگز نیست", async () => {
    const r = await createEndpoint(ws, { provider: "generic", name: "سایت من", target: "https://example.com/hook", secret: "", baseUrl: "", events: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.generatedSecret).toMatch(/^whsec_[a-f0-9]{48}$/);
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, r.id));
    expect(row.secret).toBe(r.generatedSecret);
    const list = await listEndpointsSafe(ws);
    const mine = list.find((e) => e.id === r.id)!;
    expect(mine.hasSecret).toBe(true);
    expect(JSON.stringify(list)).not.toContain(r.generatedSecret!);
  });

  it("کلید دستی کاربر حفظ می‌شود (بازنویسی نمی‌شود)", async () => {
    const r = await createEndpoint(ws, { provider: "generic", name: "دستی", target: "https://example.com/h2", secret: "my-own-key", baseUrl: "", events: [] });
    expect(r.ok && r.generatedSecret).toBeFalsy();
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, (r as { id: number }).id));
    expect(row.secret).toBe("my-own-key");
  });

  it("خطای اعتبارسنجی، فیلد مربوط را مشخص می‌کند (برای فوکوس/علامت‌گذاری)", async () => {
    const badTarget = await createEndpoint(ws, { provider: "telegram", name: "x", target: "!!", secret: "123456789:AAHabcdefghijklmnopqrstuv", baseUrl: "", events: [] });
    expect(badTarget).toMatchObject({ ok: false, field: "target" });
    const badToken = await createEndpoint(ws, { provider: "telegram", name: "x", target: "-100123456", secret: "short", baseUrl: "", events: [] });
    expect(badToken).toMatchObject({ ok: false, field: "secret" });
    const noName = await createEndpoint(ws, { provider: "generic", name: "  ", target: "https://example.com/x", secret: "", baseUrl: "", events: [] });
    expect(noName).toMatchObject({ ok: false, field: "name" });
    const internal = await createEndpoint(ws, { provider: "generic", name: "داخلی", target: "https://127.0.0.1/hook", secret: "", baseUrl: "", events: [] });
    expect(internal).toMatchObject({ ok: false, field: "target" });
  });

  it("ویرایش: توکن خالی = بدون تغییر؛ نام/رویدادها عوض می‌شود؛ تاریخچه حفظ می‌شود", async () => {
    const token = "123456789:AAHabcdefghijklmnopqrstuv";
    const c = await createEndpoint(ws, { provider: "telegram", name: "کانال", target: "@my_channel", secret: token, baseUrl: "", events: [] });
    const id = (c as { id: number }).id;
    await db.insert(webhookDeliveries).values({ endpointId: id, event: "contract.issued", status: "dead", error: "HTTP 401", payload: JSON.stringify({ event: "contract.issued", text: "x" }) });
    const u = await updateEndpoint(ws, id, { name: "کانال مدیریت", target: "-1001234567890", secret: "", baseUrl: "", events: ["contract.signed", "contract.completed"] });
    expect(u.ok).toBe(true);
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    expect(row).toMatchObject({ name: "کانال مدیریت", target: "-1001234567890", secret: token, events: "contract.signed,contract.completed" });
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, id))).toHaveLength(1);
    // توکن تازه جایگزین می‌شود
    const t2 = "987654321:AAHzyxwvutsrqponmlkjihgfe";
    await updateEndpoint(ws, id, { name: "کانال مدیریت", target: "-1001234567890", secret: t2, baseUrl: "", events: [] });
    const [row2] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    expect(row2.secret).toBe(t2);
    expect(row2.events).toBe("*");
  });

  it("چرخش کلید امضا: کلید تازه فقط یک‌بار برمی‌گردد و با قبلی فرق دارد؛ برای ربات پیام‌رسان بی‌اثر است", async () => {
    const c = await createEndpoint(ws, { provider: "generic", name: "چرخش", target: "https://example.com/rot", secret: "", baseUrl: "", events: [] });
    const id = (c as { id: number }).id;
    const before = (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)))[0].secret;
    const r = await updateEndpoint(ws, id, { name: "چرخش", target: "https://example.com/rot", secret: "", baseUrl: "", events: [], rotateSecret: true });
    expect(r.ok && r.generatedSecret).toMatch(/^whsec_/);
    const after = (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, id)))[0].secret;
    expect(after).not.toBe(before);
    expect(after).toBe((r as { generatedSecret: string }).generatedSecret);
  });

  it("ویرایش مقصد فضای کاری دیگر ممکن نیست (تفکیک مستأجر)", async () => {
    const c = await createEndpoint(other, { provider: "generic", name: "دیگران", target: "https://example.com/o", secret: "", baseUrl: "", events: [] });
    const r = await updateEndpoint(ws, (c as { id: number }).id, { name: "هک", target: "https://evil.example.com", secret: "", baseUrl: "", events: [] });
    expect(r).toMatchObject({ ok: false });
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, (c as { id: number }).id));
    expect(row.name).toBe("دیگران");
  });

  it("سقف تعداد مقصد برای هر فضای کاری", async () => {
    const w = (await mkOwner()).ws;
    for (let i = 0; i < MAX_ENDPOINTS_PER_WORKSPACE; i++) await db.insert(webhookEndpoints).values({ workspaceId: w, name: `n${i}`, provider: "generic", target: "https://example.com/z", secret: "s" });
    const r = await createEndpoint(w, { provider: "generic", name: "اضافه", target: "https://example.com/z2", secret: "", baseUrl: "", events: [] });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/حداکثر/);
  });

  it("normalizeEvents: هیچ‌کدام یا همه = *؛ رویداد گفتگو فقط صریح", () => {
    expect(normalizeEvents([])).toBe("*");
    expect(normalizeEvents(["bogus", "test"])).toBe("*");
    expect(normalizeEvents(["contract.issued", "contract.signed", "contract.completed", "contract.rejected", "contract.reminder", "contract.expired", "contract.cancelled"])).toBe("*");
    expect(normalizeEvents(["chat.message"])).toBe("chat.message");
    expect(normalizeEvents(["contract.signed", "chat.message"])).toBe("contract.signed,chat.message");
  });
});

/* ───────── ۳) دکمه‌ی «تست»: بن‌بست «در صف تلاش مجدد» که هرگز تلاش نمی‌شد ───────── */
describe("تست مقصد: خطای قابل‌فهم و ثبت درست وضعیت", () => {
  let ws = 0;
  beforeAll(async () => {
    ws = (await mkOwner()).ws;
  });

  it("شکست آزمایشی «dead» ثبت می‌شود (نه failed) و خطا علت+راه‌حل دارد", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "داخلی", provider: "generic", target: "https://127.0.0.1/hook", secret: "s" }).returning();
    const r = await sendTest(ep.id, ws);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe("blocked_url");
    expect(r.error).toMatch(/آدرس/);
    expect(r.raw).toContain("مجاز نیست");
    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, ep.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("dead");
    expect(rows[0].nextRetryAt).toBeNull();
    // نباید دکمه‌ی «تلاش دوباره»‌ی بی‌معنی داشته باشد
    expect(rows[0].payload).toBeNull();
  });

  it("تست مقصد فضای کاری دیگر/ناموجود: پیام مشخص", async () => {
    expect(await sendTest(999999, ws)).toMatchObject({ ok: false, error: "مقصد یافت نشد" });
  });

  it("سلامت مقصد: آخرین وضعیت، شمارنده‌ها و توضیح علت از روی تاریخچه‌ی ۷ روز", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "سلامت", provider: "telegram", target: "-100123456", secret: "123456789:AAHabcdefghijklmnopqrstuv" }).returning();
    let list = await listEndpointsSafe(ws);
    expect(list.find((e) => e.id === ep.id)!.health.last).toBe("none");
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.issued", status: "ok" });
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.signed", status: "dead", error: "HTTP 401" });
    list = await listEndpointsSafe(ws);
    const h = list.find((e) => e.id === ep.id)!.health;
    expect(h.last).toBe("dead");
    expect(h.okCount).toBe(1);
    expect(h.badCount).toBe(1);
    expect(h.explained?.kind).toBe("auth");
    await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.completed", status: "ok" });
    const h2 = (await listEndpointsSafe(ws)).find((e) => e.id === ep.id)!.health;
    expect(h2.last).toBe("ok");
    expect(h2.explained).toBeNull();
  });
});

/* ───────── ۴) هشدار خطای دائمی، تلاش دوباره‌ی دستی/گروهی با بازخورد ───────── */
describe("خطای دائمی و بازیابی: اعلان، تلاش دوباره‌ی دستی و گروهی", () => {
  let ws = 0;
  let ownerId = 0;
  beforeAll(async () => {
    const o = await mkOwner();
    ws = o.ws;
    ownerId = o.owner.id;
  });

  it("خطای دائمی (توکن اشتباه) در همان ارسال اول به مدیر اعلان می‌دهد و تکرار آن در ۲۴ ساعت اسپم نمی‌کند", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "ربات اشتباه", provider: "telegram", target: "-100123456", secret: "123456789:AAHabcdefghijklmnopqrstuv" }).returning();
    const ev = { event: "contract.issued", text: "قرارداد صادر شد", contractId: null };
    await recordFailure({ endpointId: ep.id, ev, error: "HTTP 401", provider: "telegram" });
    const count = async () => (await db.select().from(userNotifications).where(eq(userNotifications.userId, ownerId))).filter((n) => n.title.includes("ربات اشتباه")).length;
    expect(await count()).toBe(1);
    const n = (await db.select().from(userNotifications).where(eq(userNotifications.userId, ownerId))).find((x) => x.title.includes("ربات اشتباه"))!;
    expect(n.body).toMatch(/توکن/);
    expect(n.body).not.toContain("HTTP 401");
    await recordFailure({ endpointId: ep.id, ev, error: "HTTP 401", provider: "telegram" });
    expect(await count()).toBe(1);
  });

  it("خطای موقت (۵۰۳) اعلان فوری نمی‌دهد؛ در صف تلاش مجدد می‌ماند", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "سایت کند", provider: "generic", target: "https://example.com/slow", secret: "s" }).returning();
    await recordFailure({ endpointId: ep.id, ev: { event: "contract.signed", text: "t" }, error: "HTTP 503", provider: "generic" });
    const [d] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, ep.id));
    expect(d.status).toBe("failed");
    expect(d.nextRetryAt).not.toBeNull();
    const notes = (await db.select().from(userNotifications).where(eq(userNotifications.userId, ownerId))).filter((n) => n.title.includes("سایت کند"));
    expect(notes).toHaveLength(0);
  });

  it("تلاش دوباره‌ی دستی: ناموفق ⇒ پیام علت+راه‌حل؛ بدنه‌ی پاک‌شده ⇒ توضیح؛ ارسال موفق/دیگران ⇒ پیام مشخص", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "مقصد داخلی", provider: "generic", target: "https://127.0.0.1/hook", secret: "s" }).returning();
    const [d] = await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.issued", status: "dead", error: "HTTP 500", attempts: 6, payload: JSON.stringify({ event: "contract.issued", text: "x" }) }).returning();
    const r = await retryDeliveryNow(d.id, ws);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/آدرس/); // علت فارسی از SSRF، نه «HTTP 500»
    const [gone] = await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.issued", status: "dead", error: "x" }).returning();
    expect((await retryDeliveryNow(gone.id, ws)).error).toMatch(/نگهداری نمی‌شود/);
    const [okRow] = await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.issued", status: "ok" }).returning();
    expect((await retryDeliveryNow(okRow.id, ws)).error).toMatch(/قبلاً موفق/);
    expect((await retryDeliveryNow(d.id, ws + 12345)).error).toBe("ارسال یافت نشد");
  });

  it("تلاش دوباره‌ی همه: فقط قابل‌تلاش‌های مقصد فعال همین فضا؛ شمارش و بازخورد دقیق", async () => {
    const w = (await mkOwner()).ws;
    const [live] = await db.insert(webhookEndpoints).values({ workspaceId: w, name: "فعال", provider: "generic", target: "https://127.0.0.1/a", secret: "s" }).returning();
    const [off] = await db.insert(webhookEndpoints).values({ workspaceId: w, name: "خاموش", provider: "generic", target: "https://127.0.0.1/b", secret: "s", active: false }).returning();
    const payload = JSON.stringify({ event: "contract.issued", text: "x" });
    await db.insert(webhookDeliveries).values([
      { endpointId: live.id, event: "contract.issued", status: "dead", error: "HTTP 401", payload },
      { endpointId: live.id, event: "contract.issued", status: "dead", error: "HTTP 401" }, // بدنه ندارد
      { endpointId: off.id, event: "contract.issued", status: "dead", error: "HTTP 401", payload }, // مقصد غیرفعال
    ]);
    const r = await retryAllFailed(w);
    expect(r).toEqual({ total: 1, ok: 0, failed: 1 });
    expect(await retryAllFailed(w + 99999)).toEqual({ total: 0, ok: 0, failed: 0 });
  });
});

/* ───────── ۵) اکشن‌های پنل (با نشست واقعی مدیر) ───────── */
describe("اکشن‌های /admin/webhooks: بازخورد در همان صفحه", () => {
  let ws = 0;
  let owner: typeof users.$inferSelect;
  beforeAll(async () => {
    const o = await mkOwner();
    ws = o.ws;
    owner = o.owner;
  });
  beforeEach(async () => {
    freshBrowser();
    await createSession(owner.id, owner.passwordHash);
  });

  it("saveWebhookAction: کلید خودکار را برمی‌گرداند؛ خطا همراه فیلد؛ ثبت در دیتابیس", async () => {
    const ok = await run(() => saveWebhookAction({}, form({ provider: "generic", name: "وردپرس من", target: "https://example.com/wp-json/x", secret: "" })));
    expect(ok.result).toMatchObject({ ok: true });
    expect((ok.result as { secret: string }).secret).toMatch(/^whsec_/);
    expect((ok.result as { info: string }).info).toMatch(/کپی/);
    const bad = await run(() => saveWebhookAction({}, form({ provider: "telegram", name: "ربات", target: "x", secret: "123456789:AAHabcdefghijklmnopqrstuv" })));
    expect(bad.result).toMatchObject({ field: "target" });
    expect((bad.result as { error: string }).error).toMatch(/شناسه/);
    expect((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.workspaceId, ws))).some((e) => e.name === "وردپرس من")).toBe(true);
  });

  it("updateWebhookAction: ذخیره با پیام موفقیت؛ شناسه‌ی نامعتبر ⇒ خطا", async () => {
    const [ep] = await db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.workspaceId, ws), eq(webhookEndpoints.name, "وردپرس من")));
    const r = await run(() => updateWebhookAction({}, form({ id: String(ep.id), name: "وردپرس من (ویرایش)", target: ep.target, secret: "", baseUrl: "" })));
    expect(r.result).toMatchObject({ ok: true });
    expect((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, ep.id)))[0].name).toBe("وردپرس من (ویرایش)");
    expect((await run(() => updateWebhookAction({}, form({ id: "abc", name: "x", target: "y" })))).result).toMatchObject({ error: "مقصد نامعتبر است" });
  });

  it("testWebhookAction: خطای فارسی + متن خام جدا", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "تست داخلی", provider: "generic", target: "https://10.0.0.5/hook", secret: "s" }).returning();
    const r = await run(() => testWebhookAction(ep.id));
    expect(r.result).toMatchObject({ ok: false });
    expect((r.result as { error: string }).error).not.toMatch(/^HTTP/);
    expect((r.result as { raw: string }).raw).toBeTruthy();
  });

  it("retryDeliveryStateAction / retryAllWebhooksAction: همیشه پیام برمی‌گردانند", async () => {
    const [ep] = await db.insert(webhookEndpoints).values({ workspaceId: ws, name: "برای تلاش", provider: "generic", target: "https://10.0.0.6/hook", secret: "s" }).returning();
    const [d] = await db.insert(webhookDeliveries).values({ endpointId: ep.id, event: "contract.issued", status: "dead", error: "HTTP 500", payload: JSON.stringify({ event: "contract.issued", text: "x" }) }).returning();
    const one = await run(() => retryDeliveryStateAction({}, form({ id: String(d.id) })));
    expect((one.result as { error?: string }).error).toBeTruthy();
    expect((await run(() => retryDeliveryStateAction({}, form({ id: "zzz" })))).result).toMatchObject({ error: "ارسال نامعتبر است" });
    const all = await run(() => retryAllWebhooksAction({}, form({})));
    expect((all.result as { error?: string; info?: string }).error ?? (all.result as { info?: string }).info).toBeTruthy();
  });
});

/* ───────── ۶) تشخیص سلامت ربات پیام‌رسان ───────── */
describe("evaluateBotHealth: تشخیص علت سکوت ربات", () => {
  const base = { active: true, mode: "webhook", tokenOk: true, username: "emz_bot", expectedUrl: "https://app.example.com/api/messengers/webhook/abc", info: { url: "https://app.example.com/api/messengers/webhook/abc", pending_update_count: 0 }, lastEventAt: new Date() };

  it("همه‌چیز درست ⇒ سالم", () => {
    const d = evaluateBotHealth(base);
    expect(d.healthy).toBe(true);
    expect(d.fixable).toBe(false);
  });

  it("آدرس HTTPS نیست ⇒ راهنمای Polling، قابل‌رفع خودکار نیست", () => {
    const d = evaluateBotHealth({ ...base, expectedUrl: "http://localhost:3000/api/x", info: { url: "" } });
    expect(d.healthy).toBe(false);
    expect(d.checks.find((c) => !c.ok)!.detail).toMatch(/Polling/);
    expect(d.fixable).toBe(false);
  });

  it("وب‌هوک ثبت نیست یا روی آدرس دیگری است ⇒ قابل رفع خودکار", () => {
    const none = evaluateBotHealth({ ...base, info: { url: "" } });
    expect(none.fixable).toBe(true);
    const moved = evaluateBotHealth({ ...base, info: { url: "https://old.example.com/api/messengers/webhook/abc" } });
    expect(moved.fixable).toBe(true);
    expect(moved.checks.find((c) => !c.ok)!.detail).toMatch(/دامنه|آدرس/);
  });

  it("حالت Polling با وب‌هوک باقی‌مانده ⇒ تداخل ۴۰۹ قابل رفع", () => {
    const d = evaluateBotHealth({ ...base, mode: "polling", info: { url: "https://x.example.com/hook" } });
    expect(d.fixable).toBe(true);
    expect(d.checks.find((c) => !c.ok)!.label).toBe("تداخل با وب‌هوک");
    expect(evaluateBotHealth({ ...base, mode: "polling", info: { url: "" } }).healthy).toBe(true);
  });

  it("توکن نامعتبر، ربات غیرفعال، صف انباشته و خطای تحویل اخیر گزارش می‌شود", () => {
    const t = evaluateBotHealth({ ...base, tokenOk: false, tokenError: "توکن ربات نامعتبر است" });
    expect(t.healthy).toBe(false);
    expect(t.checks[0].detail).toContain("نامعتبر");
    expect(evaluateBotHealth({ ...base, active: false }).healthy).toBe(false);
    const now = new Date();
    const q = evaluateBotHealth({ ...base, now, info: { ...base.info, pending_update_count: 120, last_error_message: "Connection timed out", last_error_date: Math.floor(now.getTime() / 1000) - 60 } });
    expect(q.checks.some((c) => c.label === "پیام‌های صف‌مانده" && !c.ok)).toBe(true);
    expect(q.checks.some((c) => c.label === "آخرین خطای تحویل" && !c.ok)).toBe(true);
    // خطای قدیمی (۲ روز پیش) دیگر هشدار نیست
    const old = evaluateBotHealth({ ...base, now, info: { ...base.info, last_error_message: "x", last_error_date: Math.floor(now.getTime() / 1000) - 2 * 86400 } });
    expect(old.healthy).toBe(true);
  });

  it("پیام‌رسانی که getWebhookInfo ندارد خطا نمی‌دهد؛ هنوز پیامی نرسیده ⇒ راهنما (نه خطا)", () => {
    const d = evaluateBotHealth({ ...base, info: null, lastEventAt: null });
    expect(d.healthy).toBe(true);
    expect(d.checks.at(-1)!.detail).toMatch(/\/help/);
  });
});

/* ───────── ۷) افزونه‌ی وردپرس: قطع اتصال که واقعاً قطع بماند ───────── */
describe("قطع اتصال وردپرس: افزونه‌ی خودترمیم نباید بی‌اجازه دوباره وصل شود", () => {
  const installId = () => crypto.randomBytes(16).toString("hex");
  const payload = (id: string, host: string) => ({ installId: id, siteUrl: `http://${host}.test`, siteName: "سایت آزمون", adminEmail: `${uniq("a")}@example.com`, adminName: "مدیر", pluginVersion: "2.3.0", wpVersion: "6.7", wcActive: false, locale: "fa_IR" });

  async function connect(id: string, host: string) {
    const hs = await startHandshake(payload(id, host));
    const done = await completeHandshake(hs.handshakeId);
    const [conn] = await db.select().from(wpConnections).where(eq(wpConnections.installId, id));
    return { done, conn };
  }

  it("پس از قطع توسط مدیر: ثبت‌نام مجدد همان نصب با کد sync_paused و پیام فارسی رد می‌شود؛ کلید فعال نمی‌شود", async () => {
    const id = installId();
    const host = uniq("wp");
    const { done, conn } = await connect(id, host);
    expect(conn.status).toBe("active");
    await disconnectById(done.workspaceId, conn.id);
    const [after] = await db.select().from(wpConnections).where(eq(wpConnections.id, conn.id));
    expect(after.status).toBe("revoked");
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, conn.apiKeyId!));
    expect(key.active).toBe(false);

    // خودترمیمیِ افزونه (mark_broken ⇒ دوباره register)
    const err = await startHandshake(payload(id, host)).then(() => null, (e: unknown) => e as ConnectError);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err!.code).toBe("sync_paused"); // کدی که افزونه‌ی امضاشده آن را به «همگام‌سازی از پنل متوقف شده» ترجمه می‌کند
    expect(err!.status).toBe(403);
    expect(err!.message).toMatch(/اجازه‌ی اتصال دوباره/);
    const [still] = await db.select().from(wpConnections).where(eq(wpConnections.id, conn.id));
    expect(still.status).toBe("revoked");
    expect((await db.select().from(apiKeys).where(eq(apiKeys.id, conn.apiKeyId!)))[0].active).toBe(false);
  });

  it("دست‌دادنِ نیمه‌کاره‌ای که پیش از قطع شروع شده، پس از قطع هم کامل نمی‌شود", async () => {
    const id = installId();
    const host = uniq("wp");
    const { done, conn } = await connect(id, host);
    const hs = await startHandshake(payload(id, host)); // پیش از قطع
    await disconnectById(done.workspaceId, conn.id);
    await expect(completeHandshake(hs.handshakeId)).rejects.toMatchObject({ code: "sync_paused" });
  });

  it("«اجازه‌ی اتصال دوباره»: قفل برداشته می‌شود و افزونه همان فضای کاری را پس می‌گیرد؛ فقط از revoked و فقط در فضای کاری خودش", async () => {
    const id = installId();
    const host = uniq("wp");
    const { done, conn } = await connect(id, host);
    expect(await allowReconnectById(done.workspaceId, conn.id)).toBe(false); // فعال است؛ چیزی برای برداشتن نیست
    await disconnectById(done.workspaceId, conn.id);
    expect(await allowReconnectById(done.workspaceId + 99999, conn.id)).toBe(false); // فضای کاری دیگر
    expect((await db.select().from(wpConnections).where(eq(wpConnections.id, conn.id)))[0].status).toBe("revoked");
    expect(await allowReconnectById(done.workspaceId, conn.id)).toBe(true);
    const again = await connect(id, host);
    expect(again.done.workspaceId).toBe(done.workspaceId);
    expect(again.done.reused).toBe(true);
    expect(again.conn.status).toBe("active");
  });

  it("کد جفت‌سازیِ تازه (دانلود دوباره‌ی افزونه از پنل) قصد صریح مدیر است و قفل را می‌شکند", async () => {
    const id = installId();
    const host = uniq("wp");
    const { done, conn } = await connect(id, host);
    await disconnectById(done.workspaceId, conn.id);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, done.workspaceId));
    const pairing = await createPairingToken(done.workspaceId, ws.ownerId);
    const hs = await startHandshake({ ...payload(id, host), pairing });
    expect(hs.mode).toBe("paired");
    const res = await completeHandshake(hs.handshakeId);
    expect(res.workspaceId).toBe(done.workspaceId);
    expect((await db.select().from(wpConnections).where(eq(wpConnections.id, conn.id)))[0].status).toBe("active");
  });

  it("قطع به‌دست خود افزونه/سیستم («disconnected») همچنان خودترمیم است (رفتار قبلی حفظ شد)", async () => {
    const id = installId();
    const host = uniq("wp");
    const { conn } = await connect(id, host);
    await db.update(wpConnections).set({ status: "disconnected" }).where(eq(wpConnections.id, conn.id));
    const again = await connect(id, host);
    expect(again.conn.status).toBe("active");
  });
});

/* ───────── ۸) سلامت اتصال و تست زنده‌ی سایت ───────── */
describe("connectionHealth و classifyProbe", () => {
  const conn = (o: Partial<typeof wpConnections.$inferSelect>) => ({ status: "active", syncEnabled: true, syncSecret: "x", lastSeenAt: new Date(), lastPushError: "", ...o }) as typeof wpConnections.$inferSelect;

  it("revoked پیام و برچسب جدا دارد؛ سایت قدیمی/بی‌ارتباط هشدار می‌گیرد", () => {
    const r = connectionHealth(conn({ status: "revoked" }), 0);
    expect(r.state).toBe("revoked");
    expect(r.hints[0]).toMatch(/اجازه‌ی اتصال دوباره/);
    expect(connectionHealth(conn({ lastSeenAt: new Date(Date.now() - 40 * 3600_000) }), 0).state).toBe("stale");
    expect(connectionHealth(conn({ lastSeenAt: new Date(Date.now() - 4 * 86400_000) }), 0).state).toBe("offline");
    expect(connectionHealth(conn({}), 0).state).toBe("healthy");
  });

  it("emzagar_not_found ⇒ سایت و افزونه سالم؛ rest_no_route ⇒ افزونه غیرفعال", () => {
    expect(classifyProbe({ status: 404, body: JSON.stringify({ code: "emzagar_not_found", message: "Not found" }), ms: 120 }).state).toBe("ok");
    const off = classifyProbe({ status: 404, body: JSON.stringify({ code: "rest_no_route" }) });
    expect(off.state).toBe("plugin_inactive");
    expect(off.hint).toMatch(/فعال/);
  });

  it("فایروال/حالت نگهداری، ریدایرکت، خطای سرور و محلی", () => {
    expect(classifyProbe({ status: 403, body: "<html>Forbidden</html>" }).state).toBe("blocked");
    expect(classifyProbe({ status: 503, body: "" }).state).toBe("blocked");
    expect(classifyProbe({ status: 301, body: "" }).state).toBe("redirect");
    expect(classifyProbe({ status: 500, body: "{}" }).state).toBe("server_error");
    expect(classifyProbe({ local: true, status: null }).state).toBe("local");
  });

  it("خطاهای شبکه: مهلت، DNS، TLS، قطع", () => {
    expect(classifyProbe({ status: null, error: "The operation was aborted due to timeout" }).title).toMatch(/پاسخ نداد/);
    expect(classifyProbe({ status: null, error: "fetch failed ENOTFOUND" }).title).toMatch(/دامنه/);
    expect(classifyProbe({ status: null, error: "certificate has expired" }).title).toMatch(/گواهی/);
    expect(classifyProbe({ status: null, error: "fetch failed" }).state).toBe("unreachable");
  });
});
