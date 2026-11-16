/**
 * آزمون خودِ شبیه‌ساز: مطمئن می‌شویم «بازیگر نقش سرویس‌ها» دقیق و قابل‌اعتماد است
 * (اعتبارسنجی ورودی، حالت‌داری، موتور سناریو، تکرارپذیری آشوب، پنل کنترل).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SimClient, SimError, startSimulator, type SimHandle } from "../../simulator";

let sim: SimHandle;
let c: SimClient;
const MERCHANT = "00000000-0000-0000-0000-000000000000";
const j = { "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(sim.url + path, { method: "POST", headers: { ...j, ...headers }, body: JSON.stringify(body) });

beforeAll(async () => {
  sim = await startSimulator({ port: 0, quiet: true, startPay: "auto", seed: 7 });
  c = new SimClient(sim.url);
});
afterAll(() => sim.close());
beforeEach(async () => {
  await c.reset();
  await c.settings({ startPay: "auto" });
});

const zpReq = (over: Record<string, unknown> = {}) => post("/zarinpal/pg/v4/payment/request.json", { merchant_id: MERCHANT, amount: 20000, callback_url: "http://localhost:3000/cb", description: "t", ...over });
const zpVerify = (authority: string, over: Record<string, unknown> = {}) => post("/zarinpal/pg/v4/payment/verify.json", { merchant_id: MERCHANT, amount: 20000, authority, ...over });

describe("شبیه‌ساز زرین‌پال", () => {
  it("ورودی نامعتبر را مثل درگاه واقعی با کد -9 رد می‌کند", async () => {
    const r = await zpReq({ amount: 500, callback_url: "nope" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: { code: number; validations: unknown[] } };
    expect(body.errors.code).toBe(-9);
    expect(body.errors.validations.length).toBe(2);
    expect(((await (await zpReq({ merchant_id: "abc" })).json()) as { errors: { code: number } }).errors.code).toBe(-9);
  });

  it("چرخه‌ی حالت‌دار: پرداخت‌نشده ← -51، پرداخت ← 100، تکراری ← 101، مبلغ/مرچنت/Authority اشتباه", async () => {
    const { data } = (await (await zpReq()).json()) as { data: { code: number; authority: string } };
    expect(data.code).toBe(100);
    expect(data.authority).toMatch(/^A\d{35}$/);
    const code = async (r: Response) => ((await r.json()) as { errors: { code?: number } | never[] }).errors;
    const errCode = async (r: Response) => {
      const e = await code(r);
      return Array.isArray(e) ? undefined : e.code;
    };

    expect(await errCode(await zpVerify(data.authority))).toBe(-51); // هنوز پرداخت نشده
    await c.settle(data.authority, "success");
    expect(await errCode(await zpVerify(data.authority, { amount: 99999 }))).toBe(-50);
    expect(await errCode(await zpVerify(data.authority, { merchant_id: "11111111-1111-1111-1111-111111111111" }))).toBe(-53);
    expect(await errCode(await zpVerify("A" + "9".repeat(35)))).toBe(-54);
    const ok = (await (await zpVerify(data.authority)).json()) as { data: { code: number; ref_id: number } };
    expect(ok.data.code).toBe(100);
    const again = (await (await zpVerify(data.authority)).json()) as { data: { code: number; ref_id: number } };
    expect(again.data.code).toBe(101);
    expect(again.data.ref_id).toBe(ok.data.ref_id);
  });

  it("صفحه‌ی پرداخت: خودکار، دستی و انصراف", async () => {
    const mk = async () => ((await (await zpReq()).json()) as { data: { authority: string } }).data.authority;
    let a = await mk();
    let r = await fetch(`${sim.url}/zarinpal/pg/StartPay/${a}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`http://localhost:3000/cb?Authority=${a}&Status=OK`);

    await c.settings({ startPay: "manual" });
    a = await mk();
    r = await fetch(`${sim.url}/zarinpal/pg/StartPay/${a}`, { redirect: "manual" });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('data-sim-action="success"');
    const decided = await fetch(`${sim.url}/zarinpal/pg/StartPay/${a}/decide`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "outcome=cancel" });
    expect(decided.headers.get("location")).toContain("Status=NOK");
    expect((await c.payment(a)).status).toBe("canceled");
  });
});

describe("شبیه‌ساز کاوه‌نگار و ملی‌پیامک", () => {
  const kn = (path: string, key = "KEY12345678") => fetch(`${sim.url}/kavenegar/v1/${key}/${path}`);

  it("گیرنده/توکن/قالب را اعتبارسنجی و پیامک را در صندوق ذخیره می‌کند", async () => {
    expect((await kn("sms/send.json?receptor=123&message=hi")).status).toBe(411);
    expect((await kn("verify/lookup.json?receptor=09120000000&token=12%2034&template=verify")).status).toBe(432);
    await c.setKavenegarTemplates(["verify"]);
    expect((await kn("verify/lookup.json?receptor=09120000000&token=1234&template=other")).status).toBe(424);
    const ok = await kn("verify/lookup.json?receptor=09120000000&token=482913&template=verify");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { return: { status: number } }).return.status).toBe(200);
    const last = await c.lastSms("09120000000");
    expect(last.code).toBe("482913");
    expect(last.sms.provider).toBe("kavenegar");
    await expect(c.lastSms("09999999999")).rejects.toBeInstanceOf(SimError);
  });

  it("اعتبار پنل حالت‌دار است و در صفر شدن خودکار 418 می‌دهد؛ کلید invalid ← 403", async () => {
    await c.setCredit("kavenegar", 2);
    expect((await kn("sms/send.json?receptor=09120000000&message=a")).status).toBe(200);
    expect((await kn("sms/send.json?receptor=09120000000&message=b")).status).toBe(200);
    const r = await kn("sms/send.json?receptor=09120000000&message=c");
    expect(r.status).toBe(418);
    expect(((await r.json()) as { return: { status: number } }).return.status).toBe(418);
    expect((await kn("account/info.json", "INVALID-KEY")).status).toBe(403);
  });

  it("وضعیت تحویل و خطا با HTTP 200", async () => {
    await c.scenario("kavenegar", "delivery_failed");
    const sent = (await (await kn("sms/send.json?receptor=09120000000&message=x")).json()) as { entries: { messageid: number }[] };
    const st = (await (await kn(`sms/status.json?messageid=${sent.entries[0].messageid}`)).json()) as { entries: { status: number }[] };
    expect(st.entries[0].status).toBe(6);
    await c.scenario("kavenegar", "http200_failure");
    const r = await kn("sms/send.json?receptor=09120000000&message=x");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { return: { status: number } }).return.status).toBe(418);
  });

  it("ملی‌پیامک: موفقیت با recId بلند و خطاها همیشه با HTTP 200", async () => {
    const send = (over: Record<string, unknown> = {}, hdr: Record<string, string> = {}) => post("/melipayamak/api/SendSMS/SendSMS", { username: "u", password: "p", to: "09120000000", from: "5000", text: "کد ۱۲۳۴", ...over }, hdr);
    const ok = (await (await send()).json()) as { Value: string; RetStatus: number };
    expect(ok.RetStatus).toBe(1);
    expect(ok.Value.length).toBeGreaterThanOrEqual(16);
    const bad = await send({}, { "x-sim-scenario": "insufficient_credit" });
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as { Value: string }).Value).toBe("2");
    expect(((await (await send({ password: "x~blacklisted" })).json()) as { Value: string }).Value).toBe("35");
  });
});

describe("شبیه‌ساز GapGPT", () => {
  const chat = (body: unknown, key = "sk-test", hdr: Record<string, string> = {}) => post("/gapgpt/v1/chat/completions", body, { authorization: `Bearer ${key}`, ...hdr });
  const msgs = [
    { role: "system", content: "متغیرها:\n[PARTY_A] = طرف اول\n[CITY] = شهر" },
    { role: "user", content: "یک قرارداد بنویس.\n\nتوضیحات کاربر:\nپشتیبانی سایت" },
  ];

  it("احراز هویت، اعتبارسنجی بدنه و مدل ناموجود", async () => {
    expect((await fetch(`${sim.url}/gapgpt/v1/models`)).status).toBe(401);
    expect((await chat({ model: "gpt-4o", messages: msgs }, "sk-INVALID-key")).status).toBe(401);
    expect((await chat({ model: "gpt-4o", messages: [] })).status).toBe(400);
    expect((await chat({ model: "nonexistent-1", messages: msgs })).status).toBe(404);
  });

  it("پاسخ هوشمند: قرارداد با متغیرهای پرامپت، تحلیل ریسک JSON و SSE", async () => {
    const r = (await (await chat({ model: "gpt-4o", messages: msgs })).json()) as { choices: { message: { content: string } }[]; usage: { total_tokens: number } };
    expect(r.choices[0].message.content).toContain("[PARTY_A]");
    expect(r.choices[0].message.content).toContain("پشتیبانی سایت");
    expect(r.usage.total_tokens).toBeGreaterThan(0);

    const risk = (await (await chat({ model: "gpt-4o", messages: [{ role: "user", content: "<<<CONTRACT\nمتن\nCONTRACT>>>" }] })).json()) as { choices: { message: { content: string } }[] };
    expect(JSON.parse(risk.choices[0].message.content).findings.length).toBeGreaterThan(0);

    const sse = await (await chat({ model: "gpt-4o", messages: msgs, stream: true })).text();
    expect(sse).toContain("data: [DONE]");
  });

  it("سقف درخواست در دقیقه (rpm:2) به‌ازای هر کلید", async () => {
    await c.scenario("gapgpt", "rpm:2");
    const body = { model: "gpt-4o", messages: msgs };
    const statuses = [(await chat(body, "kA")).status, (await chat(body, "kA")).status, (await chat(body, "kA")).status];
    expect(statuses).toEqual([200, 200, 429]);
    expect((await chat(body, "kB")).status).toBe(200);
  });
});

describe("موتور سناریو", () => {
  const ping = (hdr: Record<string, string> = {}, key = "KEY12345678") => fetch(`${sim.url}/kavenegar/v1/${key}/account/info.json`, { headers: hdr });

  it("اولویت: هدر ← کلید جادویی ← صف ← پیش‌فرض", async () => {
    await c.scenario("kavenegar", "service_down");
    expect((await ping()).status).toBe(503); // پیش‌فرض
    await c.queue("kavenegar", ["invalid_api_key"]);
    expect((await ping()).status).toBe(403); // صف بر پیش‌فرض می‌چربد
    expect((await ping()).status).toBe(503); // صف مصرف شد
    expect((await ping({}, "KEY12345678~rate_limited")).status).toBe(451); // کلید جادویی
    expect((await ping({ "x-sim-scenario": "success" }, "KEY12345678~rate_limited")).status).toBe(200); // هدر از همه قوی‌تر
  });

  it("سناریوی فاز-محدود فقط روی همان فاز اثر دارد و صف از فازهای نامربوط عبور می‌کند", async () => {
    await c.queue("zarinpal", ["verify@service_down"]);
    const first = await zpReq();
    expect(first.status).toBe(200); // request دست‌نخورده و آیتم صف مصرف نشد
    const a = ((await first.json()) as { data: { authority: string } }).data.authority;
    expect((await zpVerify(a)).status).toBe(503);
    expect((await c.state()).services.zarinpal.queue).toHaveLength(0);
  });

  it("chaos با seed ثابت کاملاً تکرارپذیر است و nth هر N‌امین درخواست را خراب می‌کند", async () => {
    const run = async (seed: number) => {
      const s = await startSimulator({ port: 0, quiet: true, seed });
      try {
        const cl = new SimClient(s.url);
        await cl.scenario("kavenegar", "chaos:50");
        const out: number[] = [];
        for (let i = 0; i < 25; i++) out.push(await fetch(`${s.url}/kavenegar/v1/K12345678/account/info.json`).then((r) => r.status, () => 0));
        return out;
      } finally {
        await s.close();
      }
    };
    const a = await run(11);
    expect(await run(11)).toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(1); // هم موفق هم خطا
    await c.scenario("kavenegar", "nth:3");
    const seq: number[] = [];
    for (let i = 0; i < 6; i++) seq.push((await ping()).status);
    expect(seq).toEqual([200, 200, 503, 200, 200, 503]);
  });

  it("خطاهای شبکه: قطع اتصال، پاسخ ناقص، غیر JSON، کندی و ریدایرکت", async () => {
    await expect(ping({ "x-sim-scenario": "network_error" })).rejects.toThrow();
    await expect(ping({ "x-sim-scenario": "timeout:200" })).rejects.toThrow();
    await expect(ping({ "x-sim-scenario": "truncated_response" }).then((r) => r.json())).rejects.toThrow();
    const g = await ping({ "x-sim-scenario": "garbage_response" });
    expect(g.headers.get("content-type")).toContain("text/html");
    const t0 = Date.now();
    expect((await ping({ "x-sim-scenario": "slow:300" })).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect((await fetch(`${sim.url}/kavenegar/v1/K12345678/account/info.json`, { headers: { "x-sim-scenario": "redirect" }, redirect: "manual" })).status).toBe(302);
  });

  it("درخواست‌ها (با وضعیت، سناریو و توضیح) لاگ می‌شوند و فیلتر since/phase کار می‌کند", async () => {
    await ping();
    const mark = await c.mark();
    await ping({ "x-sim-scenario": "invalid_api_key" });
    await ping({ "x-sim-scenario": "network_error" }).catch(() => undefined);
    const rows = await c.waitFor(async () => {
      const r = await c.requests({ service: "kavenegar", since: mark });
      return r.length === 2 && r[1].note ? r : null;
    });
    expect(rows.map((r) => r.status)).toEqual([403, 0]);
    expect(rows[0].scenario).toBe("invalid_api_key");
    expect(rows[1].note).toBe("connection dropped");
    expect((await c.requests({ phase: "account" })).length).toBe(3);
  });
});

describe("پنل کنترل", () => {
  it("سناریوی ناشناخته، سرویس ناشناخته و مسیر ناشناخته با پیام روشن رد می‌شوند", async () => {
    await expect(c.scenario("zarinpal", "no_such_thing")).rejects.toThrow(/وجود ندارد/);
    await expect(c.preset("nope")).rejects.toThrow(/پیش‌تنظیم/);
    expect((await fetch(`${sim.url}/__sim/scenario/foo`, { method: "PUT", headers: j, body: "{}" })).status).toBe(400);
    expect((await fetch(`${sim.url}/zarinpal/nothing`)).status).toBe(404);
  });

  it("پیش‌تنظیم‌ها، ریست یک سرویس و محافظت با توکن", async () => {
    await c.preset("total-outage");
    expect((await c.state()).services.gapgpt.scenario).toBe("service_down");
    await c.preset("happy");
    expect((await c.state()).services.gapgpt.scenario).toBe("success");

    await c.setCredit("kavenegar", 3);
    await c.reset("kavenegar");
    expect((await c.state()).credit.kavenegar).toBe(1000);

    const locked = await startSimulator({ port: 0, quiet: true, token: "s3cret" });
    try {
      expect((await fetch(`${locked.url}/__sim/state`)).status).toBe(401);
      expect(await new SimClient(locked.url, "s3cret").state()).toHaveProperty("services");
      expect((await fetch(`${locked.url}/__sim/health`)).status).toBe(200);
      expect((await fetch(`${locked.url}/__sim/ui`)).status).toBe(200);
    } finally {
      await locked.close();
    }
  });
});
