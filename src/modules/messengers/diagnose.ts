import { eq } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots } from "@/db/schema";
import { BotApiError, getMe, getWebhookInfo, type TgWebhookInfo } from "./client";
import { botRef, connectBot, webhookUrlFor } from "./service";

export type Check = { ok: boolean; label: string; detail: string };
export type Diagnosis = { healthy: boolean; fixable: boolean; checks: Check[] };

export type HealthInput = {
  active: boolean;
  mode: string;
  /** آیا توکن با getMe تأیید شد؟ (خطا ⇒ پیام) */
  tokenOk: boolean;
  tokenError?: string;
  username?: string;
  /** آدرس وب‌هوکی که باید روی ربات ثبت باشد (خالی = آدرس HTTPS عمومی در دسترس نیست) */
  expectedUrl: string;
  /** وضعیت وب‌هوک نزد پیام‌رسان؛ null = پیام‌رسان این متد را پشتیبانی نکرد/خطا داد */
  info: TgWebhookInfo | null;
  lastEventAt: Date | null;
  now?: Date;
};

const ago = (d: Date, now: Date) => {
  const m = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
  if (m < 1) return "همین الان";
  if (m < 60) return `${m.toLocaleString("fa-IR")} دقیقه پیش`;
  if (m < 48 * 60) return `${Math.round(m / 60).toLocaleString("fa-IR")} ساعت پیش`;
  return `${Math.round(m / 1440).toLocaleString("fa-IR")} روز پیش`;
};

/** منطق خالص تشخیص (بدون شبکه/دیتابیس) تا قابل‌آزمون باشد */
export function evaluateBotHealth(i: HealthInput): Diagnosis {
  const now = i.now ?? new Date();
  const checks: Check[] = [];
  let fixable = false;

  checks.push(i.tokenOk ? { ok: true, label: "توکن ربات", detail: `معتبر است${i.username ? ` (@${i.username})` : ""}` } : { ok: false, label: "توکن ربات", detail: i.tokenError || "پیام‌رسان توکن را نپذیرفت؛ توکن را دوباره از BotFather/پدر بات‌ها بگیرید و ربات را حذف و دوباره اضافه کنید." });
  checks.push(i.active ? { ok: true, label: "وضعیت ربات", detail: "فعال است" } : { ok: false, label: "وضعیت ربات", detail: "غیرفعال است و پیام‌ها را نمی‌پذیرد؛ «فعال‌سازی» را بزنید." });

  if (i.tokenOk) {
    if (i.mode === "webhook") {
      if (!i.expectedUrl.startsWith("https://")) {
        checks.push({ ok: false, label: "آدرس عمومی HTTPS", detail: "آدرس سایت HTTPS نیست (یا APP_URL تنظیم نشده)؛ پیام‌رسان به آن وب‌هوک نمی‌زند. حالت «Polling» را انتخاب کنید یا APP_URL را روی آدرس HTTPS بگذارید." });
      } else if (i.info === null) {
        checks.push({ ok: true, label: "ثبت وب‌هوک", detail: "پیام‌رسان گزارش وضعیت وب‌هوک را پشتیبانی نمی‌کند؛ با «ارسال پیام آزمایشی» و فرستادن یک پیام به ربات بررسی کنید." });
      } else if (!i.info.url) {
        fixable = true;
        checks.push({ ok: false, label: "ثبت وب‌هوک", detail: "روی ربات هیچ وب‌هوکی ثبت نیست؛ پیام‌های کاربران به سامانه نمی‌رسد. «رفع خودکار» را بزنید." });
      } else if (i.info.url !== i.expectedUrl) {
        fixable = true;
        checks.push({ ok: false, label: "ثبت وب‌هوک", detail: "آدرس ثبت‌شده روی ربات با آدرس فعلی سایت یکی نیست (دامنه عوض شده یا ربات جای دیگری وصل است). «رفع خودکار» را بزنید." });
      } else {
        checks.push({ ok: true, label: "ثبت وب‌هوک", detail: "درست ثبت شده است" });
      }
      if (i.info) {
        const pending = Number(i.info.pending_update_count) || 0;
        if (pending > 20) checks.push({ ok: false, label: "پیام‌های صف‌مانده", detail: `${pending.toLocaleString("fa-IR")} پیام نزد پیام‌رسان معطل مانده؛ معمولاً یعنی سایت پاسخ نمی‌دهد یا گواهی HTTPS مشکل دارد.` });
        if (i.info.last_error_message) {
          const when = i.info.last_error_date ? ` (${ago(new Date(i.info.last_error_date * 1000), now)})` : "";
          const recent = i.info.last_error_date ? now.getTime() - i.info.last_error_date * 1000 < 3600_000 : true;
          checks.push({ ok: !recent, label: "آخرین خطای تحویل", detail: `${String(i.info.last_error_message).slice(0, 160)}${when}` });
        }
      }
    } else {
      if (i.info?.url) {
        fixable = true;
        checks.push({ ok: false, label: "تداخل با وب‌هوک", detail: "ربات در حالت Polling است ولی روی آن هنوز یک وب‌هوک فعال است؛ پیام‌ها دریافت نمی‌شوند (خطای ۴۰۹). «رفع خودکار» وب‌هوک را برمی‌دارد." });
      } else {
        checks.push({ ok: true, label: "حالت Polling", detail: "وب‌هوکی در تداخل نیست" });
      }
    }
  }

  checks.push(
    i.lastEventAt
      ? { ok: true, label: "آخرین پیام دریافتی از کاربران", detail: ago(i.lastEventAt, now) }
      : { ok: true, label: "آخرین پیام دریافتی از کاربران", detail: "هنوز پیامی نرسیده؛ یک پیام (مثلاً /help) به ربات بفرستید و دوباره بررسی کنید." },
  );
  return { healthy: checks.every((c) => c.ok), fixable, checks };
}

/** بررسی زنده‌ی یک ربات؛ با fix=true مشکلات قابل‌رفع (ثبت/حذف وب‌هوک) را خودکار درست می‌کند و دوباره می‌سنجد */
export async function diagnoseBot(botId: number, opts: { fix?: boolean } = {}): Promise<Diagnosis | null> {
  const run = async (): Promise<Diagnosis | null> => {
    const [bot] = await db.select().from(messengerBots).where(eq(messengerBots.id, botId));
    if (!bot) return null;
    const ref = botRef(bot);
    let tokenOk = true;
    let tokenError = "";
    let username = bot.botUsername;
    try {
      const me = await getMe(ref);
      username = me.username || username;
    } catch (e) {
      tokenOk = false;
      tokenError = e instanceof BotApiError ? e.message : "ارتباط با پیام‌رسان برقرار نشد";
    }
    let info: TgWebhookInfo | null = null;
    if (tokenOk) info = await getWebhookInfo(ref).catch(() => null);
    return evaluateBotHealth({ active: bot.active, mode: bot.mode, tokenOk, tokenError, username, expectedUrl: await webhookUrlFor(bot), info, lastEventAt: bot.lastEventAt });
  };
  let d = await run();
  if (d && opts.fix && d.fixable) {
    await connectBot(botId);
    d = await run();
  }
  return d;
}
