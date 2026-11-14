import { and, eq, gt, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getAllSettings } from "@/modules/settings/service";
import { workspaceOfContract } from "@/modules/tenancy/service";
import { extTimeout, externalBase, friendlyNetworkError } from "@/lib/external";

export interface SmsMessage {
  to: string;
  text: string;
  /** برای قالب‌های تاییدیه (مثل verify کاوه‌نگار) */
  token?: string;
}
export interface SmsResult {
  ok: boolean;
  error?: string;
}
type Cfg = Awaited<ReturnType<typeof getAllSettings>>;
export interface SmsProvider {
  id: string;
  label: string;
  send(msg: SmsMessage, cfg: Cfg): Promise<SmsResult>;
}

/** حالت آزمایشی: فقط در لاگ ذخیره می‌شود */
const logProvider: SmsProvider = {
  id: "log",
  label: "حالت آزمایشی (فقط ثبت در لاگ)",
  async send() {
    return { ok: true };
  },
};

/** کدهای خطای کاوه‌نگار (return.status) به پیام فارسی */
const KAVENEGAR_ERRORS: Record<number, string> = {
  400: "پارامترهای ارسالی ناقص است",
  401: "حساب کاربری کاوه‌نگار غیرفعال شده است",
  402: "عملیات ناموفق بود",
  403: "کلید API کاوه‌نگار نامعتبر است",
  405: "متد درخواستی نامعتبر است",
  407: "دسترسی به خط ارسال‌کننده مجاز نیست",
  411: "شماره گیرنده نامعتبر است",
  412: "شماره ارسال‌کننده نامعتبر است",
  413: "متن پیامک خالی یا بیش از حد طولانی است",
  414: "تعداد گیرنده‌ها بیش از حد مجاز است",
  416: "IP سرور در فهرست مجاز کاوه‌نگار نیست",
  418: "اعتبار پنل پیامک کافی نیست",
  420: "ارسال لینک در متن پیامک مجاز نیست",
  422: "متن پیامک نویسه‌ی غیرمجاز دارد",
  424: "قالب (template) تأییدیه در کاوه‌نگار پیدا نشد",
  426: "استفاده از این متد نیازمند ارتقای حساب است",
  428: "ارسال کد از طریق تماس تلفنی ممکن نیست",
  431: "ساختار قالب (template) صحیح نیست",
  432: "پارامتر قالب در متن پیدا نشد",
  451: "تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد تلاش کنید",
  501: "حساب آزمایشی فقط به شماره‌ی صاحب حساب پیامک می‌فرستد",
};

