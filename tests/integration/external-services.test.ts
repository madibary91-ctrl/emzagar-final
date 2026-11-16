/**
 * «واکنش سیستم ما» در برابر اتفاقات سرویس‌های بیرونی (با شبیه‌ساز، بدون اینترنت و بدون هزینه)
 * پرداخت (زرین‌پال) · پیامک (کاوه‌نگار / ملی‌پیامک) · هوش مصنوعی (GapGPT) · تحلیل ریسک
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications, payments, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { assertSafeAiUrl, extTimeout, simActive, simulatorUrl } from "@/lib/external";
import { reconcilePendingPayments, getSubscription, startCheckout, verifyPayment } from "@/modules/billing/service";
import { priceFor } from "@/modules/billing/plans";
import { generateWithAi, testAiConnection, usageToday } from "@/modules/ai/service";
import { analyzeContractText } from "@/modules/risk/service";
import { sendSms } from "@/modules/sms";
import { saveSettings } from "@/modules/settings/service";
import { createWorkspace } from "@/modules/tenancy/service";
import { SimClient, startSimulator, type SimHandle } from "../../simulator";
import { uniq } from "../helpers";

let sim: SimHandle;
let c: SimClient;
let userId = 0;
const origin = "http://localhost:3000";
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  sim = await startSimulator({ port: 0, quiet: true, startPay: "auto" });
  c = new SimClient(sim.url);
  for (const k of ["EXTERNAL_SIM_URL", "EXTERNAL_TIMEOUT_SCALE", "ZARINPAL_MERCHANT_ID"]) saved[k] = process.env[k];
  process.env.EXTERNAL_SIM_URL = sim.url;
  process.env.EXTERNAL_TIMEOUT_SCALE = "0.02"; // مهلت‌ها ۵۰ برابر کوتاه: آزمون «بی‌پاسخ ماندن» ثانیه‌ای است
  delete process.env.ZARINPAL_MERCHANT_ID; // مرچنت ساختگی خودکار
  const [u] = await db.insert(users).values({ name: "شبیه‌ساز", email: `${uniq("sim")}@example.com`, mobile: "09120000077", passwordHash: hashPassword("Sim12345x"), emailVerifiedAt: new Date() }).returning();
  userId = u.id;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await sim.close();
});
beforeEach(async () => {
  await c.reset();
  await c.settings({ startPay: "auto" });
});

/* ───────── لایه‌ی اتصال و ایمنی ───────── */
describe("اتصال به شبیه‌ساز و ایمنی", () => {
  it("فقط میزبان محلی پذیرفته می‌شود مگر صریحاً اجازه داده شود", () => {
    const prev = process.env.EXTERNAL_SIM_URL;
    try {
      process.env.EXTERNAL_SIM_URL = "https://evil.example.com";
      expect(simulatorUrl()).toBeNull();
      expect(simActive()).toBe(false);
      process.env.EXTERNAL_SIM_ALLOW_REMOTE = "1";
      expect(simulatorUrl()?.hostname).toBe("evil.example.com");
      delete process.env.EXTERNAL_SIM_ALLOW_REMOTE;
      process.env.EXTERNAL_SIM_URL = "ftp://127.0.0.1";
      expect(simActive()).toBe(false);
      process.env.EXTERNAL_SIM_URL = "not a url";
      expect(simActive()).toBe(false);
    } finally {
      process.env.EXTERNAL_SIM_URL = prev;
    }
  });

  it("فیلتر SSRF: فقط خودِ شبیه‌ساز مستثناست، نه هر آدرس محلی دیگر", async () => {
    await expect(assertSafeAiUrl(`${sim.url}/gapgpt/v1`)).resolves.toBeInstanceOf(URL);
    await expect(assertSafeAiUrl("http://127.0.0.1:9/v1")).rejects.toThrow();
    await expect(assertSafeAiUrl("https://localhost/v1")).rejects.toThrow();
  });

  it("مهلت‌ها فقط در حالت شبیه‌ساز کوتاه می‌شوند", () => {
    expect(extTimeout(10_000)).toBe(200);
    const prev = process.env.EXTERNAL_SIM_URL;
    delete process.env.EXTERNAL_SIM_URL;
    expect(extTimeout(10_000)).toBe(10_000);
    process.env.EXTERNAL_SIM_URL = prev;
  });
});

