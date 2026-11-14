/**
 * شبیه‌ساز پنل پیامک کاوه‌نگار (REST v1).
 * مسیرها: /kavenegar/v1/:apiKey/sms/send.json ، /verify/lookup.json ، /sms/status.json ، /account/info.json
 * حالت‌دار: اعتبار پنل کم می‌شود و در صفر شدن خودکار خطای ۴۱۸ می‌دهد؛ هر پیامک در «صندوق پیامک» (/__sim/sms) ذخیره می‌شود
 * تا ربات تست کد OTP را مثل یک گوشی واقعی از آن بخواند.
 * کلید با نام شامل «invalid» ← خطای ۴۰۳. «کلید جادویی»: KEY~insufficient_credit
 */
import { sendJson, splitMagic, str } from "./core";
import type { Ctx, Route, ScenarioInfo, ServiceModule, SmsRecord } from "./core";

const MESSAGES: Record<number, string> = {
  200: "تایید شد",
  400: "پارامترها ناقص هستند",
  401: "حساب کاربری غیرفعال شده است",
  403: "کد شناسائی API-Key معتبر نمی‌باشد",
  405: "متد نامعتبر",
  407: "دسترسی به خط مورد نظر برای شما مقدور نیست",
  411: "گیرنده نامعتبر است",
  412: "ارسال کننده نامعتبر است",
  413: "پیام خالی است و یا طول پیام بیش از حد مجاز می‌باشد",
  416: "آی‌پی سرویس مجاز نیست",
  418: "اعتبار شما کافی نمی‌باشد",
  424: "الگوی مورد نظر پیدا نشد",
  431: "ساختار کد صحیح نمی‌باشد",
  432: "پارامتر کد در متن پیام پیدا نشد",
  451: "تعداد درخواست بیش از حد مجاز است",
  501: "حساب آزمایشی فقط به شماره‌ی صاحب حساب می‌تواند پیامک ارسال کند",
};

function error(ctx: Ctx, status: number, httpStatus = status) {
  ctx.note = `error ${status}`;
  sendJson(ctx, httpStatus, { return: { status, message: MESSAGES[status] ?? "خطا" } });
}

const scenarios: ScenarioInfo[] = [
  { id: "success", title: "موفقیت", description: "رفتار عادی و کامل پنل.", group: "success" },
  { id: "invalid_api_key", title: "کلید API نامعتبر (403)", description: "کد شناسایی API-Key معتبر نیست.", group: "error" },
  { id: "account_disabled", title: "حساب غیرفعال (401)", description: "حساب کاربری کاوه‌نگار غیرفعال شده است.", group: "error" },
  { id: "insufficient_credit", title: "کمبود اعتبار (418)", description: "اعتبار پنل کافی نیست.", group: "error" },
  { id: "invalid_receptor", title: "گیرنده نامعتبر (411)", description: "شماره‌ی گیرنده نامعتبر است.", group: "error" },
  { id: "invalid_sender", title: "فرستنده نامعتبر (412)", description: "شماره‌ی خط ارسال‌کننده معتبر نیست.", group: "error", phases: ["send"] },
  { id: "line_denied", title: "دسترسی به خط ممنوع (407)", description: "دسترسی به خط مورد نظر مقدور نیست.", group: "error", phases: ["send"] },
  { id: "template_not_found", title: "الگو (template) پیدا نشد (424)", description: "قالب تأییدیه در حساب تعریف نشده است.", group: "error", phases: ["lookup"] },
  { id: "template_bad_structure", title: "ساختار الگو نادرست (431)", description: "ساختار کد در قالب صحیح نیست.", group: "error", phases: ["lookup"] },
  { id: "ip_not_allowed", title: "IP مجاز نیست (416)", description: "آی‌پی سرور در فهرست مجاز حساب نیست.", group: "error" },
  { id: "rate_limited", title: "محدودیت نرخ (451)", description: "تعداد درخواست بیش از حد مجاز است.", group: "error" },
  { id: "test_account_limit", title: "محدودیت حساب آزمایشی (501)", description: "حساب آزمایشی فقط به شماره‌ی صاحب حساب می‌فرستد.", group: "error" },
  { id: "http200_failure", title: "خطا با HTTP 200", description: "کد HTTP برابر ۲۰۰ ولی return.status=418؛ برنامه نباید فقط به کد HTTP تکیه کند.", group: "error" },
  { id: "delivery_failed", title: "ارسال موفق ولی نرسیدن به گوشی", description: "API موفق است ولی وضعیت تحویل (status.json) «نرسیده» می‌شود و در صندوق پیامک delivery=failed است.", group: "error" },
];
const faults = ["invalid_api_key", "account_disabled", "insufficient_credit", "invalid_receptor", "ip_not_allowed", "rate_limited", "http200_failure"] as const;

const FAULT_STATUS: Record<string, number> = {
  invalid_api_key: 403,
  account_disabled: 401,
  insufficient_credit: 418,
  invalid_receptor: 411,
  invalid_sender: 412,
  line_denied: 407,
  template_not_found: 424,
  template_bad_structure: 431,
  ip_not_allowed: 416,
  rate_limited: 451,
  test_account_limit: 501,
};

const RECEPTOR = /^(09\d{9}|\+?989\d{9}|00989\d{9})$/;

