/**
 * شبیه‌ساز درگاه پرداخت زرین‌پال (API نسخه‌ی v4) به‌همراه صفحه‌ی پرداخت (StartPay).
 * مسیرها: POST /zarinpal/pg/v4/payment/{request|verify|unVerified}.json  و  GET /zarinpal/pg/StartPay/:authority
 * رفتار «حالت‌دار» است: تراکنش واقعاً ساخته می‌شود، مبلغ و مرچنت در verify با درخواست اولیه مقایسه می‌شود،
 * verify تکراری کد ۱۰۱ می‌دهد و تراکنشِ پرداخت‌نشده هرگز verify نمی‌شود.
 */
import { randomInt } from "node:crypto";
import { escapeHtml, redirectTo, sendHtml, sendJson, str } from "./core";
import type { Ctx, Payment, Route, ScenarioInfo, ServiceModule, SimState } from "./core";

const UUID = /^[0-9a-fA-F-]{36}$/;
const E = {
  validation: [-9, "Validation error"],
  terminal: [-10, "Terminal is not valid, please check merchant_id or ip address."],
  inactive: [-11, "Terminal is not active, please contact our support team."],
  tooMany: [-12, "Too many attempts, please try again later."],
  suspended: [-15, "Terminal user is suspend : (please contact our support team)."],
  amountMismatch: [-50, "Session is not valid, amounts values is not the same."],
  notPaid: [-51, "Session is not valid, session is not active paid try."],
  wrongMerchant: [-53, "Session is not this merchant_id session"],
  badAuthority: [-54, "Invalid authority."],
} as const satisfies Record<string, readonly [number, string]>;

function fail(ctx: Ctx, e: readonly [number, string], validations: unknown[] = [], httpStatus = 200) {
  ctx.note = `error ${e[0]}`;
  sendJson(ctx, httpStatus, { data: [], errors: { code: e[0], message: e[1], validations } });
}

const scenarios: ScenarioInfo[] = [
  { id: "success", title: "موفقیت", description: "رفتار عادی و کامل درگاه.", group: "success" },
  { id: "invalid_merchant", title: "مرچنت نامعتبر (-9)", description: "خطای اعتبارسنجی merchant_id در مرحله‌ی request.", group: "error", phases: ["request"] },
  { id: "merchant_inactive", title: "پذیرنده غیرفعال (-11)", description: "ترمینال غیرفعال است.", group: "error", phases: ["request"] },
  { id: "ip_blocked", title: "IP یا مرچنت نامعتبر (-10)", description: "آی‌پی سرور در فهرست مجاز نیست.", group: "error", phases: ["request"] },
  { id: "too_many_requests", title: "تعداد تلاش بیش از حد (-12)", description: "محدودیت نرخ درگاه.", group: "error", phases: ["request"] },
  { id: "terminal_suspended", title: "ترمینال تعلیق‌شده (-15)", description: "حساب پذیرنده تعلیق شده است.", group: "error", phases: ["request"] },
  { id: "authority_malformed", title: "Authority نامعتبر در پاسخ", description: "درگاه code=100 ولی authority خراب (حاوی نویسه‌ی غیرمجاز) می‌دهد؛ برنامه باید رد کند.", group: "error", phases: ["request"] },
  { id: "user_cancel", title: "انصراف کاربر", description: "کاربر در صفحه‌ی پرداخت انصراف می‌دهد (بازگشت با Status=NOK).", group: "error", phases: ["startpay"] },
  { id: "bank_failure", title: "خطای بانک", description: "پرداخت در بانک ناموفق می‌شود (Status=NOK).", group: "error", phases: ["startpay"] },
  { id: "fake_ok_unpaid", title: "حمله: Status=OK بدون پرداخت", description: "کاربر بدون پرداخت با Status=OK برمی‌گردد؛ verify باید رد شود و اشتراک نباید فعال شود.", group: "error", phases: ["startpay"] },
  { id: "callback_dropped", title: "پرداخت شد ولی بازگشت به سایت نشد", description: "پول کسر می‌شود ولی کاربر هرگز به callback برنمی‌گردد (تب بسته شد).", group: "error", phases: ["startpay"] },
  { id: "verify_not_paid", title: "تایید: پرداخت‌نشده (-51)", description: "verify می‌گوید تراکنش پرداخت نشده است.", group: "error", phases: ["verify"] },
  { id: "amount_mismatch", title: "تایید: مبلغ ناهمخوان (-50)", description: "مبلغ verify با مبلغ تراکنش یکی نیست.", group: "error", phases: ["verify"] },
  { id: "session_invalid", title: "تایید: Authority نامعتبر (-54)", description: "تراکنش در درگاه پیدا نمی‌شود.", group: "error", phases: ["verify"] },
  { id: "already_verified", title: "تایید: قبلاً تایید شده (101)", description: "پاسخ ۱۰۱ (تایید تکراری) که باید موفق تلقی شود.", group: "success", phases: ["verify"] },
  { id: "merchant_inactive_on_verify", title: "تایید: خطای پیکربندی مرچنت (-11)", description: "در verify ترمینال غیرفعال است (خطای غیرقطعی؛ تراکنش نباید «ناموفق» شود).", group: "error", phases: ["verify"] },
];

