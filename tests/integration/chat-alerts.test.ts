import http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { backgroundJobs, chatConversations, chatMessages, messengerBots, messengerChats, users, webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { createWorkspace } from "@/modules/tenancy/service";
import { markRead, touchAgent } from "@/modules/chat/service";
import { drainJobs } from "@/modules/jobs/queue";
import { registerBot } from "@/modules/messengers/service";
import { POST as webhook } from "@/app/api/messengers/webhook/[secret]/route";
import { POST as send } from "@/app/api/chat/send/route";
import { freshBrowser, uniq } from "../helpers";
import { newContract, setupWorkspace } from "../flows";

/**
 * اعلان گفتگوی زنده به پیام‌رسان‌ها: فوری/Escalation، Digest و محدودیت نرخ، پل پاسخ از پیام‌رسان، امنیت و کانال‌های یک‌طرفه.
 */
type Call = { provider: string; method: string; body: Record<string, unknown> };
const calls: Call[] = [];
let server: http.Server;
const TOKEN = "333333333:AAHalert_test_token_0123456789abcdefgh";

const BASE = "http://localhost:3000";
const post = (path: string, body: unknown) => new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const hook = (secret: string, update: unknown) => webhook(new NextRequest(`http://localhost/api/messengers/webhook/${secret}`, { method: "POST", body: JSON.stringify(update) }), { params: Promise.resolve({ secret }) });

let seq = 5000;
const textUpdate = (chat: number, text: string) => ({ update_id: ++seq, message: { message_id: seq, from: { id: chat, first_name: "پشتیبان" }, chat: { id: chat, type: "private" }, text } });
const cbUpdate = (chat: number, data: string) => ({ update_id: ++seq, callback_query: { id: `cb${seq}`, from: { id: chat, first_name: "پشتیبان" }, data, message: { message_id: 1, chat: { id: chat, type: "private" } } } });
const sent = (chatId: string) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === chatId);
const texts = (chatId: string) => sent(chatId).map((c) => String(c.body.text));
const markup = (c: Call) => JSON.stringify(c.body.reply_markup ?? {});

let ws: Awaited<ReturnType<typeof setupWorkspace>>;
let token: string;
let bot: typeof messengerBots.$inferSelect;
let convId = 0;
let convCode = "";

const guestSend = async (text: string, clientId: string) => {
  const r = await send(post("/api/chat/send", { kind: "sign", ref: token, text, clientId }));
  expect(r.status).toBe(200);
};
const conv = async () => (await db.select().from(chatConversations).where(eq(chatConversations.id, convId)))[0];
/** همه‌ی jobهای در انتظار را سررسید می‌کند و اجرا می‌کند (شبیه گذشتن زمان) */
const dueAndDrain = async (type?: string) => {
  await db.update(backgroundJobs).set({ runAt: new Date(Date.now() - 1000) }).where(and(eq(backgroundJobs.status, "pending"), type ? eq(backgroundJobs.type, type) : undefined));
  await drainJobs();
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/(telegram|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url || "");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* خالی */
      }
      const out = (result: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (!m) {
        res.statusCode = 404;
        return res.end("{}");
      }
      calls.push({ provider: m[1], method: m[3], body });
      if (m[3] === "getMe") return out({ id: 1, is_bot: true, first_name: "امضاگیر", username: "emz_alert_bot" });
      if (m[3] === "sendMessage") return out({ message_id: calls.length });
      return out(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.EXTERNAL_SIM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  ws = await setupWorkspace("تیم اعلان چت");
  const c = await newContract(ws.wsId, ws.owner.id, { title: "قرارداد اعلان" });
  token = (await getOrCreateSigningLink(c.signers[0].id))!.token;
  const r = await registerBot({ workspaceId: ws.wsId, provider: "bale", token: TOKEN, mode: "polling" });
  expect(r.ok).toBe(true);
  [bot] = await db.select().from(messengerBots).where(eq(messengerBots.id, (r as { id: number }).id));
  // چت پشتیبان (به حساب مالک وصل است) و یک چت غریبه (وصل‌نشده)
  await db.insert(messengerChats).values([
    { botId: bot.id, chatId: "880001", userId: ws.owner.id, linkedAt: new Date() },
    { botId: bot.id, chatId: "880002" },
  ]);
  freshBrowser();
});

afterAll(async () => {
  await db.delete(messengerBots);
  delete process.env.EXTERNAL_SIM_URL;
  await new Promise((r) => server.close(r));
});