/** پاسخ JSON را می‌خواند؛ اگر JSON نبود null برمی‌گرداند (خطای نحوی به کاربر نشان داده نشود) */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const j: unknown = JSON.parse(await res.text());
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const kavenegar: SmsProvider = {
  id: "kavenegar",
  label: "کاوه‌نگار",
  async send(msg, cfg) {
    if (!cfg.kavenegar_api_key) return { ok: false, error: "کلید API کاوه‌نگار تنظیم نشده است" };
    const base = `${externalBase("kavenegar", "https://api.kavenegar.com")}/v1/${encodeURIComponent(cfg.kavenegar_api_key)}`;
    const to = encodeURIComponent(msg.to);
    const url = msg.token
      ? `${base}/verify/lookup.json?receptor=${to}&token=${encodeURIComponent(msg.token)}&template=${encodeURIComponent(cfg.kavenegar_template || "verify")}`
      : `${base}/sms/send.json?receptor=${to}&message=${encodeURIComponent(msg.text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(extTimeout(10000)), redirect: "error" });
    const body = await readJson(res);
    const ret = body?.return as { status?: unknown; message?: unknown } | undefined;
    const status = typeof ret?.status === "number" ? ret.status : undefined;
    // کاوه‌نگار موفقیت را فقط با return.status === 200 اعلام می‌کند (نه صرفاً HTTP 200)
    if (status === 200 && res.ok) return { ok: true };
    if (status !== undefined) return { ok: false, error: KAVENEGAR_ERRORS[status] ?? `خطای کاوه‌نگار (کد ${status})${typeof ret?.message === "string" && ret.message ? ": " + ret.message.slice(0, 80) : ""}` };
    if (!res.ok) return { ok: false, error: res.status >= 500 ? `پنل کاوه‌نگار در دسترس نیست (HTTP ${res.status})` : `HTTP ${res.status}` };
    return { ok: false, error: "پاسخ نامعتبر از پنل کاوه‌نگار" };
  },
};

/** کدهای خطای ملی‌پیامک (فیلد Value وقتی recId واقعی نیست) */
const MELIPAYAMAK_ERRORS: Record<number, string> = {
  0: "نام کاربری یا رمز عبور ملی‌پیامک اشتباه است",
  2: "اعتبار پنل پیامک کافی نیست",
  3: "سقف ارسال روزانه‌ی پنل تکمیل شده است",
  4: "سقف حجم ارسال پنل تکمیل شده است",
  5: "شماره‌ی ارسال‌کننده (فرستنده) معتبر نیست",
  6: "سامانه‌ی ملی‌پیامک در حال به‌روزرسانی است",
  7: "متن پیامک حاوی کلمه‌ی فیلترشده است",
  10: "کاربر ملی‌پیامک فعال نیست",
  11: "پیامک ارسال نشد",
  12: "مدارک کاربر ملی‌پیامک کامل نیست",
  35: "شماره‌ی گیرنده در فهرست سیاه مخابرات است",
};

const melipayamak: SmsProvider = {
  id: "melipayamak",
  label: "ملی پیامک",
  async send(msg, cfg) {
    if (!cfg.melipayamak_username || !cfg.melipayamak_password)
      return { ok: false, error: "نام کاربری یا رمز ملی‌پیامک تنظیم نشده است" };
    const res = await fetch(`${externalBase("melipayamak", "https://rest.payamak-panel.com")}/api/SendSMS/SendSMS`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: cfg.melipayamak_username,
        password: cfg.melipayamak_password,
        to: msg.to,
        from: cfg.melipayamak_from,
        text: msg.text,
      }),
      signal: AbortSignal.timeout(extTimeout(10000)),
      redirect: "error",
    });
    if (!res.ok) return { ok: false, error: res.status >= 500 ? `پنل ملی‌پیامک در دسترس نیست (HTTP ${res.status})` : `HTTP ${res.status}` };
    const body = await readJson(res);
    if (!body) return { ok: false, error: "پاسخ نامعتبر از پنل ملی‌پیامک" };
    // ملی‌پیامک همیشه HTTP 200 می‌دهد؛ موفقیت یعنی RetStatus=1 و Value یک recId واقعی (عدد بلند). عدد کوچک = کد خطا
    const value = String(body.Value ?? "").trim();
    if (Number(body.RetStatus) === 1 && /^\d{15,}$/.test(value)) return { ok: true };
    const code = Number(value);
    if (/^\d{1,3}$/.test(value) && MELIPAYAMAK_ERRORS[code]) return { ok: false, error: MELIPAYAMAK_ERRORS[code] };
    return { ok: false, error: `خطای ملی‌پیامک${body.StrRetStatus ? ` (${String(body.StrRetStatus).slice(0, 60)})` : value ? ` (کد ${value.slice(0, 20)})` : ""}` };
  },
};

/** برای افزودن پنل جدید کافی است یک پرووایدر به این فهرست اضافه شود */
export const SMS_PROVIDERS: SmsProvider[] = [logProvider, kavenegar, melipayamak];

const MANAGED_LABEL = " (سرویس مدیریت‌شده)";

/** پنل پیامک «پلتفرم» (اختیاری): فضاهای کاری بدون پنل اختصاصی، بدون هیچ تنظیمی از آن استفاده می‌کنند */
export function platformSms(): { provider: SmsProvider; cfg: Partial<Cfg> } | null {
  const id = (process.env.PLATFORM_SMS_PROVIDER || "").trim();
  if (id === "kavenegar" && process.env.PLATFORM_KAVENEGAR_API_KEY) {
    return { provider: kavenegar, cfg: { kavenegar_api_key: process.env.PLATFORM_KAVENEGAR_API_KEY, kavenegar_template: process.env.PLATFORM_KAVENEGAR_TEMPLATE || "verify" } };
  }
  if (id === "melipayamak" && process.env.PLATFORM_MELIPAYAMAK_USERNAME && process.env.PLATFORM_MELIPAYAMAK_PASSWORD) {
    return {
      provider: melipayamak,
      cfg: { melipayamak_username: process.env.PLATFORM_MELIPAYAMAK_USERNAME, melipayamak_password: process.env.PLATFORM_MELIPAYAMAK_PASSWORD, melipayamak_from: process.env.PLATFORM_MELIPAYAMAK_FROM || "" },
    };
  }
  return null;
}

/** سقف روزانه‌ی پیامک مدیریت‌شده برای هر فضای کاری (جلوگیری از سوءاستفاده؛ پیش‌فرض ۱۰۰) */
async function underManagedQuota(workspaceId: number): Promise<boolean> {
  const limit = Math.max(1, Number(process.env.PLATFORM_SMS_DAILY_LIMIT) || 100);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.channel, "sms"),
        eq(notifications.status, "sent"),
        like(notifications.subject, `%${MANAGED_LABEL}`),
        gt(notifications.createdAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    );
  return (row?.n ?? 0) < limit;
}

export async function sendSms(msg: SmsMessage, contractId?: number | null, workspaceIdArg?: number): Promise<SmsResult & { testMode: boolean }> {
  const workspaceId = workspaceIdArg ?? (await workspaceOfContract(contractId));
  let cfg = await getAllSettings(workspaceId);
  let provider = SMS_PROVIDERS.find((p) => p.id === cfg.sms_provider) ?? logProvider;
  let managed = false;
  if (provider.id === "log" && workspaceId) {
    const platform = platformSms();
    if (platform && (await underManagedQuota(workspaceId))) {
      provider = platform.provider;
      cfg = { ...cfg, ...platform.cfg };
      managed = true;
    }
  }
  let result: SmsResult;
  try {
    result = await provider.send(msg, cfg);
  } catch (e) {
    result = { ok: false, error: friendlyNetworkError(e, "پنل پیامک") };
  }
  await db.insert(notifications).values({
    channel: "sms",
    recipient: msg.to,
    subject: provider.label + (managed ? MANAGED_LABEL : ""),
    // متن پیامک حاوی کد در حالت آزمایشی ذخیره می‌شود؛ در حالت واقعی ذخیره نمی‌شود
    body: provider.id === "log" ? msg.text : "(ارسال شده از طریق پنل پیامک)",
    status: result.ok ? (provider.id === "log" ? "logged" : "sent") : "failed",
    error: result.error ?? null,
    contractId: contractId ?? null,
    workspaceId,
  });
  return { ...result, testMode: provider.id === "log" };
}
