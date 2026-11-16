import http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { messengerBots, messengerChats, notifications, userNotifications, users } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { notifyUser } from "@/modules/inbox/service";
import { guestSendOtpAction, guestVerifyOtpAction } from "@/modules/signing/guest-actions";
import { getOrCreateSigningLink } from "@/modules/signing/links";
import { POST as webhook } from "@/app/api/messengers/webhook/[secret]/route";
import { pollOnce } from "@/modules/messengers/poller";
import { contractAccess } from "@/modules/messengers/contracts";
import { botInScope, chatTargetsForUser, createLinkCode, registerBot } from "@/modules/messengers/service";
import { headerSecretFor, makeGuestLinkCode } from "@/modules/messengers/util";
import { freshBrowser } from "../helpers";
import { getSigners, issueContract } from "@/modules/contracts/service";
import { ensureClient } from "@/modules/tenancy/service";
import { setupWorkspace } from "../flows";
import { uniq } from "../helpers";

/** موبایل‌های یکتا: داده‌ی این فایل نباید با موبایل‌های ثابت آزمون‌های دیگر (مثل کیف اسناد) برخورد کند */
let mobSeq = 0;
const uniqueMobile = () => `0919${String(Date.now() % 100000).padStart(5, "0")}${String(mobSeq++ % 100).padStart(2, "0")}`.slice(0, 11);
async function newContract(wsId: number, ownerId: number, opts: { title?: string } = {}) {
  const a = await ensureClient(wsId, { name: "فروشنده", email: `${uniq("m")}@example.com`, mobile: uniqueMobile() });
  const b = await ensureClient(wsId, { name: "خریدار", email: `${uniq("m")}@example.com`, mobile: uniqueMobile() });
  const id = await issueContract({
    workspaceId: wsId,
    title: opts.title ?? "قرارداد پیام‌رسان",
    bodyHtml: "<h2>موضوع</h2><p>متن آزمایشی قرارداد بین دو طرف برای آزمون ربات پیام‌رسان.</p>",
    customerId: b.userId,
    extraSigners: [{ label: "فروشنده", userId: a.userId }],
    createdBy: ownerId,
  });
  return { id, signers: await getSigners(id) };
}

/** سرور جعلی Bot API (تلگرام/بله) — همه‌ی تماس‌ها ثبت می‌شود */
type Call = { provider: string; method: string; body: Record<string, unknown> };
const calls: Call[] = [];
let server: http.Server;
const updatesQueue: Record<string, unknown[]> = {};

const TOKEN_BALE = "111111111:AAHbale_test_token_0123456789abcdefgh";
const TOKEN_TG = "222222222:AAHtele_test_token_0123456789abcdefgh";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const m = /^\/(telegram|bale)\/bot([^/]+)\/(\w+)$/.exec(req.url || "");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = { _raw: raw.slice(0, 200) };
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
      if (m[3] === "getMe") return out({ id: 1, is_bot: true, first_name: "امضاگیر", username: m[1] === "bale" ? "emz_bale_bot" : "emz_tg_bot" });
      if (m[3] === "getUpdates") {
        const u = updatesQueue[m[2]] ?? [];
        updatesQueue[m[2]] = [];
        return out(u);
      }
      if (m[3] === "sendMessage" || m[3] === "sendDocument") return out({ message_id: calls.length });
      return out(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.EXTERNAL_SIM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  // پاک‌سازی: ربات‌ها/چت‌های این فایل نباید به آزمون‌های بعدی (موبایل‌های مشترک) نشت کنند
  await db.delete(messengerBots);
  delete process.env.EXTERNAL_SIM_URL;
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  calls.length = 0;
  freshBrowser();
});

let seq = 1000;
const sent = (chatId: string) => calls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === chatId).map((c) => String(c.body.text));
const post = (secret: string, update: unknown, headers: Record<string, string> = {}) =>
  webhook(new NextRequest(`http://localhost/api/messengers/webhook/${secret}`, { method: "POST", body: JSON.stringify(update), headers }), { params: Promise.resolve({ secret }) });