const faults = ["invalid_merchant", "merchant_inactive", "ip_blocked", "too_many_requests", "terminal_suspended", "user_cancel", "bank_failure", "verify_not_paid", "amount_mismatch", "session_invalid"] as const;

function newAuthority(sim: SimState): string {
  // مثل زرین‌پال: «A» + ۳۵ رقم. زمان + شمارنده + بخش تصادفی ← حتی بعد از reset یا ری‌استارت شبیه‌ساز هرگز تکراری نمی‌شود
  // (برنامه Authority را unique ذخیره می‌کند و تکرار آن دیتابیس را به تداخل می‌کشاند)
  const rnd = String(randomInt(0, 100_000_000)).padStart(8, "0") + String(randomInt(0, 100_000_000)).padStart(8, "0");
  return "A" + String(Date.now()).padStart(13, "0") + String(sim.counter("authority") % 1_000_000).padStart(6, "0") + rnd;
}

async function request(ctx: Ctx) {
  const b = ctx.params;
  const sc = ctx.scenario;
  if (sc === "invalid_merchant") return fail(ctx, E.validation, [{ merchant_id: "The merchant id must be a valid uuid." }], 400);
  if (sc === "merchant_inactive") return fail(ctx, E.inactive);
  if (sc === "ip_blocked") return fail(ctx, E.terminal);
  if (sc === "too_many_requests") return fail(ctx, E.tooMany);
  if (sc === "terminal_suspended") return fail(ctx, E.suspended);

  const validations: Record<string, string>[] = [];
  const merchant = str(b.merchant_id);
  const amount = Number(b.amount);
  const cb = str(b.callback_url);
  if (!UUID.test(merchant)) validations.push({ merchant_id: "The merchant id must be a valid uuid." });
  if (!Number.isInteger(amount) || amount < 1000) validations.push({ amount: "The amount must be at least 1000 IRR." });
  if (amount > 1_000_000_000_0) validations.push({ amount: "The amount may not be greater than 1000000000 Toman." });
  try {
    const u = new URL(cb);
    if (!/^https?:$/.test(u.protocol)) throw new Error("scheme");
  } catch {
    validations.push({ callback_url: "The callback url must be a valid url." });
  }
  if (!str(b.description).trim()) validations.push({ description: "The description field is required." });
  if (validations.length) return fail(ctx, E.validation, validations, 400);

  const authority = sc === "authority_malformed" ? "../../etc/passwd'--" : newAuthority(ctx.sim);
  if (sc !== "authority_malformed") {
    const p: Payment = { authority, merchantId: merchant, amount, callbackUrl: cb, description: str(b.description), status: "pending", createdAt: new Date().toISOString(), verifyCalls: 0 };
    ctx.sim.payments.set(authority, p);
  }
  ctx.note = `authority ${authority} amount ${amount} IRR`;
  sendJson(ctx, 200, { data: { code: 100, message: "Success", authority, fee_type: "Merchant", fee: Math.round(amount * 0.01) }, errors: [] });
}

