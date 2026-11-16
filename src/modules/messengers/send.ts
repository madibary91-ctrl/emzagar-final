import { BotApiError, sendDocument, sendMessage, type ReplyMarkup } from "./client";
import { botRef, chatTargetsForUser, logMessenger, markBotTokenInvalid, markChatBlocked, type ChatTarget } from "./service";
import { chunkText, inlineKeyboard, urlButtonSafe, type Btn } from "./util";

export interface Outgoing {
  text: string;
  buttons?: Btn[][];
  /** صفحه‌کلید پاسخ (منوی ثابت/درخواست شماره)؛ جایگزین دکمه‌های inline می‌شود */
  replyMarkup?: Record<string, unknown>;
}
/**
 * retryAfterSec: پیام‌رسان (۴۲۹) گفته چند ثانیه صبر کنیم. partial: بخشی از پیام چندتکه‌ای رسیده؛ تلاش دوباره‌ی کل پیام تکرار می‌ساخت (retry همیشه false است).
 */
export type DeliverResult = { ok: true } | { ok: false; error: string; retry: boolean; retryAfterSec?: number; partial?: boolean };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** سقف انتظار درون‌پردازه‌ای برای ۴۲۹ در میانه‌ی پیام چندتکه‌ای (بیشتر از آن به صف واگذار می‌شود) */
const INLINE_WAIT_MAX_MS = 5000;

/** دکمه‌های URLِ غیرقابل‌قبول برای پیام‌رسان (آدرس محلی) به‌صورت متن لینک زیر پیام می‌آیند */
function splitButtons(buttons: Btn[][] | undefined): { rows: Btn[][]; extra: string[] } {
  const extra: string[] = [];
  const rows = (buttons ?? [])
    .map((r) =>
      r.filter((b) => {
        if (b.url && !urlButtonSafe(b.url)) {
          extra.push(`🔗 ${b.text}: ${b.url}`);
          return false;
        }
        return true;
      }),
    )
    .filter((r) => r.length > 0);
  return { rows, extra };
}

/**
 * ارسال یک پیام (متن یا سند) به یک چت. خطای دائمی (کاربر ربات را بسته) چت را «مسدود» علامت می‌زند؛
 * خطای موقت (شبکه، ۴۲۹، ۵xx) با retry=true برگردانده می‌شود تا صف کارها با backoff دوباره تلاش کند.
 */
