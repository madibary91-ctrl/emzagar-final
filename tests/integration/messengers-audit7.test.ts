import http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { messengerBots, messengerChats, messengerUpdates, userNotifications } from "@/db/schema";
import { POST as webhook } from "@/app/api/messengers/webhook/[secret]/route";
import { handleUpdate } from "@/modules/messengers/bot";
import { pollBackoffMs, pollOnce } from "@/modules/messengers/poller";
import { deliver } from "@/modules/messengers/send";
import { applyBotSettings, consumeLinkCode, createLinkCode, getChat, markBotTokenInvalid, registerBot, restoreLinkCode, setBotActive } from "@/modules/messengers/service";
import { chunkText, clip } from "@/modules/messengers/util";
import { explainDeliveryError } from "@/modules/webhooks/explain";
import { fitText, readMessengerResponse } from "@/modules/webhooks/deliver";
import { setupWorkspace } from "../flows";
import { freshBrowser } from "../helpers";

/**
 * ممیزی ۷ — پیام‌رسان‌ها: آزمون باگ‌های M-01 … M-12 (سرور جعلی Bot API با خرابی قابل‌برنامه‌ریزی).
 */
type Call = { provider: string; method: string; token: string; body: Record<string, unknown> };
type Reply = { status?: number; body: unknown } | undefined;
const calls: Call[] = [];
const counts: Record<string, number> = {};
const hooks: Record<string, (n: number, body: Record<string, unknown>, token: string) => Reply> = {};
const allUpdates: Record<string, { update_id: number }[]> = {};
let server: http.Server;

const tok = (n: number) => `${700000000 + n}:AAHaudit7_token_${String(n).padStart(4, "0")}_abcdefghijklmnop`;

beforeAll(async () => {
  await db.delete(messengerBots);
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/(telegram|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url || "");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = {};
      }
      if (!m) {
        res.statusCode = 404;
        return res.end("{}");
      }
      const [, provider, token, method] = m;
      calls.push({ provider, method, token, body });
      counts[method] = (counts[method] ?? 0) + 1;
      const r = hooks[method]?.(counts[method], body, token);
      res.setHeader("Content-Type", "application/json");
      if (r) {
        res.statusCode = r.status ?? 200;
        return res.end(JSON.stringify(r.body));
      }
      const out = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (method === "getMe") return out({ id: 1, is_bot: true, first_name: "ربات", username: `emz7_${provider}_bot` });
      if (method === "getUpdates") {
        const offset = Number(body.offset) || 0;
        return out((allUpdates[token] ?? []).filter((u) => u.update_id >= offset));
      }
      if (method === "sendMessage" || method === "sendDocument") return out({ message_id: calls.length });
      return out(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.EXTERNAL_SIM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await db.delete(messengerBots);
  delete process.env.EXTERNAL_SIM_URL;
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(counts)) delete counts[k];
  for (const k of Object.keys(hooks)) delete hooks[k];
  freshBrowser();
});
afterEach(() => vi.restoreAllMocks());

let seq = 5000;
const textUpdate = (chat: number, text: string) => ({ update_id: ++seq, message: { message_id: seq, from: { id: chat, first_name: "کاربر" }, chat: { id: chat, type: "private" }, text } });
const sentTo = (chat: number) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chat));
const post = (secret: string, update: unknown, headers: Record<string, string> = {}, raw?: string) =>
  webhook(new NextRequest(`http://localhost/api/messengers/webhook/${secret}`, { method: "POST", body: raw ?? JSON.stringify(update), headers }), { params: Promise.resolve({ secret }) });
const botRow = async (id: number) => (await db.select().from(messengerBots).where(eq(messengerBots.id, id)))[0];

async function newBot(n: number, o: { provider?: "telegram" | "bale"; workspaceId?: number | null; mode?: string } = {}) {
  const r = await registerBot({ workspaceId: o.workspaceId ?? null, provider: o.provider ?? "bale", token: tok(n), mode: o.mode ?? "polling" });
  if (!r.ok) throw new Error(r.error);
  return botRow(r.id);
}
async function newTarget(botId: number, chatId: string, userId?: number) {
  const [row] = await db.insert(messengerChats).values({ botId, chatId, userId: userId ?? null, verifiedMobile: "" }).returning();
  return (await getChat(row.id))!;
}

