/**
 * شبیه‌ساز پنل پیامک ملی‌پیامک (REST). مسیر: POST /melipayamak/api/SendSMS/SendSMS
 * ملی‌پیامک همیشه HTTP 200 می‌دهد؛ موفقیت یعنی RetStatus=1 و Value یک recId بلند (بیش از ۱۵ رقم).
 * در خطا، Value یک کد کوچک است (۰: رمز اشتباه، ۲: اعتبار کم، ۳: سقف روزانه، ۵: فرستنده نامعتبر، ۷: کلمه‌ی فیلتر …).
 * «کلید جادویی» در رمز عبور: PASSWORD~insufficient_credit
 */
import { sendJson, splitMagic, str } from "./core";
import type { Ctx, Route, ScenarioInfo, ServiceModule } from "./core";

const scenarios: ScenarioInfo[] = [
  { id: "success", title: "موفقیت", description: "رفتار عادی؛ recId بلند برمی‌گرداند.", group: "success" },
  { id: "bad_credentials", title: "نام کاربری/رمز اشتباه (Value=0)", description: "HTTP 200 ولی Value=0.", group: "error" },
  { id: "insufficient_credit", title: "کمبود اعتبار (Value=2)", description: "اعتبار پنل کافی نیست (HTTP 200).", group: "error" },
  { id: "daily_limit", title: "سقف روزانه (Value=3)", description: "محدودیت ارسال روزانه.", group: "error" },
  { id: "invalid_sender", title: "فرستنده نامعتبر (Value=5)", description: "شماره‌ی خط ارسال‌کننده معتبر نیست.", group: "error" },
  { id: "system_update", title: "سامانه در حال به‌روزرسانی (Value=6)", description: "سامانه موقتاً در دسترس نیست.", group: "error" },
  { id: "filtered_text", title: "کلمه‌ی فیلترشده (Value=7)", description: "متن حاوی کلمه‌ی فیلتر شده است.", group: "error" },
  { id: "inactive_user", title: "کاربر غیرفعال (Value=10)", description: "حساب کاربری فعال نیست.", group: "error" },
  { id: "blacklisted", title: "لیست سیاه مخابرات (Value=35)", description: "شماره‌ی گیرنده در لیست سیاه است.", group: "error" },
  { id: "empty_value", title: "پاسخ بدون Value", description: "JSON معتبر ولی بدون recId (برنامه نباید موفق فرض کند).", group: "error" },
];
const faults = ["bad_credentials", "insufficient_credit", "daily_limit", "invalid_sender", "system_update", "filtered_text", "inactive_user", "blacklisted", "empty_value"] as const;

const CODES: Record<string, string> = { bad_credentials: "0", insufficient_credit: "2", daily_limit: "3", invalid_sender: "5", system_update: "6", filtered_text: "7", inactive_user: "10", blacklisted: "35" };

function reply(ctx: Ctx, value: string, status = "Ok") {
  ctx.note = `Value ${value}`;
  sendJson(ctx, 200, { Value: value, RetStatus: 1, StrRetStatus: status });
}

async function send(ctx: Ctx) {
  const p = ctx.params;
  const { key: password } = splitMagic(str(p.password));
  if (ctx.scenario === "empty_value") return sendJson(ctx, 200, { RetStatus: 1, StrRetStatus: "Ok" });
  if (CODES[ctx.scenario]) return reply(ctx, CODES[ctx.scenario]);
  if (!str(p.username) || !password) return reply(ctx, "0");
  const to = str(p.to).trim();
  if (!/^(09\d{9}|\+?989\d{9})$/.test(to)) return reply(ctx, "11");
  if (!str(p.text).trim()) return reply(ctx, "11");
  if (ctx.sim.melipayamakCredit <= 0) return reply(ctx, "2");
  ctx.sim.melipayamakCredit -= 1;
  const n = ctx.sim.counter("melipayamak-rec", 100);
  const recId = "8" + String(n).padStart(18, "0"); // recId بلند (۱۹ رقم) مثل سرویس واقعی
  const text = str(p.text);
  ctx.sim.sms.push({ id: ctx.sim.nextId(), messageId: n, provider: "melipayamak", kind: "send", to, text, sender: str(p.from) || "5000", at: new Date().toISOString(), delivery: "delivered", code: /\d{4,8}/.exec(text)?.[0] });
  reply(ctx, recId);
}

export const melipayamak: ServiceModule = {
  id: "melipayamak",
  scenarios,
  faults,
  route(method, path): Route | null {
    if (method === "POST" && /^\/melipayamak\/api\/SendSMS\/SendSMS$/i.test(path)) return { phase: "send", run: send, credential: (ctx) => str(ctx.params.password) };
    return null;
  },
};