/* ───────── پرداخت ───────── */
describe("پرداخت (زرین‌پال)", () => {
  const countPayments = async (ws: number) => (await db.select().from(payments).where(eq(payments.workspaceId, ws))).length;
  const newWs = (name: string) => createWorkspace(userId, name);
  const authorityOf = (url: string) => new URL(url).searchParams.get("Authority") ?? url.split("/").pop()!;
  /** مثل مرورگر: صفحه‌ی پرداخت را باز می‌کند و آدرس بازگشت را برمی‌گرداند */
  const browse = async (startUrl: string) => (await fetch(startUrl, { redirect: "manual" })).headers.get("location") ?? "";

  it("مسیر موفق: آدرس درگاه شبیه‌ساز، مبلغ به ریال، تایید و فعال‌سازی اشتراک", async () => {
    const ws = await newWs("پرداخت موفق");
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    expect(url.startsWith(`${sim.url}/zarinpal/pg/StartPay/`)).toBe(true);
    const authority = authorityOf(url);
    expect((await c.payment(authority)).amount).toBe(priceFor("pro", 1) * 10);

    const back = await browse(url);
    expect(back).toContain("Status=OK");
    const r = await verifyPayment(authority, "OK");
    expect(r.ok).toBe(true);
    expect((await getSubscription(ws)).planId).toBe("pro");
    const [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.status).toBe("paid");
    expect(row.refId).toBeTruthy();
    expect(row.gateway).toBe("zarinpal");
    expect(row.test).toBe(true); // پرداخت شبیه‌ساز/سندباکس هرگز درآمد واقعی حساب نمی‌شود (پرچم test)
    expect((await c.payment(authority)).verifyCalls).toBe(1);
  });

  it("قطعی درگاه هنگام شروع (۵۰۳)، قطع اتصال، بی‌پاسخی و پاسخ غیر JSON: پیام فارسی و بدون ثبت تراکنش", async () => {
    const ws = await newWs("قطعی شروع");
    for (const [scenario, re] of [
      ["service_down", /پاسخ نداد.*503/],
      ["network_error", /ارتباط با درگاه پرداخت برقرار نشد/],
      ["timeout", /مهلت/],
      ["garbage_response", /پاسخ نامعتبر/],
      ["empty_response", /پاسخ نامعتبر/],
      ["truncated_response", /پاسخ نداد/],
    ] as const) {
      await c.scenario("zarinpal", scenario);
      await expect(startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin }), scenario).rejects.toThrow(re);
    }
    expect(await countPayments(ws)).toBe(0);
  });

  it("خطاهای صریح درگاه (مرچنت غیرفعال، IP مسدود، تعلیق، تعداد زیاد) رد می‌شوند و اشتراکی فعال نمی‌شود", async () => {
    const ws = await newWs("خطای درگاه");
    for (const [scenario, code] of [["merchant_inactive", "-11"], ["ip_blocked", "-10"], ["terminal_suspended", "-15"], ["too_many_requests", "-12"], ["invalid_merchant", "-9"]] as const) {
      await c.scenario("zarinpal", scenario);
      await expect(startCheckout({ workspaceId: ws, userId, plan: "business", months: 1, origin }), scenario).rejects.toThrow(new RegExp(code));
    }
    expect(await countPayments(ws)).toBe(0);
    expect((await getSubscription(ws)).planId).toBe("free");
  });

  it("Authority خراب در پاسخ درگاه (حمله/باگ) هرگز ذخیره یا استفاده نمی‌شود", async () => {
    const ws = await newWs("authority خراب");
    await c.scenario("zarinpal", "authority_malformed");
    await expect(startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin })).rejects.toThrow();
    expect(await countPayments(ws)).toBe(0);
  });

  it("انصراف کاربر و خطای بانک: تراکنش ناموفق، اشتراک فعال نمی‌شود، بازگشت دوباره‌ی OK هم زنده‌اش نمی‌کند", async () => {
    for (const scenario of ["user_cancel", "bank_failure"]) {
      const ws = await newWs("لغو " + scenario);
      await c.scenario("zarinpal", scenario);
      const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
      const back = await browse(url);
      expect(back).toContain("Status=NOK");
      const authority = authorityOf(url);
      expect((await verifyPayment(authority, "NOK")).ok).toBe(false);
      expect((await verifyPayment(authority, "OK")).ok).toBe(false);
      expect((await getSubscription(ws)).planId).toBe("free");
      expect((await c.payment(authority)).verifyCalls).toBe(0); // اصلاً verify صدا زده نشد
    }
  });

  it("حمله: بازگشت با Status=OK بدون پرداخت واقعی ← verify رد می‌شود و اشتراک فعال نمی‌شود", async () => {
    const ws = await newWs("حمله OK جعلی");
    await c.scenario("zarinpal", "fake_ok_unpaid");
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    const back = await browse(url);
    expect(back).toContain("Status=OK");
    const authority = authorityOf(url);
    await c.scenario("zarinpal", "success");
    const r = await verifyPayment(authority, "OK");
    expect(r.ok).toBe(false);
    expect((await getSubscription(ws)).planId).toBe("free");
    const [row] = await db.select().from(payments).where(eq(payments.authority, authority));
    expect(row.status).toBe("failed");
  });

  it("مبلغ ناهمخوان یا Authority نامعتبر هنگام verify ← ناموفق قطعی", async () => {
    for (const scenario of ["amount_mismatch", "session_invalid", "verify_not_paid"]) {
      const ws = await newWs("verify " + scenario);
      const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
      await browse(url);
      await c.scenario("zarinpal", `verify@${scenario}`);
      const authority = authorityOf(url);
      expect((await verifyPayment(authority, "OK")).ok, scenario).toBe(false);
      expect((await getSubscription(ws)).planId).toBe("free");
      expect((await db.select().from(payments).where(eq(payments.authority, authority)))[0].status).toBe("failed");
    }
  });

  it("پاسخ ۱۰۱ (قبلاً تایید شده) موفق تلقی می‌شود", async () => {
    const ws = await newWs("کد 101");
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    await browse(url);
    await c.scenario("zarinpal", "verify@already_verified");
    expect((await verifyPayment(authorityOf(url), "OK")).ok).toBe(true);
    expect((await getSubscription(ws)).planId).toBe("pro");
  });

  it("🛟 قطعی درگاه هنگام تایید: پولِ کسرشده هرگز «ناموفق» ثبت نمی‌شود و بعداً خودکار فعال می‌شود", async () => {
    for (const outage of ["service_down", "network_error", "timeout", "garbage_response", "merchant_inactive_on_verify"]) {
      const ws = await newWs("verify outage " + outage);
      const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
      await browse(url);
      const authority = authorityOf(url);

      await c.scenario("zarinpal", `verify@${outage}`);
      const first = await verifyPayment(authority, "OK");
      expect(first.ok, outage).toBe(false);
      expect(first.message).toContain("در حال بررسی");
      let [row] = await db.select().from(payments).where(eq(payments.authority, authority));
      expect(row.status, outage).toBe("pending"); // نه failed
      expect(row.error).toContain("verify_pending");
      expect((await getSubscription(ws)).planId).toBe("free");

      // درگاه برمی‌گردد؛ زمان‌بند تراکنش‌های معلق را بازبینی می‌کند
      await c.scenario("zarinpal", "success");
      const rec = await reconcilePendingPayments();
      expect(rec.paid).toBeGreaterThanOrEqual(1);
      [row] = await db.select().from(payments).where(eq(payments.authority, authority));
      expect(row.status, outage).toBe("paid");
      expect((await getSubscription(ws)).planId, outage).toBe("pro");
    }
  });

  it("پرداخت‌شده ولی بازگشت به سایت قطع شد (تب بسته شد): بازبینی خودکار نباید تراکنش دیگران را خراب کند", async () => {
    const ws = await newWs("callback dropped");
    await c.scenario("zarinpal", "callback_dropped");
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    expect((await fetch(url, { redirect: "manual" })).status).toBe(200); // هیچ ریدایرکتی نیست
    expect((await c.payment(authorityOf(url))).status).toBe("paid");
    // در سیستم ما تراکنش هنوز pending است و (چون Status نیامده) توسط reconcile دست‌نخورده می‌ماند
    await reconcilePendingPayments();
    const [row] = await db.select().from(payments).where(eq(payments.authority, authorityOf(url)));
    expect(row.status).toBe("pending");
  });

  it("تایید همزمان ۶ درخواست (callback تکراری) فقط یک بار تمدید می‌کند، حتی با شبیه‌ساز کند", async () => {
    const ws = await newWs("همزمان");
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    await browse(url);
    await c.scenario("zarinpal", "slow:120");
    const results = await Promise.all(Array.from({ length: 6 }, () => verifyPayment(authorityOf(url), "OK")));
    expect(results.every((r) => r.ok)).toBe(true);
    const end = (await getSubscription(ws)).periodEnd!.getTime();
    expect(Math.abs(end - (Date.now() + 30 * 86400_000))).toBeLessThan(60_000);
  });

  it("سخت‌ترین حالت: صف [موفق، قطعی verify] — بدون دست‌زدن به کد، فقط با صف سناریو", async () => {
    const ws = await newWs("صف سناریو");
    await c.queue("zarinpal", ["success", "verify@service_down"]);
    const url = await startCheckout({ workspaceId: ws, userId, plan: "pro", months: 1, origin });
    await browse(url);
    expect((await verifyPayment(authorityOf(url), "OK")).ok).toBe(false);
    expect((await verifyPayment(authorityOf(url), "OK")).ok).toBe(true); // صف تمام شد؛ درگاه سالم است
  });
});