/**
 * شبیه‌سازی لرزش دیتابیس: تریگر واقعی PostgreSQL که هنگام ثبت lastEventAt (اولین نوشتن پس از claim آپدیت) برای رباتِ علامت‌خورده خطا می‌دهد.
 * (db یک Proxy است و spy روی آن ممکن نیست؛ این روش به رفتار واقعی نزدیک‌تر هم هست.)
 */
async function failBot(id: number, on: boolean) {
  if (on) await db.execute(sql`insert into audit7_fail (bot_id) values (${id}) on conflict do nothing`);
  else await db.execute(sql`delete from audit7_fail where bot_id = ${id}`);
}
beforeAll(async () => {
  await db.execute(sql`create table if not exists audit7_fail (bot_id integer primary key)`);
  await db.execute(sql`create or replace function audit7_blip() returns trigger as $$ begin
    if exists (select 1 from audit7_fail where bot_id = new.id) and new.last_event_at is distinct from old.last_event_at then raise exception 'audit7 blip'; end if;
    return new; end; $$ language plpgsql`);
  await db.execute(sql`drop trigger if exists audit7_blip_t on messenger_bots`);
  await db.execute(sql`create trigger audit7_blip_t before update on messenger_bots for each row execute function audit7_blip()`);
});
afterAll(async () => {
  await db.execute(sql`drop trigger if exists audit7_blip_t on messenger_bots`);
  await db.execute(sql`drop function if exists audit7_blip()`);
  await db.execute(sql`drop table if exists audit7_fail`);
});

let wsId = 0;
let ownerId = 0;
beforeAll(async () => {
  const s = await setupWorkspace("فضای ممیزی ۷");
  wsId = s.wsId;
  ownerId = s.owner.id;
});

describe("M-08 — برش متن، جفت‌جانشین (ایموجی) را نمی‌شکند", () => {
  it("chunkText و clip هیچ‌وقت نیمه‌ی یک ایموجی را برش نمی‌دهند", () => {
    const text = "😀".repeat(3000); // ۶۰۰۰ واحد UTF-16 بدون هیچ خط‌جدید
    const parts = chunkText(text, 3801); // سقف فرد: برش ساده وسط یک جفت می‌افتاد
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    for (const p of parts) expect(/[\ud800-\udbff]$/.test(p) || /^[\udc00-\udfff]/.test(p)).toBe(false);
    const c = clip("😀😀😀😀", 4); // برش در ۳ واحد ⇒ وسط جفت دوم
    expect(/[\ud800-\udbff]…$/.test(c)).toBe(false);
    expect(clip("سلام", 10)).toBe("سلام");
  });
});

describe("M-01 — آپدیتِ ناموفق گم نمی‌شود (آزادسازی claim + بازتلاش)", () => {
  it("خطای موقت: claim آزاد، نتیجه retry، سپس با ارسال دوباره پردازش می‌شود؛ آپدیت سمی پس از ۳ تلاش رها می‌شود", async () => {
    const bot = await newBot(1);
    const upd = textUpdate(8101, "/help");
    await failBot(bot.id, true);
    expect(await handleUpdate(bot.id, upd as never)).toBe("retry");
    await failBot(bot.id, false);
    expect(sentTo(8101)).toHaveLength(0);
    // claim آزاد شده بود ⇒ آپدیت «تکراری» حساب نمی‌شود
    expect((await db.select().from(messengerUpdates).where(and(eq(messengerUpdates.botId, bot.id), eq(messengerUpdates.updateId, upd.update_id)))).length).toBe(0);
    expect(await handleUpdate(bot.id, upd as never)).toBe("handled");
    expect(sentTo(8101).length).toBeGreaterThan(0);
    expect(await handleUpdate(bot.id, upd as never)).toBe("duplicate");

    // آپدیت سمی
    const poison = textUpdate(8102, "/help");
    const outcomes: string[] = [];
    await failBot(bot.id, true);
    for (let i = 0; i < 3; i++) outcomes.push(await handleUpdate(bot.id, poison as never));
    await failBot(bot.id, false);
    expect(outcomes).toEqual(["retry", "retry", "dropped"]);
  });

  it("وب‌هوک: خطای موقت ⇒ ۵۰۰ (تا پیام‌رسان دوباره بفرستد)، بار بعد ۲۰۰ و پیام پاسخ داده می‌شود؛ بدنه‌ی غول‌پیکر ⇒ ۴۱۳", async () => {
    const bot = await newBot(2);
    const upd = textUpdate(8201, "/help");
    await failBot(bot.id, true);
    const r1 = await post(bot.webhookSecret, upd);
    await failBot(bot.id, false);
    expect(r1.status).toBe(500);
    expect(sentTo(8201)).toHaveLength(0);
    const r2 = await post(bot.webhookSecret, upd);
    expect(r2.status).toBe(200);
    expect(sentTo(8201).length).toBeGreaterThan(0);
    const big = await post(bot.webhookSecret, null, { "content-length": "999999" }, "{}");
    expect(big.status).toBe(413);
  });

  it("کد اتصال: اگر اتصال چت پس از مصرف کد شکست بخورد، کد برگردانده می‌شود", async () => {
    const bot = await newBot(3);
    const link = await createLinkCode(ownerId, bot.id);
    expect(link.ok).toBe(true);
    const code = new URL((link as { url: string }).url).searchParams.get("start")!;
    expect(await consumeLinkCode(code, bot.id)).toBe(ownerId);
    expect(await consumeLinkCode(code, bot.id)).toBeNull();
    await restoreLinkCode(code, bot.id);
    expect(await consumeLinkCode(code, bot.id)).toBe(ownerId);
  });
});