async function verify(ctx: Ctx) {
  const b = ctx.params;
  const sc = ctx.scenario;
  if (sc === "verify_not_paid") return fail(ctx, E.notPaid);
  if (sc === "amount_mismatch") return fail(ctx, E.amountMismatch);
  if (sc === "session_invalid") return fail(ctx, E.badAuthority);
  if (sc === "merchant_inactive_on_verify") return fail(ctx, E.inactive);

  const merchant = str(b.merchant_id);
  const authority = str(b.authority);
  if (!UUID.test(merchant)) return fail(ctx, E.validation, [{ merchant_id: "The merchant id must be a valid uuid." }], 400);
  if (!authority) return fail(ctx, E.validation, [{ authority: "The authority field is required." }], 400);
  const p = ctx.sim.payments.get(authority);
  if (!p) return fail(ctx, E.badAuthority);
  p.verifyCalls++;
  if (p.merchantId !== merchant) return fail(ctx, E.wrongMerchant);
  if (p.amount !== Number(b.amount)) return fail(ctx, E.amountMismatch);

  const body = (code: number, message: string) => ({
    data: { code, message, card_hash: "1EBE3EBEBE35C7EC0F8D6EE4F2F859107A87822CA179BC9528767EA7B5489B69", card_pan: p.cardPan ?? "603799******7799", ref_id: p.refId, fee_type: "Merchant", fee: Math.round(p.amount * 0.01), shaparak_fee: "1200", order_id: null },
    errors: [],
  });
  if (p.verifiedAt || sc === "already_verified") {
    p.refId ??= 200000 + ctx.sim.counter("refid");
    ctx.note = `already verified ref ${p.refId}`;
    return sendJson(ctx, 200, body(101, "Verified"));
  }
  if (p.status !== "paid") return fail(ctx, E.notPaid);
  p.verifiedAt = new Date().toISOString();
  p.refId = 200000 + ctx.sim.counter("refid");
  ctx.note = `verified ref ${p.refId}`;
  sendJson(ctx, 200, body(100, "Paid"));
}

async function unVerified(ctx: Ctx) {
  const list = [...ctx.sim.payments.values()].filter((p) => p.status === "paid" && !p.verifiedAt).map((p) => ({ authority: p.authority, amount: p.amount, callback_url: p.callbackUrl, referer: "", date: p.paidAt }));
  sendJson(ctx, 200, { data: { code: 100, message: "Success", authorities: list }, errors: [] });
}

/** نهایی‌کردن تراکنش و ساخت آدرس بازگشت به callback برنامه (مثل مرورگر کاربر) */
export function settlePayment(p: Payment, outcome: "success" | "cancel" | "fail" | "fake_ok"): string {
  if (outcome === "success" && p.status === "pending") {
    p.status = "paid";
    p.paidAt = new Date().toISOString();
    p.cardPan = "603799******7799";
  } else if (outcome === "cancel" && p.status === "pending") p.status = "canceled";
  else if (outcome === "fail" && p.status === "pending") p.status = "failed";
  const ok = p.status === "paid" || outcome === "fake_ok";
  const sep = p.callbackUrl.includes("?") ? "&" : "?";
  return `${p.callbackUrl}${sep}Authority=${encodeURIComponent(p.authority)}&Status=${ok ? "OK" : "NOK"}`;
}

const fmt = (n: number) => new Intl.NumberFormat("fa-IR").format(n);

function payPage(p: Payment, base: string): string {
  const action = `${base}/pg/StartPay/${encodeURIComponent(p.authority)}/decide`;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>درگاه پرداخت شبیه‌ساز</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f4f6;font-family:Tahoma,system-ui,sans-serif;padding:16px}