/* ───────── پیامک ───────── */
describe("پیامک (کاوه‌نگار و ملی‌پیامک)", () => {
  let ws = 0;
  const to = "09123334455";
  const lastNotification = async () => (await db.select().from(notifications).where(and(eq(notifications.workspaceId, ws), eq(notifications.channel, "sms"))).orderBy(desc(notifications.id)).limit(1))[0];

  beforeAll(async () => {
    ws = await createWorkspace(userId, "فضای پیامک");
    await saveSettings({ sms_provider: "kavenegar", kavenegar_api_key: "KN-TEST-KEY-1234567890", kavenegar_template: "verify" }, ws);
  });

  it("OTP از مسیر واقعی کاوه‌نگار می‌رود و ربات تست کد را از «صندوق پیامک» می‌خواند", async () => {
    const r = await sendSms({ to, text: "کد: 482913", token: "482913" }, null, ws);
    expect(r.ok).toBe(true);
    expect(r.testMode).toBe(false);
    expect((await c.lastSms(to)).code).toBe("482913");
    const n = await lastNotification();
    expect(n.status).toBe("sent");
    expect(n.body).not.toContain("482913"); // کد در حالت واقعی در دیتابیس ما ذخیره نمی‌شود
    const req = (await c.requests({ service: "kavenegar" })).at(-1)!;
    expect(req.phase).toBe("lookup");
    expect(req.path).toContain("KN-TEST-KEY-1234567890");
  });

  it("هر کد خطای کاوه‌نگار به پیام فارسی روشن تبدیل و به‌عنوان failed ثبت می‌شود", async () => {
    for (const [scenario, re] of [
      ["invalid_api_key", /کلید API کاوه‌نگار نامعتبر/],
      ["account_disabled", /غیرفعال/],
      ["insufficient_credit", /اعتبار پنل پیامک کافی نیست/],
      ["invalid_receptor", /شماره گیرنده نامعتبر/],
      ["template_not_found", /قالب/],
      ["ip_not_allowed", /IP سرور/],
      ["rate_limited", /تعداد درخواست/],
      ["test_account_limit", /حساب آزمایشی/],
    ] as const) {
      await c.scenario("kavenegar", scenario);
      const r = await sendSms({ to, text: "x", token: "111222" }, null, ws);
      expect(r.ok, scenario).toBe(false);
      expect(r.error, scenario).toMatch(re);
      expect((await lastNotification()).status).toBe("failed");
    }
  });

  it("🛟 خطا با HTTP 200 (return.status=418) هم خطا تشخیص داده می‌شود، نه موفقیت", async () => {
    await c.scenario("kavenegar", "http200_failure");
    const r = await sendSms({ to, text: "x", token: "333444" }, null, ws);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/اعتبار/);
  });

  it("قطعی/کندی/پاسخ خراب: پیام فارسی (هرگز «fetch failed» خام)", async () => {
    for (const [scenario, re] of [
      ["service_down", /در دسترس نیست \(HTTP 503\)/],
      ["bad_gateway", /در دسترس نیست \(HTTP 502\)/],
      ["network_error", /ارتباط با پنل پیامک برقرار نشد/],
      ["timeout", /مهلت/],
      ["garbage_response", /پاسخ نامعتبر/],
      ["empty_response", /پاسخ نامعتبر/],
      ["redirect", /ریدایرکت|برقرار نشد/],
    ] as const) {
      await c.scenario("kavenegar", scenario);
      const r = await sendSms({ to, text: "x", token: "555666" }, null, ws);
      expect(r.ok, scenario).toBe(false);
      expect(r.error, scenario).toMatch(re);
      expect(r.error).not.toMatch(/fetch failed/i);
    }
  });

  it("اتمام اعتبار واقعی (حالت‌دار): پیامک‌ها تا صفر شدن موفق و بعد خودکار ۴۱۸", async () => {
    await c.setCredit("kavenegar", 2);
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await sendSms({ to, text: "x", token: `70000${i}` }, null, ws)).ok);
    expect(results).toEqual([true, true, false]);
  });

  it("کلید جادویی ~سناریو: بدون کنترل سراسری، یک فضای کاری خاص را خراب می‌کند", async () => {
    const ws2 = await createWorkspace(userId, "فضای کلید خراب");
    await saveSettings({ sms_provider: "kavenegar", kavenegar_api_key: "KN-TEST-KEY-1234567890~insufficient_credit" }, ws2);
    expect((await sendSms({ to, text: "x", token: "800001" }, null, ws2)).error).toMatch(/اعتبار/);
    expect((await sendSms({ to, text: "x", token: "800002" }, null, ws)).ok).toBe(true); // فضای دیگر سالم
  });

  it("ملی‌پیامک: موفقیت فقط با recId واقعی؛ کدهای خطای کوچک با HTTP 200 خطا هستند", async () => {
    const ws3 = await createWorkspace(userId, "فضای ملی‌پیامک");
    await saveSettings({ sms_provider: "melipayamak", melipayamak_username: "user", melipayamak_password: "pass", melipayamak_from: "5000" }, ws3);
    const ok = await sendSms({ to, text: "کد 1234" }, null, ws3);
    expect(ok.ok).toBe(true);
    for (const [scenario, re] of [
      ["bad_credentials", /رمز عبور.*اشتباه/],
      ["insufficient_credit", /اعتبار/],
      ["daily_limit", /سقف ارسال روزانه/],
      ["invalid_sender", /فرستنده/],
      ["filtered_text", /فیلتر/],
      ["blacklisted", /سیاه/],
      ["empty_value", /ملی‌پیامک/],
      ["service_down", /در دسترس نیست/],
      ["network_error", /ارتباط/],
    ] as const) {
      await c.scenario("melipayamak", scenario);
      const r = await sendSms({ to, text: "کد 1234" }, null, ws3);
      expect(r.ok, scenario).toBe(false);
      expect(r.error, scenario).toMatch(re);
    }
  });
});

