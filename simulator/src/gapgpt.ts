/**
 * شبیه‌ساز GapGPT (و هر سرویس سازگار با OpenAI): GET /gapgpt/v1/models ، POST /gapgpt/v1/chat/completions
 * پاسخ «هوشمند» است: بسته به پرامپت، قرارداد HTML، بازنویسی متن یا تحلیل ریسک JSON تولید می‌کند
 * (متغیرهای [KEY] را از پرامپت سیستمی استخراج و در متن قرارداد استفاده می‌کند).
 * «کلید جادویی»: SIMKEY~rate_limit — کلید دارای «invalid» ← ۴۰۱.
 */
import { sendJson, sendText, sleep, splitMagic, str } from "./core";
import type { Ctx, Route, ScenarioInfo, ServiceModule } from "./core";

const MODELS = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini", "claude-3-5-sonnet-latest", "gemini-2.5-flash", "deepseek-chat"];

const scenarios: ScenarioInfo[] = [
  { id: "success", title: "موفقیت", description: "پاسخ کامل و درست (قرارداد HTML / بازنویسی / تحلیل ریسک JSON).", group: "success" },
  { id: "invalid_key", title: "کلید نامعتبر (401)", description: "Incorrect API key provided.", group: "error" },
  { id: "forbidden", title: "دسترسی ممنوع (403)", description: "کلید به این مدل/منطقه دسترسی ندارد.", group: "error" },
  { id: "rate_limit", title: "محدودیت نرخ (429)", description: "Rate limit reached + هدر Retry-After.", group: "error" },
  { id: "quota_exceeded", title: "اتمام اعتبار (429 insufficient_quota)", description: "موجودی حساب هوش مصنوعی تمام شده است.", group: "error" },
  { id: "server_error", title: "خطای داخلی (500)", description: "The server had an error while processing your request.", group: "error" },
  { id: "overloaded", title: "سرور شلوغ (503)", description: "مدل در حال حاضر بیش از حد شلوغ است.", group: "error" },
  { id: "model_not_found", title: "مدل پیدا نشد (404)", description: "The model does not exist.", group: "error", phases: ["chat"] },
  { id: "context_length", title: "متن بیش از حد طولانی (400)", description: "context_length_exceeded.", group: "error", phases: ["chat"] },
  { id: "bad_request", title: "درخواست نامعتبر (400)", description: "invalid_request_error عمومی.", group: "error", phases: ["chat"] },
  { id: "empty_content", title: "محتوای خالی", description: "HTTP 200 ولی content = رشته‌ی خالی.", group: "error", phases: ["chat"] },
  { id: "null_content", title: "محتوای null", description: "content=null (مثل فراخوانی ابزار).", group: "error", phases: ["chat"] },
  { id: "no_choices", title: "بدون choices", description: "آرایه‌ی choices خالی است.", group: "error", phases: ["chat"] },
  { id: "content_filter", title: "مسدود شده توسط فیلتر محتوا", description: "finish_reason=content_filter و متن خالی.", group: "error", phases: ["chat"] },
  { id: "short_reply", title: "پاسخ بسیار کوتاه", description: "مدل فقط «باشه» می‌گوید (کمتر از حداقل طول مفید).", group: "error", phases: ["chat"] },
  { id: "markdown_fenced", title: "پاسخ داخل ```html", description: "مدل خروجی را داخل حصار markdown می‌گذارد (برنامه باید پاک کند).", group: "success", phases: ["chat"] },
  { id: "xss_payload", title: "خروجی مخرب (XSS)", description: "HTML حاوی script، onerror، javascript: و iframe؛ برنامه باید همه را پاک‌سازی کند.", group: "error", phases: ["chat"] },
  { id: "bad_json", title: "تحلیل ریسک: JSON خراب", description: "برای تحلیل ریسک، متن غیر JSON برمی‌گرداند.", group: "error", phases: ["chat"] },
  { id: "risk_wrapped_json", title: "تحلیل ریسک: JSON میان متن و ```", description: "JSON داخل توضیح اضافه و حصار کد.", group: "success", phases: ["chat"] },
  { id: "no_models_endpoint", title: "بدون endpoint مدل‌ها (404)", description: "سرویس /models ندارد؛ تست اتصال باید با یک چت کوتاه انجام شود.", group: "error", phases: ["models"] },
  { id: "models_empty", title: "فهرست مدل‌ها خالی", description: "data=[].", group: "error", phases: ["models"] },
  { id: "rpm", title: "سقف درخواست در دقیقه", description: "فقط N درخواست در دقیقه برای هر کلید، بقیه 429. مثال: rpm:2", group: "stateful", arg: "N", phases: ["chat"] },
];
const faults = ["invalid_key", "forbidden", "rate_limit", "quota_exceeded", "server_error", "overloaded", "model_not_found", "empty_content", "short_reply", "xss_payload", "bad_json"] as const;