export async function deliver(
  t: ChatTarget,
  msg: Outgoing,
  o: { kind: string; contractId?: number | null; final: boolean; document?: { buffer: Buffer; filename: string }; timeoutMs?: number; silentLog?: boolean },
): Promise<DeliverResult> {
  const ref = botRef(t.bot);
  const chatId = t.chat.chatId;
  /** تکه‌های پیام که همین حالا رسیده‌اند؛ تلاش دوباره (حتی با متن جایگزین دکمه) از ادامه می‌رود نه از اول */
  let chunksSent = 0;
  const sendChunk = async (chunk: string, markup: ReplyMarkup) => {
    // تکه‌ی اول: خطا مستقیم به صف می‌رود (هنوز چیزی نرسیده). تکه‌های بعدی: تلاش درجا، تا پیام ناقص و تکراری نشود (M-05)
    for (let tryNo = 1; ; tryNo++) {
      try {
        await sendMessage(ref, chatId, chunk, markup, o.timeoutMs);
        return;
      } catch (e) {
        const again = chunksSent > 0 && tryNo < 3 && e instanceof BotApiError && e.transient && (e.retryAfter ?? 0) * 1000 <= INLINE_WAIT_MAX_MS;
        if (!again) throw e;
        await sleep(Math.min(INLINE_WAIT_MAX_MS, Math.max(1000, (e as BotApiError).retryAfter ? (e as BotApiError).retryAfter! * 1000 : tryNo * 1000)));
      }
    }
  };
  const attempt = async (rows: Btn[][], extra: string[]) => {
    const text = extra.length ? `${msg.text}\n\n${extra.join("\n")}` : msg.text;
    const markup = msg.replyMarkup ?? inlineKeyboard(rows);
    if (o.document) {
      await sendDocument(ref, chatId, o.document, text, markup);
      return;
    }
    const chunks = chunkText(text);
    for (let i = chunksSent; i < chunks.length; i++) {
      await sendChunk(chunks[i], i === chunks.length - 1 ? markup : undefined);
      chunksSent = i + 1;
    }
  };
  try {
    const { rows, extra } = splitButtons(msg.buttons);
    try {
      await attempt(rows, extra);
    } catch (e) {
      if (e instanceof BotApiError && e.badButtonUrl && rows.some((r) => r.some((b) => b.url))) {
        const urls = rows.flat().filter((b) => b.url).map((b) => `🔗 ${b.text}: ${b.url}`);
        await attempt(rows.map((r) => r.filter((b) => !b.url)).filter((r) => r.length), [...extra, ...urls]);
      } else throw e;
    }
    if (!o.silentLog) await logMessenger({ botId: t.bot.id, chatRowId: t.chat.id, kind: o.kind, status: "sent", contractId: o.contractId });
    return { ok: true };
  } catch (e) {
    const err = e instanceof BotApiError ? e : new BotApiError(e instanceof Error ? e.message : "خطای ناشناخته", 0);
    if (err.chatGone) await markChatBlocked(t.chat.id);
    // M-03: توکن باطل‌شده بی‌صدا نماند
    if (err.unauthorized) await markBotTokenInvalid(t.bot.id).catch(() => undefined);
    // M-05: اگر بخشی از پیام رسیده، تلاش دوباره‌ی کل پیام تکه‌های اول را دوباره می‌فرستاد؛ پس «ناقص» ثبت و رها می‌شود
    const partial = chunksSent > 0 && !err.permanent;
    const retry = !err.permanent && !partial;
    if (!retry || o.final) await logMessenger({ botId: t.bot.id, chatRowId: t.chat.id, kind: o.kind, status: "failed", error: partial ? `ارسال ناقص: ${err.message}` : err.message, contractId: o.contractId });
    return { ok: false, error: err.message, retry, ...(err.code === 429 && err.retryAfter ? { retryAfterSec: err.retryAfter } : {}), ...(partial ? { partial: true } : {}) };
  }
}

/**
 * کد تأیید امضا از طریق پیام‌رسان. فقط به چت‌هایی می‌رود که «شماره‌ی موبایل امضاکننده را خود پیام‌رسان گواهی کرده»
 * (دکمه‌ی اشتراک شماره)؛ چت وصل‌شده با لینک امضا به‌تنهایی کافی نیست، وگرنه OTP دیگر عامل دوم نبود.
 *
 * skipSms: حداقل یک ربات در حالت «prefer» پیام را رساند؛ ارسال پیامک لازم نیست (کاهش هزینه و وابستگی به پیامک).
 */
export async function sendOtpViaMessenger(p: { userId: number; workspaceId: number; contractId: number; code: string; siteName: string }): Promise<{ delivered: number; skipSms: boolean }> {
  let delivered = 0;
  let skipSms = false;
  const targets = (await chatTargetsForUser(p.userId, { workspaceId: p.workspaceId, mode: "verified" })).filter((t) => t.bot.otpMode !== "off");
  // هم‌زمان: یک ربات کند/قطع (۵ ثانیه مهلت) نباید ارسال به ربات‌های دیگر و پیامکِ جایگزین را به تعویق بیندازد
  const results = await Promise.all(
    targets.map((t) =>
      deliver(
        t,
        { text: `🔐 کد تأیید امضای قرارداد در ${p.siteName}:\n\n${p.code}\n\nاین کد ۵ دقیقه اعتبار دارد. اگر خودتان درخواست نداده‌اید آن را به کسی ندهید.` },
        { kind: "otp", contractId: p.contractId, final: true, timeoutMs: 5000 },
      ).then((r) => ({ r, t })),
    ),
  );
  for (const { r, t } of results) {
    if (r.ok) {
      delivered++;
      if (t.bot.otpMode === "prefer") skipSms = true;
    }
  }
  return { delivered, skipSms };
}