/* ───────── هوش مصنوعی ───────── */
describe("هوش مصنوعی (GapGPT)", () => {
  let ws = 0;
  const gen = (extra: Partial<Parameters<typeof generateWithAi>[0]> = {}) =>
    generateWithAi({ workspaceId: ws, workspaceName: "فضای هوش", userId, mode: "generate", prompt: "قرارداد خدمات مشاوره‌ی یک ساله", length: "standard", ...extra });

  beforeAll(async () => {
    ws = await createWorkspace(userId, "فضای هوش مصنوعی");
    await saveSettings({ ai_api_key: "sk-sim-test-key-123456" }, ws);
  });

  it("موفقیت: متن HTML با متغیرهای سیستم و شمارش سهمیه", async () => {
    const before = (await usageToday(ws)).used;
    const r = await gen();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toContain("ماده ۱");
      expect(r.html).toMatch(/\[[A-Z_]+\]/); // متغیرهای VARIABLES از پرامپت سیستمی استخراج و استفاده شد
      expect(r.html).toContain("خدمات مشاوره");
    }
    expect((await usageToday(ws)).used).toBe(before + 1);
  });

  it("هر خطای سرویس پیام فارسی دارد و سهمیه‌ی کاربر را مصرف نمی‌کند", async () => {
    const before = (await usageToday(ws)).used;
    for (const [scenario, re] of [
      ["invalid_key", /کلید API نامعتبر/],
      ["forbidden", /کلید API نامعتبر/],
      ["rate_limit", /محدودیت نرخ/],
      ["quota_exceeded", /محدودیت نرخ/],
      ["server_error", /خطای سرویس هوش مصنوعی \(500\)/],
      ["overloaded", /\(503\)/],
      ["model_not_found", /\(404\)/],
      ["context_length", /\(400\)/],
      ["empty_content", /خالی یا نامعتبر/],
      ["null_content", /خالی یا نامعتبر/],
      ["no_choices", /خالی یا نامعتبر/],
      ["content_filter", /خالی یا نامعتبر/],
      ["short_reply", /خالی یا نامعتبر/],
      ["garbage_response", /غیر JSON/],
      ["empty_response", /غیر JSON/],
      ["network_error", /ارتباط با سرویس هوش مصنوعی برقرار نشد/],
      ["timeout", /مهلت/],
      ["bad_gateway", /\(502\)/],
    ] as const) {
      await c.scenario("gapgpt", scenario);
      const r = await gen();
      expect(r.ok, scenario).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(502);
        expect(r.error, scenario).toMatch(re);
        expect(r.error).not.toMatch(/Unexpected token|fetch failed/i);
      }
    }
    expect((await usageToday(ws)).used).toBe(before);
  });

  it("🛡️ خروجی مخرب مدل (script/onerror/javascript:/iframe/style) پاک‌سازی می‌شود", async () => {
    await c.scenario("gapgpt", "xss_payload");
    const r = await gen();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).not.toMatch(/<script|onerror|onclick|javascript:|<iframe|<style|alert\(/i);
      expect(r.html).toContain("قرارداد آزمایشی امنیت");
    }
  });

  it("حصار markdown (```html) از خروجی حذف می‌شود", async () => {
    await c.scenario("gapgpt", "markdown_fenced");
    const r = await gen();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).not.toContain("```");
  });

  it("حالت بازنویسی (improve) و سقف rpm سرویس", async () => {
    const r = await gen({ mode: "improve", prompt: "بند محرمانگی اضافه کن", existingHtml: "<p>متن اولیه قرارداد خدمات</p>" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain("بازنویسی");
    await c.scenario("gapgpt", "rpm:1");
    expect((await gen()).ok).toBe(true);
    const limited = await gen();
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error).toMatch(/محدودیت نرخ/);
  });

  it("هر آدرس سرویس ذخیره‌شده (حتی اینترنتیِ واقعی) در حالت شبیه‌ساز به شبیه‌ساز هدایت می‌شود (هیچ نشتی به اینترنت نیست)", async () => {
    const ws2 = await createWorkspace(userId, "آدرس اینترنتی");
    await saveSettings({ ai_api_key: "sk-sim-test-key-123456", ai_base_url: "https://api.openai.com/v1" }, ws2);
    const mark = await c.mark();
    const r = await generateWithAi({ workspaceId: ws2, workspaceName: "x", userId, mode: "generate", prompt: "قرارداد تست", length: "short" });
    expect(r.ok).toBe(true);
    const hits = await c.requests({ service: "gapgpt", since: mark });
    expect(hits.some((h) => h.phase === "chat")).toBe(true);
  });

  it("تست اتصال: فهرست مدل‌ها، کلید نامعتبر، نبود /models (جایگزین چت) و قطعی", async () => {
    const cfg = { key: "sk-test-123456", baseUrl: "https://api.gapgpt.app/v1", model: "gpt-4o" };
    const ok = await testAiConnection(cfg);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.models).toContain("gpt-4o");

    await c.scenario("gapgpt", "invalid_key");
    const bad = await testAiConnection(cfg);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/کلید API نامعتبر/);

    await c.scenario("gapgpt", "no_models_endpoint");
    const fallback = await testAiConnection(cfg);
    expect(fallback).toEqual({ ok: true, models: [] });

    await c.scenario("gapgpt", "network_error");
    const down = await testAiConnection(cfg);
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error).toMatch(/ارتباط/);

    await c.scenario("gapgpt", "timeout");
    const slow = await testAiConnection(cfg);
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.error).toMatch(/مهلت/);
    expect((await testAiConnection({ ...cfg, key: "" })).ok).toBe(false);
  });

  it("تحلیل ریسک: با AI ترکیبی؛ با خطای AI یا JSON خراب به موتور قواعد برمی‌گردد (تحلیل هرگز از بین نمی‌رود)", async () => {
    const input = { workspaceId: ws, userId, title: "قرارداد آزمون", html: "<p>پیمانکار هرگونه خسارت را بدون هیچ سقفی می‌پردازد و جریمه‌ی تاخیر فقط برای او اعمال می‌شود.</p>", useAi: true };
    const good = await analyzeContractText(input);
    expect(good.engine).toBe("ai+rules");
    expect(good.result.findings.some((f) => f.source === "ai")).toBe(true);

    for (const scenario of ["bad_json", "server_error", "network_error", "timeout", "garbage_response", "rate_limit"]) {
      await c.scenario("gapgpt", scenario);
      const r = await analyzeContractText(input);
      expect(r.engine, scenario).toBe("rules");
      expect(r.aiNote, scenario).toBeTruthy();
      expect(r.result.findings.length, scenario).toBeGreaterThan(0);
    }

    await c.scenario("gapgpt", "risk_wrapped_json");
    expect((await analyzeContractText(input)).engine).toBe("ai+rules"); // JSON میان متن و حصار هم استخراج می‌شود
  });
});