describe("M-02 — Polling: backoff، بدون «خطا»ی کاذب، رفع ۴۰۹ و بازتلاش آپدیت", () => {
  it("منحنی backoff نمایی و سقف‌دار است", () => {
    expect(pollBackoffMs(1)).toBe(4000);
    expect(pollBackoffMs(2)).toBe(8000);
    expect(pollBackoffMs(30)).toBe(300_000);
  });

  it("قطعی گذرا: اجاره‌ی backoff، تماس تکراری نمی‌رود، وضعیت تا ۵ شکست پیاپی «متصل» می‌ماند، بهبود خودکار", async () => {
    await db.delete(messengerBots);
    const bot = await newBot(10);
    hooks.getUpdates = () => ({ status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } });
    await pollOnce();
    expect(counts.getUpdates).toBe(1);
    let row = await botRow(bot.id);
    expect(row.status).toBe("connected"); // قطعی گذرا ربات را از کارت‌های اتصال کاربران حذف نمی‌کند
    expect(row.pollLeaseUntil!.getTime()).toBeGreaterThan(Date.now() + 1500);
    await pollOnce(); // در backoff است
    expect(counts.getUpdates).toBe(1);
    for (let i = 2; i <= 5; i++) {
      await db.update(messengerBots).set({ pollLeaseUntil: null }).where(eq(messengerBots.id, bot.id));
      await pollOnce();
    }
    expect(counts.getUpdates).toBe(5);
    row = await botRow(bot.id);
    expect(row.status).toBe("error");
    expect(row.lastError).toBeTruthy();
    // بهبود
    delete hooks.getUpdates;
    await db.update(messengerBots).set({ pollLeaseUntil: null }).where(eq(messengerBots.id, bot.id));
    await pollOnce();
    row = await botRow(bot.id);
    expect(row.status).toBe("connected");
    expect(row.lastError).toBe("");
    expect(row.pollLeaseUntil).toBeNull();
  });

  it("۴۰۱: فوراً «خطا» و backoff طولانی؛ ۴۰۹: وب‌هوک باقی‌مانده خودکار برداشته می‌شود", async () => {
    await db.delete(messengerBots);
    const bot = await newBot(11);
    hooks.getUpdates = () => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    await pollOnce();
    let row = await botRow(bot.id);
    expect(row.status).toBe("error");
    expect(row.pollLeaseUntil!.getTime()).toBeGreaterThan(Date.now() + 120_000);

    await db.delete(messengerBots);
    const b2 = await newBot(12, { provider: "telegram" });
    calls.length = 0;
    counts.getUpdates = 0;
    hooks.getUpdates = (n) => (n === 1 ? { status: 409, body: { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" } } : undefined);
    await pollOnce();
    expect(calls.some((c) => c.method === "deleteWebhook" && c.token === tok(12))).toBe(true);
    row = await botRow(b2.id);
    expect(row.status).toBe("connected");
  });

  it("آپدیتِ ناموفق (خطای موقت): offset جلو نمی‌رود و نوبت بعد همان و بعدی‌ها پردازش می‌شوند", async () => {
    await db.delete(messengerBots);
    const bot = await newBot(13);
    const u1 = textUpdate(8301, "/help");
    const u2 = textUpdate(8302, "/help");
    allUpdates[tok(13)] = [u1, u2];
    await failBot(bot.id, true);
    await pollOnce();
    await failBot(bot.id, false);
    let row = await botRow(bot.id);
    expect(row.lastUpdateId).toBeLessThan(u1.update_id);
    expect(sentTo(8302)).toHaveLength(0);
    await db.update(messengerBots).set({ pollLeaseUntil: null }).where(eq(messengerBots.id, bot.id));
    await pollOnce();
    row = await botRow(bot.id);
    expect(row.lastUpdateId).toBe(u2.update_id);
    expect(sentTo(8301).length).toBeGreaterThan(0);
    expect(sentTo(8302).length).toBeGreaterThan(0);
  });
});

describe("M-03 — توکن باطل‌شده (۴۰۱) بی‌صدا نمی‌ماند", () => {
  it("ارسال با ۴۰۱ ⇒ وضعیت «خطا»، اعلان یک‌باره به مدیران فضای کاری", async () => {
    const bot = await newBot(20, { workspaceId: wsId });
    const t = await newTarget(bot.id, "9001", ownerId);
    hooks.sendMessage = () => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    const r = await deliver(t, { text: "سلام" }, { kind: "notice", final: false });
    expect(r.ok).toBe(false);
    const row = await botRow(bot.id);
    expect(row.status).toBe("error");
    expect(row.lastError).toContain("توکن");
    const q = () => db.select().from(userNotifications).where(and(eq(userNotifications.userId, ownerId), eq(userNotifications.href, "/admin/messengers"))).orderBy(desc(userNotifications.id));
    expect((await q()).length).toBe(1);
    await deliver(t, { text: "دوباره" }, { kind: "notice", final: false });
    expect(await markBotTokenInvalid(bot.id)).toBe(false); // تکراری ⇒ اعلان دوم نه
    expect((await q()).length).toBe(1);
  });
});

describe("M-04/M-05 — ۴۲۹ و پیام‌های چندتکه‌ای", () => {
  const long = Array.from({ length: 90 }, (_, i) => `خط شماره ${i} ${"الف".repeat(40)}`).join("\n"); // > ۳۸۰۰ ⇒ دست‌کم ۲ تکه

  it("۴۲۹ ⇒ retry با retryAfterSec (صف به‌جای backoff کور، تلاش نمی‌سوزد)", async () => {
    const bot = await newBot(30);
    const t = await newTarget(bot.id, "9101");
    hooks.sendMessage = () => ({ status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } } });
    const r = await deliver(t, { text: "سلام" }, { kind: "notice", final: false });
    expect(r).toMatchObject({ ok: false, retry: true, retryAfterSec: 7 });
  });

  it("خطای گذرا روی تکه‌ی دوم: تلاش درجا انجام می‌شود و تکه‌ی اول دوبار نمی‌رود", async () => {
    const bot = await newBot(31);
    const t = await newTarget(bot.id, "9102");
    hooks.sendMessage = (n) => (n === 2 ? { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } } : undefined);
    const r = await deliver(t, { text: long }, { kind: "notice", final: false });
    expect(r.ok).toBe(true);
    const texts = sentTo(9102).map((c) => String(c.body.text));
    expect(texts.length).toBe(chunkText(long).length + 1); // یک تلاش ناموفق + همه‌ی تکه‌ها
    const okTexts = texts.slice(0, 1).concat(texts.slice(2));
    expect(new Set(okTexts).size).toBe(okTexts.length); // تکه‌ی اول فقط یک بار
  }, 20_000);

  it("شکست پایدار پس از رسیدن تکه‌ی اول: «ناقص» و بدون retry (تکرار نمی‌شود)", async () => {
    const bot = await newBot(32);
    const t = await newTarget(bot.id, "9103");
    hooks.sendMessage = (n) => (n >= 2 ? { status: 502, body: { ok: false, error_code: 502, description: "Bad Gateway" } } : undefined);
    const r = await deliver(t, { text: long }, { kind: "notice", final: false });
    expect(r).toMatchObject({ ok: false, retry: false, partial: true });
    expect(sentTo(9103).filter((c) => String(c.body.text).startsWith("خط شماره 0")).length).toBe(1);
  }, 20_000);
});