describe("اعلان گفتگوی زنده در پیام‌رسان", () => {
  it("پیام مشتری وقتی کسی آنلاین نیست، فوری و فقط یک‌بار به پشتیبان در بله می‌رسد", async () => {
    await guestSend("سلام، کد پیامکی نرسید", "a-1");
    const [c] = await db.select().from(chatConversations).where(eq(chatConversations.workspaceId, ws.wsId)).orderBy(desc(chatConversations.id));
    convId = c.id;
    convCode = c.code;
    const t = texts("880001");
    expect(t).toHaveLength(1); // زنگوله پیام‌رسان دوباره نمی‌فرستد
    expect(t[0]).toContain("گفتگوی جدید");
    expect(t[0]).toContain("سلام، کد پیامکی نرسید");
    expect(t[0]).not.toMatch(/09\d{9}/); // اطلاعات تماس نمی‌آید
    expect(markup(sent("880001")[0])).toContain(`k:${convId}`);
    expect(markup(sent("880001")[0])).toContain(`h:${convId}`);
    expect(texts("880002")).toHaveLength(0); // چت غریبه‌ی وصل‌نشده هیچ اعلانی نمی‌گیرد
    expect((await conv()).alertedMsgId).toBeGreaterThan(0);
  });

  it("پیام‌های پشت‌سرهم: بارش اعلان نیست؛ پیام‌های میانی در یک اعلان خلاصه می‌رسند و هیچ‌کدام گم نمی‌شود", async () => {
    await guestSend("پیام دوم", "a-2");
    await guestSend("پیام سوم", "a-3");
    expect(texts("880001")).toHaveLength(1); // محدودیت نرخ
    const tail = await db.select().from(backgroundJobs).where(and(eq(backgroundJobs.type, "chat.alert"), eq(backgroundJobs.status, "pending")));
    expect(tail.some((j) => j.payload.includes('"tail"'))).toBe(true);
    // گذشتن زمان محدودیت
    await db.update(chatConversations).set({ alertedAt: new Date(Date.now() - 300_000) }).where(eq(chatConversations.id, convId));
    await dueAndDrain();
    const t = texts("880001");
    expect(t).toHaveLength(2);
    expect(t[1]).toContain("پیام دوم");
    expect(t[1]).toContain("پیام سوم");
    expect(t[1]).not.toContain("کد پیامکی نرسید");
    expect(t[1]).not.toContain("گفتگوی جدید");
  });

  it("پل پاسخ: «پاسخ از همین‌جا» ← پاسخ پشتیبان به مشتری می‌رسد و پیام بعدی مشتری فوراً برمی‌گردد", async () => {
    await hook(bot.webhookSecret, cbUpdate(880001, `k:${convId}`));
    expect(texts("880001").at(-1)).toContain("حالت پاسخ‌گویی فعال شد");
    let c = await conv();
    expect(c.assigneeId).toBe(ws.owner.id); // بی‌مسئول بود ⇒ برعهده‌گرفته شد
    expect(c.unreadStaff).toBe(0);
    const [chatRow] = await db.select().from(messengerChats).where(eq(messengerChats.chatId, "880001"));
    expect(chatRow.replyConvId).toBe(convId);

    await hook(bot.webhookSecret, textUpdate(880001, "سلام، همین الان بررسی می‌کنم"));
    expect(texts("880001").at(-1)).toContain("✅");
    const staffMsgs = await db.select().from(chatMessages).where(and(eq(chatMessages.conversationId, convId), eq(chatMessages.senderKind, "staff")));
    expect(staffMsgs.map((m) => m.body)).toContain("سلام، همین الان بررسی می‌کنم");
    expect(staffMsgs.at(-1)?.senderUserId).toBe(ws.owner.id);

    const before = texts("880001").length;
    await guestSend("ممنون، منتظرم", "a-4");
    const t = texts("880001");
    expect(t).toHaveLength(before + 1);
    expect(t.at(-1)).toContain("ممنون، منتظرم");
    expect(t.at(-1)).toContain("💬");

    // پایان نشست: متن عادی دیگر برای مشتری نمی‌رود
    await hook(bot.webhookSecret, textUpdate(880001, "/done"));
    expect(texts("880001").at(-1)).toContain("پایان");
    const n = (await db.select().from(chatMessages).where(and(eq(chatMessages.conversationId, convId), eq(chatMessages.senderKind, "staff")))).length;
    await hook(bot.webhookSecret, textUpdate(880001, "این نباید به مشتری برسد"));
    expect((await db.select().from(chatMessages).where(and(eq(chatMessages.conversationId, convId), eq(chatMessages.senderKind, "staff")))).length).toBe(n);
    c = await conv();
    expect(c.status).toBe("open");
  });

  it("پشتیبانِ آنلاین ولی بی‌توجه: پس از مهلت Escalation به پیام‌رسان اعلان می‌رود؛ اگر دیده باشد نه", async () => {
    await db.update(chatConversations).set({ alertedAt: null }).where(eq(chatConversations.id, convId));
    await touchAgent(ws.owner.id, `ws:${ws.wsId}`);
    const before = texts("880001").length;
    await guestSend("کسی هست؟", "b-1");
    expect(texts("880001")).toHaveLength(before); // آنلاین است ⇒ فوری نمی‌رود
    // پشتیبان دید ⇒ اعلانی لازم نیست
    await markRead(await conv(), "staff");
    await dueAndDrain("chat.alert");
    expect(texts("880001")).toHaveLength(before);

    await guestSend("هنوز منتظرم", "b-2");
    expect(texts("880001")).toHaveLength(before);
    await dueAndDrain("chat.alert");
    const t = texts("880001");
    expect(t).toHaveLength(before + 1);
    expect(t.at(-1)).toContain("هنوز منتظرم");
    // مسئول دارد (مالک) ⇒ به او می‌رسد؛ زنگوله‌ی اولویت هم ثبت شده
    expect(t.at(-1)).not.toContain("گفتگوی جدید");
  });

  it("امنیت: چت وصل‌نشده یا عضو تیم دیگر نمی‌تواند پاسخ دهد یا برعهده بگیرد", async () => {
    const before = (await db.select().from(chatMessages).where(eq(chatMessages.conversationId, convId))).length;
    // غریبه (وصل‌نشده)
    await hook(bot.webhookSecret, cbUpdate(880002, `k:${convId}`));
    expect(texts("880002").at(-1)).toMatch(/هویت|وصل/);
    // مالک فضای کاری دیگر با چتِ وصل‌شده
    const [other] = await db.insert(users).values({ name: "مالک دیگر", email: `${uniq("o")}@example.com`, mobile: `0912${String(Date.now() % 10_000_000).padStart(7, "0")}`, passwordHash: hashPassword("Other123x"), role: "user", emailVerifiedAt: new Date() }).returning();
    await createWorkspace(other.id, "تیم دیگر");
    await db.insert(messengerChats).values({ botId: bot.id, chatId: "880003", userId: other.id, linkedAt: new Date() });
    await hook(bot.webhookSecret, cbUpdate(880003, `k:${convId}`));
    expect(texts("880003").at(-1)).toContain("دسترسی");
    await hook(bot.webhookSecret, cbUpdate(880003, `h:${convId}`));
    expect(texts("880003").at(-1)).toContain("دسترسی");
    await hook(bot.webhookSecret, textUpdate(880003, "نفوذ"));
    const after = (await db.select().from(chatMessages).where(eq(chatMessages.conversationId, convId))).length;
    expect(after).toBe(before);
    const [row] = await db.select().from(messengerChats).where(eq(messengerChats.chatId, "880003"));
    expect(row.replyConvId).toBeNull();
    // /chats برای غیرتیم چیزی نشان نمی‌دهد
    await hook(bot.webhookSecret, textUpdate(880003, "/chats"));
    expect(texts("880003").at(-1)).toMatch(/دسترسی|بی‌پاسخی/);
  });

  it("/chats: گفتگوهای بی‌پاسخ را برای پشتیبانِ مجاز با دکمه‌ی پاسخ نشان می‌دهد", async () => {
    await hook(bot.webhookSecret, textUpdate(880001, "/chats"));
    const last = sent("880001").at(-1)!;
    expect(String(last.body.text)).toContain("منتظر پاسخ");
    expect(markup(last)).toContain(`k:${convId}`);
  });

  it("کانال‌های یک‌طرفه (ایتا/…): فقط با انتخاب صریح؛ مقصد «همه‌ی رویدادها» پیام مشتری را نمی‌گیرد", async () => {
    await db.insert(webhookEndpoints).values([
      { workspaceId: ws.wsId, name: "کانال ایتا", provider: "generic", target: "https://127.0.0.1/hook", events: "chat.message" },
      { workspaceId: ws.wsId, name: "همه", provider: "generic", target: "https://127.0.0.1/all", events: "*" },
    ]);
    await db.update(chatConversations).set({ alertedAt: new Date(Date.now() - 300_000), unreadStaff: 0 }).where(eq(chatConversations.id, convId));
    await guestSend("پیام برای کانال", "c-1");
    await dueAndDrain("chat.alert"); // پشتیبان هنوز «آنلاین» است ⇒ پس از مهلت بی‌پاسخی
    await new Promise((r) => setTimeout(r, 400));
    const rows = await db.select({ name: webhookEndpoints.name, event: webhookDeliveries.event }).from(webhookDeliveries).innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId)).where(eq(webhookEndpoints.workspaceId, ws.wsId));
    expect(rows.some((r) => r.name === "کانال ایتا" && r.event === "chat.message")).toBe(true);
    expect(rows.some((r) => r.name === "همه")).toBe(false);
    expect(convCode.length).toBeGreaterThan(8);
  });
});