function oaiError(ctx: Ctx, status: number, message: string, type: string, code: string | null = null, headers: Record<string, string> = {}) {
  ctx.note = `error ${status} ${code ?? type}`;
  sendJson(ctx, status, { error: { message, type, param: null, code } }, headers);
}

function bearer(ctx: Ctx): string {
  const h = ctx.req.headers.authorization ?? "";
  return /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() ?? "";
}

/** خطاهای مشترک هر دو فاز؛ اگر پاسخ داده شد true */
function precheck(ctx: Ctx): boolean {
  const { key } = splitMagic(bearer(ctx));
  switch (ctx.scenario) {
    case "invalid_key":
      oaiError(ctx, 401, "Incorrect API key provided. You can find your API key at https://api.gapgpt.app.", "invalid_request_error", "invalid_api_key");
      return true;
    case "forbidden":
      oaiError(ctx, 403, "Your API key does not have access to this resource.", "permission_error", "forbidden");
      return true;
    case "rate_limit":
      oaiError(ctx, 429, "Rate limit reached for requests. Please try again later.", "rate_limit_exceeded", "rate_limit_exceeded", { "Retry-After": "20" });
      return true;
    case "quota_exceeded":
      oaiError(ctx, 429, "You exceeded your current quota, please check your plan and billing details.", "insufficient_quota", "insufficient_quota");
      return true;
    case "server_error":
      oaiError(ctx, 500, "The server had an error while processing your request. Sorry about that!", "server_error");
      return true;
    case "overloaded":
      oaiError(ctx, 503, "The engine is currently overloaded, please try again later.", "server_error", "overloaded", { "Retry-After": "10" });
      return true;
  }
  if (!key || /invalid/i.test(key)) {
    oaiError(ctx, 401, key ? "Incorrect API key provided." : "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth.", "invalid_request_error", "invalid_api_key");
    return true;
  }
  return false;
}

async function models(ctx: Ctx) {
  if (precheck(ctx)) return;
  if (ctx.scenario === "no_models_endpoint") return oaiError(ctx, 404, "Not found: /models", "invalid_request_error", "not_found");
  const data = ctx.scenario === "models_empty" ? [] : MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "gapgpt" }));
  sendJson(ctx, 200, { object: "list", data });
}

/* ───────── تولید محتوا ───────── */

interface Msg {
  role?: string;
  content?: unknown;
}
const textOf = (m?: Msg) => (typeof m?.content === "string" ? m.content : "");

function varsFrom(system: string): string[] {
  return [...new Set([...system.matchAll(/\[([A-Za-z0-9_]{3,40})\]\s*=/g)].map((m) => m[1]))];
}