const contactUpdate = (chat: number, mobile: string, userId = chat) => ({
  update_id: ++seq,
  message: { message_id: seq, from: { id: chat, first_name: "کاربر" }, chat: { id: chat, type: "private" }, contact: { phone_number: mobile, user_id: userId } },
});
const textUpdate = (chat: number, text: string) => ({ update_id: ++seq, message: { message_id: seq, from: { id: chat, first_name: "کاربر" }, chat: { id: chat, type: "private" }, text } });

let wsId: number;
let ownerId: number;
let bale: typeof messengerBots.$inferSelect;
let telegram: typeof messengerBots.$inferSelect;

describe("ربات‌های پیام‌رسان (بله/تلگرام)", () => {
  beforeAll(async () => {
    const s = await setupWorkspace("فضای ربات");
    wsId = s.wsId;
    ownerId = s.owner.id;
  });

  it("ثبت ربات: توکن رمزنگاری می‌شود، تکراری و نامعتبر رد می‌شود", async () => {
    expect((await registerBot({ workspaceId: null, provider: "bale", token: "bad", mode: "polling" })).ok).toBe(false);
    const r = await registerBot({ workspaceId: null, provider: "bale", token: TOKEN_BALE, mode: "polling" });
    expect(r.ok).toBe(true);
    const id = (r as { id: number }).id;
    [bale] = await db.select().from(messengerBots).where(eq(messengerBots.id, id));
    expect(bale.status).toBe("connected");
    expect(bale.botUsername).toBe("emz_bale_bot");
    expect(bale.tokenEnc.startsWith("enc:v1:")).toBe(true);
    expect(bale.tokenEnc).not.toContain(TOKEN_BALE);
    expect(decryptSecret(bale.tokenEnc)).toBe(TOKEN_BALE);
    expect(calls.some((c) => c.provider === "bale" && c.method === "deleteWebhook")).toBe(true); // polling ⇒ وب‌هوک حذف
    expect((await registerBot({ workspaceId: null, provider: "bale", token: TOKEN_BALE })).ok).toBe(false);

    // وب‌هوک روی آدرس غیر HTTPS (در آزمون: http://localhost) ⇒ ربات ثبت می‌شود ولی با خطای قابل‌فهم
    const t = await registerBot({ workspaceId: null, provider: "telegram", token: TOKEN_TG, mode: "webhook" });
    expect(t.ok && t.warning).toMatch(/HTTPS/);
    [telegram] = await db.select().from(messengerBots).where(eq(messengerBots.provider, "telegram"));
    expect(telegram.status).toBe("error");
  });

  it("وب‌هوک: راز نادرست ۴۰۴؛ تلگرام بدون هدر راز ۴۰۴؛ هدر درست ۲۰۰", async () => {
    expect((await post("0".repeat(48), {})).status).toBe(404);
    expect((await post("not-hex", {})).status).toBe(404);
    expect((await post(telegram.webhookSecret, textUpdate(5, "/help"))).status).toBe(404);
    expect((await post(telegram.webhookSecret, textUpdate(5, "/help"), { "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(404);
    expect((await post(telegram.webhookSecret, textUpdate(5, "/help"), { "x-telegram-bot-api-secret-token": headerSecretFor(telegram.webhookSecret) })).status).toBe(200);
    expect((await post(bale.webhookSecret, textUpdate(6, "/help"))).status).toBe(200);
    expect(sent("6").join("\n")).toContain("/pending");
  });

  it("اشتراک شماره: فقط شماره‌ی خودِ فرستنده؛ سپس لینک امضا و OTP از پیام‌رسان", async () => {
    const { id: contractId, signers } = await newContract(wsId, ownerId);
    const first = signers[0];
    const [fu] = await db.select().from(users).where(eq(users.id, first.userId));

    // جعل: مخاطبِ شخص دیگر (user_id ≠ from.id) رد می‌شود
    await post(bale.webhookSecret, contactUpdate(901, fu.mobile, 12345));
    expect(sent("901").join("\n")).toContain("⛔");
    expect((await db.select().from(messengerChats).where(eq(messengerChats.chatId, "901")))[0].verifiedMobile).toBe("");

    // شماره‌ی درست
    calls.length = 0;
    await post(bale.webhookSecret, contactUpdate(901, `+98${fu.mobile.slice(1)}`));
    const chat = (await db.select().from(messengerChats).where(eq(messengerChats.chatId, "901")))[0];
    expect(chat.verifiedMobile).toBe(fu.mobile);
    const texts = sent("901").join("\n");
    expect(texts).toContain("تأیید شد");
    expect(texts).toContain("/sign/"); // نوبت اوست ⇒ لینک امضا (آدرس محلی به‌صورت متن)

    // OTP: اول پیام‌رسان؛ پیامک نمی‌رود
    calls.length = 0;
    const link = (await getOrCreateSigningLink(first.id))!;
    const smsBefore = (await db.select().from(notifications).where(and(eq(notifications.recipient, fu.mobile), eq(notifications.channel, "sms")))).length;
    const otp = await guestSendOtpAction(link.token);
    expect(otp.ok).toBe(true);
    const codeMsg = sent("901").find((t) => t.includes("کد تأیید"));
    const code = /\n(\d{4,8})\n/.exec(codeMsg || "")?.[1];
    expect(code).toBeTruthy();
    const smsAfter = (await db.select().from(notifications).where(and(eq(notifications.recipient, fu.mobile), eq(notifications.channel, "sms")))).length;
    expect(smsAfter).toBe(smsBefore);
    expect((await guestVerifyOtpAction(link.token, code!)).ok).toBe(true);

    // حالت off: فقط پیامک
    await db.update(messengerBots).set({ otpMode: "off" }).where(eq(messengerBots.id, bale.id));
    calls.length = 0;
    const [signer2] = (await newContract(wsId, ownerId)).signers;
    const [u2] = await db.select().from(users).where(eq(users.id, signer2.userId));
    await post(bale.webhookSecret, contactUpdate(902, u2.mobile));
    calls.length = 0;
    freshBrowser();
    const link2 = (await getOrCreateSigningLink(signer2.id))!;
    expect((await guestSendOtpAction(link2.token)).ok).toBe(true);
    expect(sent("902").some((t) => t.includes("کد تأیید"))).toBe(false);
    await db.update(messengerBots).set({ otpMode: "prefer" }).where(eq(messengerBots.id, bale.id));
    expect(contractId).toBeGreaterThan(0);
  });

  it("اتصال حساب با کد یک‌بارمصرف و دریافت اعلان درون‌برنامه‌ای در پیام‌رسان", async () => {
    const r = await createLinkCode(ownerId, bale.id);
    expect(r.ok).toBe(true);
    const code = new URL((r as { url: string }).url).searchParams.get("start")!;
    expect((r as { url: string }).url.startsWith("https://ble.ir/emz_bale_bot?start=l")).toBe(true);

    await post(bale.webhookSecret, textUpdate(950, `/start ${code}`));
    const [chat] = await db.select().from(messengerChats).where(eq(messengerChats.chatId, "950"));
    expect(chat.userId).toBe(ownerId);
    // کد دوباره مصرف نمی‌شود
    calls.length = 0;
    await post(bale.webhookSecret, textUpdate(951, `/start ${code}`));
    expect((await db.select().from(messengerChats).where(eq(messengerChats.chatId, "951")))[0].userId).toBeNull();
    expect(sent("951").join("\n")).toContain("نامعتبر");

    // اعلان زنگوله ← پیام‌رسان
    calls.length = 0;
    await notifyUser(ownerId, { kind: "success", title: "قرارداد آزمون نهایی شد", body: "همه امضا کردند" });
    expect(sent("950").join("\n")).toContain("قرارداد آزمون نهایی شد");

    // بی‌صدا ⇒ اعلان نمی‌رسد
    await post(bale.webhookSecret, textUpdate(950, "/mute"));
    calls.length = 0;
    await notifyUser(ownerId, { title: "اعلان بی‌صدا" });
    expect(sent("950").join("\n")).not.toContain("اعلان بی‌صدا");
    expect((await db.select().from(userNotifications).where(eq(userNotifications.userId, ownerId)).orderBy(desc(userNotifications.id)).limit(1))[0].title).toBe("اعلان بی‌صدا");
  });

  it("وضعیت قرارداد، دسترسی و جداسازی فضای کاری", async () => {
    const { id, signers } = await newContract(wsId, ownerId, { title: "قرارداد وضعیت" });
    const [su] = await db.select().from(users).where(eq(users.id, signers[0].userId));
    await post(bale.webhookSecret, contactUpdate(960, su.mobile));
    const [num] = (await db.execute(`select number from contracts where id = ${id}`)).rows as { number: string }[];
    calls.length = 0;
    await post(bale.webhookSecret, textUpdate(960, `/status ${num.number}`));
    const t = sent("960").join("\n");
    expect(t).toContain("قرارداد وضعیت");
    expect(t).toContain("امضاکنندگان");

    // چت بیگانه (بدون هیچ ارتباط با قرارداد) چیزی نمی‌بیند
    calls.length = 0;
    await post(bale.webhookSecret, contactUpdate(961, "09129999999"));
    calls.length = 0;
    await post(bale.webhookSecret, textUpdate(961, `/status ${num.number}`));
    expect(sent("961").join("\n")).toContain("پیدا نشد");

    // ربات اختصاصی یک فضای کاری دیگر هیچ‌وقت قرارداد این فضا را نشان نمی‌دهد
    const other = await setupWorkspace("فضای دیگر");
    const r = await registerBot({ workspaceId: other.wsId, provider: "bale", token: "333333333:AAHother_token_0123456789abcdefghij", mode: "polling" });
    const ob = (await botInScope((r as { id: number }).id, other.wsId))!;
    const [chat] = await db.select().from(messengerChats).where(eq(messengerChats.chatId, "960"));
    const access = await contractAccess({ chat, bot: ob }, [signers[0].userId], id);
    expect(access).toBeNull();
    expect(await contractAccess({ chat, bot: bale }, [signers[0].userId], id)).not.toBeNull();
  });

  it("کد مهمان امضاشده فقط به همان مهمان وصل می‌شود؛ مسدودکردن ربات چت را از ارسال خارج می‌کند", async () => {
    const { signers } = await newContract(wsId, ownerId);
    const uid = signers[0].userId;
    await post(bale.webhookSecret, textUpdate(970, `/start ${makeGuestLinkCode(uid)}`));
    // کاربر عادی (غیر مهمان) با کد مهمان وصل نمی‌شود
    expect((await db.select().from(messengerChats).where(eq(messengerChats.chatId, "970")))[0].userId).toBeNull();

    // مسدود: ارسال ۴۰۳ ← chat.blocked
    await db.update(messengerChats).set({ userId: ownerId, blocked: false }).where(eq(messengerChats.chatId, "950"));
    expect((await chatTargetsForUser(ownerId)).length).toBeGreaterThan(0);
    await db.update(messengerChats).set({ blocked: true }).where(eq(messengerChats.chatId, "950"));
    expect((await chatTargetsForUser(ownerId)).filter((t) => t.chat.chatId === "950")).toHaveLength(0);
  });

  it("حالت Polling: آپدیت‌ها دریافت و پردازش می‌شوند و offset جلو می‌رود", async () => {
    const [b] = await db.select().from(messengerBots).where(eq(messengerBots.id, bale.id));
    updatesQueue[TOKEN_BALE] = [textUpdate(980, "/help")];
    const n = await pollOnce();
    expect(n).toBe(1);
    expect(sent("980").join("\n")).toContain("راهنمای ربات");
    const [after] = await db.select().from(messengerBots).where(eq(messengerBots.id, bale.id));
    expect(after.lastUpdateId).toBeGreaterThan(b.lastUpdateId);
    expect(after.pollLeaseUntil).toBeNull();
    // آپدیت تکراری دوباره پردازش نمی‌شود
    calls.length = 0;
    const dup = textUpdate(980, "/help");
    await post(bale.webhookSecret, dup);
    const first = sent("980").length;
    await post(bale.webhookSecret, dup);
    expect(sent("980").length).toBe(first);
  });
});