.card{width:100%;max-width:420px;background:#fff;border-radius:20px;box-shadow:0 10px 40px #0002;overflow:hidden}
.top{background:#fdc500;padding:18px 20px;font-weight:800}.top small{display:block;font-weight:400;opacity:.8;margin-top:4px}
.body{padding:20px;display:grid;gap:12px}.row{display:flex;justify-content:space-between;gap:12px;font-size:14px;border-bottom:1px dashed #e5e7eb;padding-bottom:8px;word-break:break-all}
.row b{white-space:nowrap}button{width:100%;min-height:46px;border:0;border-radius:12px;font:inherit;font-weight:700;cursor:pointer}
.ok{background:#16a34a;color:#fff}.no{background:#e5e7eb}.bad{background:#fee2e2;color:#b91c1c}.note{font-size:12px;color:#6b7280;text-align:center}</style></head>
<body><main class="card"><div class="top">درگاه پرداخت (شبیه‌ساز زرین‌پال)<small>این صفحه آزمایشی است؛ هیچ پولی جابه‌جا نمی‌شود</small></div>
<form class="body" method="post" action="${escapeHtml(action)}">
<div class="row"><span>مبلغ</span><b data-sim="amount">${fmt(Math.round(p.amount / 10))} تومان</b></div>
<div class="row"><span>شرح</span><b>${escapeHtml(p.description)}</b></div>
<div class="row"><span>شناسه‌ی تراکنش</span><b dir="ltr" data-sim="authority">${escapeHtml(p.authority)}</b></div>
<button class="ok" name="outcome" value="success" data-sim-action="success">پرداخت موفق</button>
<button class="bad" name="outcome" value="fail" data-sim-action="fail">پرداخت ناموفق (خطای بانک)</button>
<button class="no" name="outcome" value="cancel" data-sim-action="cancel">انصراف و بازگشت به سایت</button>
<p class="note">پس از انتخاب، به آدرس بازگشت برنامه هدایت می‌شوید.</p></form></main></body></html>`;
}

const notFoundPage = `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><body style="font-family:Tahoma;padding:40px;text-align:center"><h2>تراکنش یافت نشد</h2><p>این شناسه در شبیه‌ساز وجود ندارد (شاید شبیه‌ساز ریست شده است).</p></body></html>`;

async function startPay(ctx: Ctx, authority: string) {
  const p = ctx.sim.payments.get(authority);
  if (!p) return sendHtml(ctx, 404, notFoundPage);
  const base = ctx.url.pathname.split("/pg/")[0];
  switch (ctx.scenario) {
    case "user_cancel":
      ctx.note = "user canceled";
      return redirectTo(ctx, settlePayment(p, "cancel"));
    case "bank_failure":
      ctx.note = "bank failure";
      return redirectTo(ctx, settlePayment(p, "fail"));
    case "fake_ok_unpaid":
      ctx.note = "fake OK without payment";
      return redirectTo(ctx, settlePayment(p, "fake_ok"));
    case "callback_dropped": {
      settlePayment(p, "success");
      ctx.note = "paid; user never returned";
      return sendHtml(ctx, 200, `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><body style="font-family:Tahoma;padding:40px;text-align:center"><h2>پرداخت انجام شد</h2><p>(شبیه‌ساز: بازگشت خودکار به سایت قطع شده است)</p></body></html>`);
    }
    default:
      if (ctx.sim.settings.startPay === "auto" || ctx.url.searchParams.get("auto") === "1") {
        ctx.note = "auto-paid";
        return redirectTo(ctx, settlePayment(p, "success"));
      }
      return sendHtml(ctx, 200, payPage(p, base));
  }
}

async function decide(ctx: Ctx, authority: string) {
  const p = ctx.sim.payments.get(authority);
  if (!p) return sendHtml(ctx, 404, notFoundPage);
  const o = str(ctx.params.outcome);
  const outcome = o === "success" ? "success" : o === "fail" ? "fail" : "cancel";
  ctx.note = `user chose ${outcome}`;
  redirectTo(ctx, settlePayment(p, outcome), 303);
}

export const zarinpal: ServiceModule = {
  id: "zarinpal",
  scenarios,
  faults,
  route(method, path): Route | null {
    const p = path.replace(/^\/zarinpal/, "");
    if (method === "POST" && p === "/pg/v4/payment/request.json") return { phase: "request", run: request };
    if (method === "POST" && p === "/pg/v4/payment/verify.json") return { phase: "verify", run: verify };
    if ((method === "POST" || method === "GET") && p === "/pg/v4/payment/unVerified.json") return { phase: "unverified", run: unVerified };
    let m = /^\/pg\/StartPay\/([^/]+)$/.exec(p);
    if (method === "GET" && m) return { phase: "startpay", run: (ctx) => startPay(ctx, decodeURIComponent(m![1])) };
    m = /^\/pg\/StartPay\/([^/]+)\/decide$/.exec(p);
    if (method === "POST" && m) return { phase: "decide", raw: true, run: (ctx) => decide(ctx, decodeURIComponent(m![1])) };
    return null;
  },
};