describe("M-06/M-07/M-12 — تنظیمات، روشن/خاموش و ثبت هم‌زمان ربات", () => {
  it("تغییر حالت به وب‌هوک بدون HTTPS: حالت قبلی بازمی‌گردد و ربات سالم می‌ماند", async () => {
    const bot = await newBot(40);
    calls.length = 0;
    const r = await applyBotSettings(bot.id, { otpMode: "both", sendPdf: true, mode: "webhook" });
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.error).toMatch(/HTTPS/);
    const row = await botRow(bot.id);
    expect(row.mode).toBe("polling");
    expect(row.status).toBe("connected");
    expect(row.otpMode).toBe("both");
    expect(row.sendPdf).toBe(true);
    expect(calls.some((c) => c.method === "deleteWebhook")).toBe(true);
    expect((await applyBotSettings(bot.id, { otpMode: "prefer", sendPdf: false, mode: "polling" })).ok).toBe(true);
  });

  it("خاموش‌کردن ربات وب‌هوکی وب‌هوک را برمی‌دارد و روشن‌کردن دوباره ثبتش می‌کند", async () => {
    const prev = process.env.APP_URL;
    process.env.APP_URL = "https://sign.example.com";
    try {
      const bot = await newBot(41, { provider: "telegram", mode: "webhook" });
      expect(bot.status).toBe("connected");
      expect(calls.some((c) => c.method === "setWebhook")).toBe(true);
      calls.length = 0;
      expect((await setBotActive(bot.id, false)).ok).toBe(true);
      expect(calls.find((c) => c.method === "deleteWebhook")?.body.drop_pending_updates).toBe(true);
      expect((await botRow(bot.id)).active).toBe(false);
      calls.length = 0;
      expect((await setBotActive(bot.id, true)).ok).toBe(true);
      expect(calls.some((c) => c.method === "setWebhook")).toBe(true);
      expect((await botRow(bot.id)).active).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = prev;
    }
  });

  it("ثبت هم‌زمان با یک توکن: دقیقاً یکی موفق، دیگری پیام روشن (نه خطای خام دیتابیس)", async () => {
    const rs = await Promise.all([registerBot({ workspaceId: null, provider: "bale", token: tok(50), mode: "polling" }), registerBot({ workspaceId: null, provider: "bale", token: tok(50), mode: "polling" })]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    const bad = rs.find((r) => !r.ok) as { ok: false; error: string };
    expect(bad.error).toContain("قبلاً ثبت");
  });
});