const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function contractHtml(system: string, prompt: string): string {
  const v = varsFrom(system);
  const pick = (re: RegExp, fallback: string) => `[${v.find((k) => re.test(k)) ?? fallback}]`;
  const subject = prompt.replace(/^[\s\S]*?توضیحات کاربر:\s*/, "").trim().slice(0, 200) || "خدمات مورد توافق";
  return `<h2 style="text-align:center">قرارداد (تولیدشده توسط شبیه‌ساز)</h2>
<p>این قرارداد در تاریخ ${pick(/DATE/i, "DATE")} فیمابین ${pick(/(PARTY_?A|OWNER|CREATOR|SENDER|COMPANY)/i, v[0] ?? "PARTY_A")} (کارفرما) و ${pick(/(PARTY_?B|SIGNER|CLIENT|RECIPIENT|NAME)/i, v[1] ?? "PARTY_B")} (پیمانکار) منعقد می‌شود.</p>
<h3>ماده ۱ — موضوع قرارداد</h3><p>موضوع: ${strip(subject)}</p>
<h3>ماده ۲ — مدت قرارداد</h3><p>مدت قرارداد از تاریخ امضا یک سال شمسی است و با توافق کتبی طرفین قابل تمدید است.</p>
<h3>ماده ۳ — مبلغ و نحوه پرداخت</h3><p>مبلغ قرارداد …… ریال است که به‌صورت ماهانه و حداکثر تا پنجم هر ماه پرداخت می‌شود.</p>
<h3>ماده ۴ — تعهدات طرفین</h3><ul><li>انجام دقیق و به‌موقع تعهدات مندرج در این قرارداد</li><li>حفظ محرمانگی اطلاعات طرف مقابل</li></ul>
<h3>ماده ۵ — فسخ و حل اختلاف</h3><p>هرگونه اختلاف ابتدا از راه مذاکره و در صورت عدم توافق از طریق مراجع صالح قضایی در ${pick(/CITY/i, "CITY")} حل‌وفصل می‌شود.</p>`;
}

function improveHtml(userMsg: string): string {
  const instruction = /دستور:\s*(.*)/.exec(userMsg)?.[1]?.trim() ?? "";
  const original = userMsg.split("متن فعلی:")[1]?.trim().slice(0, 600) ?? "";
  return `<h2 style="text-align:center">متن بازنویسی‌شده (شبیه‌ساز)</h2><p>دستور اعمال‌شده: ${strip(instruction) || "—"}</p><p>${original || "متن اصلی خالی بود."}</p><p>این متن توسط شبیه‌ساز بازنویسی و تکمیل شده و بندهای محرمانگی و فسخ به آن افزوده شده است.</p>`;
}

const RISK_JSON = {
  summary: "قرارداد در کل متعادل است ولی چند بند نیازمند بازبینی دقیق است: جریمه‌ی تاخیر یک‌طرفه و نبود سقف مسئولیت.",
  score: 58,
  findings: [
    { severity: "high", title: "نبود سقف مسئولیت", detail: "مسئولیت طرفین محدود نشده و می‌تواند خسارت نامحدود ایجاد کند.", suggestion: "سقف مسئولیت را برابر مبلغ قرارداد تعیین کنید.", quote: "هرگونه خسارت وارده بر عهده‌ی پیمانکار است" },
    { severity: "medium", title: "جریمه‌ی تاخیر یک‌طرفه", detail: "فقط برای یکی از طرفین جریمه‌ی تاخیر تعیین شده است.", suggestion: "جریمه‌ی متقابل و متناسب تعریف شود.", quote: "" },
    { severity: "low", title: "ابهام در مرجع حل اختلاف", detail: "شهر مرجع صالح مشخص نشده است.", suggestion: "نام شهر و مرجع را صریح بنویسید.", quote: "" },
  ],
};

const XSS_HTML = `<h2>قرارداد آزمایشی امنیت</h2><p>این متن برای آزمون پاک‌سازی ساخته شده و پس از پاک‌سازی باید نمایش داده شود تا طول متن کافی باشد و ردشدن آزمون به‌خاطر کوتاهی نباشد.</p><script>alert('xss')</script><img src="x" onerror="alert(1)"><p onclick="steal()">بند دوم قرارداد شامل تعهدات طرفین است و نباید رویداد کلیک داشته باشد.</p><a href="javascript:alert(2)">لینک مخرب</a><iframe src="https://evil.example"></iframe><style>body{display:none}</style>`;

function content(ctx: Ctx, messages: Msg[]): string | null {
  const system = textOf(messages.find((m) => m.role === "system"));
  const user = textOf([...messages].reverse().find((m) => m.role === "user"));
  const isRisk = user.includes("<<<CONTRACT");
  const isImprove = user.includes("متن فعلی:");
  switch (ctx.scenario) {
    case "empty_content":
      return "";
    case "null_content":
      return null;
    case "short_reply":
      return "باشه";
    case "xss_payload":
      return isRisk ? JSON.stringify({ ...RISK_JSON, summary: "<script>alert(1)</script>" + RISK_JSON.summary }) : XSS_HTML;
    case "bad_json":
      return isRisk ? "متاسفانه نتوانستم تحلیل را به‌صورت JSON بنویسم، ولی قرارداد به نظر معمولی می‌رسد." : contractHtml(system, user);
    case "risk_wrapped_json":
      return "در ادامه تحلیل درخواستی شما:\n```json\n" + JSON.stringify(RISK_JSON, null, 2) + "\n```\nامیدوارم مفید باشد.";
    case "markdown_fenced": {
      const html = isRisk ? JSON.stringify(RISK_JSON) : isImprove ? improveHtml(user) : contractHtml(system, user);
      return "```" + (isRisk ? "json" : "html") + "\n" + html + "\n```";
    }
  }
  if (isRisk) return JSON.stringify(RISK_JSON);
  return isImprove ? improveHtml(user) : contractHtml(system, user);
}