function keyOf(ctx: Ctx): string {
  return decodeURIComponent(/^\/kavenegar\/v1\/([^/]+)\//.exec(ctx.url.pathname)?.[1] ?? "");
}

/** بررسی‌های مشترک: خطای سناریو، کلید، اعتبار. اگر پاسخ خطا داده شد true برمی‌گرداند */
function precheck(ctx: Ctx): boolean {
  const { key } = splitMagic(keyOf(ctx));
  if (ctx.scenario === "http200_failure") {
    error(ctx, 418, 200);
    return true;
  }
  const forced = FAULT_STATUS[ctx.scenario];
  if (forced) {
    // خطاهای مخصوص هر فاز فقط وقتی اعمال می‌شوند که سناریو برای همان فاز باشد (در غیر این صورت عمومی‌اند)
    const info = scenarios.find((s) => s.id === ctx.scenario);
    if (!info?.phases || info.phases.includes(ctx.phase)) {
      error(ctx, forced);
      return true;
    }
  }
  if (!key || /invalid/i.test(key)) {
    error(ctx, 403);
    return true;
  }
  return false;
}

function codeOf(text: string, token?: string): string | undefined {
  return token || /\d{4,8}/.exec(text)?.[0];
}

function entry(r: SmsRecord) {
  return { messageid: r.messageId, message: r.text, status: 5, statustext: "ارسال شد به مخابرات", sender: r.sender, receptor: r.to, date: Math.floor(Date.parse(r.at) / 1000), cost: 1 };
}

function store(ctx: Ctx, kind: SmsRecord["kind"], to: string, text: string, extra: Partial<SmsRecord>): SmsRecord {
  const rec: SmsRecord = {
    id: ctx.sim.nextId(),
    messageId: 3_000_000 + ctx.sim.counter("kavenegar-msg"),
    provider: "kavenegar",
    kind,
    to,
    text,
    sender: "10004346",
    at: new Date().toISOString(),
    delivery: ctx.scenario === "delivery_failed" ? "failed" : "delivered",
    code: codeOf(text, extra.token),
    ...extra,
  };
  ctx.sim.sms.push(rec);
  ctx.sim.kavenegarCredit -= 1;
  ctx.note = `${kind} → ${to}${rec.code ? ` (code ${rec.code})` : ""}`;
  return rec;
}

async function send(ctx: Ctx) {
  if (precheck(ctx)) return;
  const to = str(ctx.params.receptor).trim();
  const text = str(ctx.params.message);
  if (!to) return error(ctx, 400);
  if (!to.split(",").every((r) => RECEPTOR.test(r.trim()))) return error(ctx, 411);
  if (!text.trim() || text.length > 1000) return error(ctx, 413);
  if (ctx.sim.kavenegarCredit <= 0) return error(ctx, 418);
  const rec = store(ctx, "send", to, text, {});
  sendJson(ctx, 200, { return: { status: 200, message: MESSAGES[200] }, entries: [entry(rec)] });
}

async function lookup(ctx: Ctx) {
  if (precheck(ctx)) return;
  const to = str(ctx.params.receptor).trim();
  const template = str(ctx.params.template).trim();
  const tokens = [ctx.params.token, ctx.params.token2, ctx.params.token3].map(str).filter(Boolean);
  if (!to || !template || tokens.length === 0) return error(ctx, 400);
  if (!RECEPTOR.test(to)) return error(ctx, 411);
  if (ctx.sim.kavenegarTemplates.length && !ctx.sim.kavenegarTemplates.includes(template)) return error(ctx, 424);
  // توکن نباید فاصله داشته باشد (قانون واقعی کاوه‌نگار)
  if (tokens.some((t) => /\s/.test(t) || t.length > 100)) return error(ctx, 432);
  if (ctx.sim.kavenegarCredit <= 0) return error(ctx, 418);
  const text = `[قالب ${template}] کد تایید: ${tokens[0]}`;
  const rec = store(ctx, "lookup", to, text, { token: tokens[0], template });
  sendJson(ctx, 200, { return: { status: 200, message: MESSAGES[200] }, entries: [entry(rec)] });
}

async function status(ctx: Ctx) {
  if (precheck(ctx)) return;
  const ids = str(ctx.params.messageid).split(",").map((s) => Number(s.trim())).filter(Boolean);
  const entries = ids.map((id) => {
    const r = ctx.sim.sms.find((s) => s.messageId === id);
    return r ? { messageid: id, status: r.delivery === "delivered" ? 10 : 6, statustext: r.delivery === "delivered" ? "رسیده به گوشی" : "نرسیده به گوشی" } : { messageid: id, status: 100, statustext: "شناسه‌ی پیامک نامعتبر است" };
  });
  sendJson(ctx, 200, { return: { status: 200, message: MESSAGES[200] }, entries });
}

async function account(ctx: Ctx) {
  if (precheck(ctx)) return;
  sendJson(ctx, 200, { return: { status: 200, message: MESSAGES[200] }, entries: { remaincredit: Math.max(0, ctx.sim.kavenegarCredit) * 100, expiredate: Math.floor(Date.now() / 1000) + 86400 * 300, type: "master" } });
}

export const kavenegar: ServiceModule = {
  id: "kavenegar",
  scenarios,
  faults,
  route(method, path): Route | null {
    const m = /^\/kavenegar\/v1\/([^/]+)\/(sms\/send|verify\/lookup|sms\/status|account\/info)\.json$/.exec(path);
    if (!m || (method !== "GET" && method !== "POST")) return null;
    const credential = (ctx: Ctx) => keyOf(ctx);
    const table: Record<string, Route> = {
      "sms/send": { phase: "send", run: send, credential },
      "verify/lookup": { phase: "lookup", run: lookup, credential },
      "sms/status": { phase: "status", run: status, credential },
      "account/info": { phase: "account", run: account, credential },
    };
    return table[m[2]] ?? null;
  },
};