describe("M-10 — وب‌هوک خروجی پیام‌رسان: علت خطا حفظ می‌شود، متن بلند بریده می‌شود، پاسخ HTML موفق نیست", () => {
  const res = (status: number, body: string, ct = "application/json") => new Response(body, { status, headers: { "content-type": ct } });

  it("readMessengerResponse", async () => {
    await expect(readMessengerResponse(res(200, '{"ok":true,"result":{}}'))).resolves.toBeUndefined();
    await expect(readMessengerResponse(res(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}'))).rejects.toThrow("HTTP 400: Bad Request: chat not found");
    await expect(readMessengerResponse(res(200, '{"ok":false,"description":"Forbidden: bot was blocked by the user"}'))).rejects.toThrow(/blocked/);
    await expect(readMessengerResponse(res(200, "<html>login</html>", "text/html; charset=utf-8"))).rejects.toThrow(/HTML/);
    await expect(readMessengerResponse(res(502, "<html>bad gateway</html>", "text/html"))).rejects.toThrow(/^HTTP 502/);
    await expect(readMessengerResponse(res(200, ""))).resolves.toBeUndefined(); // رفتار قبلی برای پاسخ خالی حفظ شد
  });

  it("fitText: سقف ۴۰۰۰ و بدون شکستن ایموجی", () => {
    expect(fitText("کوتاه")).toBe("کوتاه");
    const t = fitText("😀".repeat(3000));
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(/[\ud800-\udbff]…$/.test(t)).toBe(false);
  });

  it("explain: علت دقیق از description، و خطای قدیمیِ بدون توضیح بدون تغییر", () => {
    expect(explainDeliveryError("HTTP 400: Bad Request: chat not found", "telegram").kind).toBe("bad_target");
    expect(explainDeliveryError("HTTP 400: Bad Request: message is too long", "bale").title).toMatch(/بلندتر/);
    expect(explainDeliveryError("HTTP 403: Forbidden: bot was blocked by the user", "telegram").title).toMatch(/مسدود/);
    expect(explainDeliveryError("HTTP 400: Bad Request: not enough rights to send text messages", "telegram").kind).toBe("auth");
    expect(explainDeliveryError("HTTP 400", "telegram").kind).toBe("bad_target");
    expect(explainDeliveryError("HTTP 401", "telegram").kind).toBe("auth");
    expect(explainDeliveryError("HTTP 404", "generic").kind).toBe("not_found");
  });
});