async function chat(ctx: Ctx) {
  if (precheck(ctx)) return;
  const b = ctx.params;
  const model = str(b.model);
  const messages = Array.isArray(b.messages) ? (b.messages as Msg[]) : [];
  if (ctx.scenario === "bad_request") return oaiError(ctx, 400, "Invalid request: the request body is malformed.", "invalid_request_error", "invalid_request");
  if (!model) return oaiError(ctx, 400, "you must provide a model parameter", "invalid_request_error", "missing_model");
  if (messages.length === 0) return oaiError(ctx, 400, "'messages' is a required property", "invalid_request_error", "missing_messages");
  if (ctx.scenario === "model_not_found" || /^(nonexistent|unknown|bad)/i.test(model)) return oaiError(ctx, 404, `The model \`${model}\` does not exist or you do not have access to it.`, "invalid_request_error", "model_not_found");
  const totalChars = messages.reduce((n, m) => n + textOf(m).length, 0);
  if (ctx.scenario === "context_length" || totalChars > 400_000) return oaiError(ctx, 400, "This model's maximum context length is 128000 tokens. However, your messages resulted in more tokens than that.", "invalid_request_error", "context_length_exceeded");

  if (ctx.scenario === "rpm") {
    const limit = Math.max(1, Number(ctx.arg) || 2);
    const key = splitMagic(bearer(ctx)).key;
    const now = Date.now();
    const win = (ctx.sim.aiWindows.get(key) ?? []).filter((t) => now - t < 60_000);
    if (win.length >= limit) {
      ctx.sim.aiWindows.set(key, win);
      return oaiError(ctx, 429, `Rate limit reached: ${limit} requests per minute.`, "rate_limit_exceeded", "rate_limit_exceeded", { "Retry-After": "30" });
    }
    win.push(now);
    ctx.sim.aiWindows.set(key, win);
  }

  const text = ctx.scenario === "no_choices" ? "" : content(ctx, messages);
  const promptTokens = Math.ceil(totalChars / 4);
  const completionTokens = Math.ceil((text ?? "").length / 4);
  const finish = ctx.scenario === "content_filter" ? "content_filter" : "stop";
  const choices = ctx.scenario === "no_choices" ? [] : [{ index: 0, message: { role: "assistant", content: ctx.scenario === "content_filter" ? "" : text }, finish_reason: finish }];
  ctx.note = `${model} · ${promptTokens}+${completionTokens} tokens`;

  const id = `chatcmpl-sim-${ctx.sim.counter("chat", 1000)}`;
  const created = Math.floor(Date.now() / 1000);
  if (b.stream === true && text) {
    // پشتیبانی حداقلی از SSE برای کلاینت‌هایی که stream می‌خواهند
    ctx.res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" });
    const parts = text.match(/[\s\S]{1,80}/g) ?? [];
    for (const piece of parts) {
      ctx.res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      await sleep(2);
    }
    ctx.res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    ctx.res.end();
    return;
  }
  sendText(ctx, 200, JSON.stringify({ id, object: "chat.completion", created, model, choices, usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }), "application/json; charset=utf-8");
}

export const gapgpt: ServiceModule = {
  id: "gapgpt",
  scenarios,
  faults,
  route(method, path): Route | null {
    const p = path.replace(/^\/gapgpt/, "").replace(/\/+$/, "");
    const credential = (ctx: Ctx) => bearer(ctx);
    if (method === "GET" && p === "/v1/models") return { phase: "models", run: models, credential };
    if (method === "POST" && p === "/v1/chat/completions") return { phase: "chat", run: chat, credential };
    return null;
  },
};
