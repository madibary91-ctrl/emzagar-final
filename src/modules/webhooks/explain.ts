/**
 * تبدیل خطای فنی ارسال وب‌هوک/پیام‌رسان به «علت + راه‌حل» قابل‌فهم برای مدیر کسب‌وکار.
 * ماژول خالص است (بدون وابستگی به سرور) تا هم در سرور و هم در کلاینت امن استفاده شود.
 * پیام خام فنی همیشه هم‌راه نگه داشته می‌شود (برای پشتیبانی)، ولی دیگر تنها چیزی نیست که کاربر می‌بیند.
 */
export type ExplainedError = {
  /** دسته‌ی خطا؛ برای رنگ‌بندی و منطق */
  kind: "auth" | "not_found" | "bad_target" | "rate_limit" | "server" | "timeout" | "network" | "tls" | "blocked_url" | "rejected" | "unknown";
  /** علت در یک جمله */
  title: string;
  /** کار بعدیِ پیشنهادی */
  hint: string;
  /** پیام خام (کوتاه‌شده) */
  raw: string;
};

const MESSENGERS = ["telegram", "bale", "rubika", "eitaa"];

type Mk = (kind: ExplainedError["kind"], title: string, hint: string) => ExplainedError;
/** علت‌های متنیِ Bot API که مستقل از کد HTTP قابل‌تشخیص‌اند */
function byDescription(raw: string, mk: Mk): ExplainedError | null {
  if (/message is too long|MESSAGE_TOO_LONG/i.test(raw)) return mk("rejected", "متن پیام از سقف پیام‌رسان بلندتر بود", "رویداد با متن کوتاه‌تر دوباره ارسال می‌شود؛ نیازی به اقدام نیست.");
  if (/bot was blocked|user is deactivated|bot was kicked|kicked from|not a member|bot is not a member/i.test(raw)) return mk("bad_target", "ربات از این چت بیرون شده یا مسدود است", "ربات را دوباره Start کنید یا به گروه/کانال برگردانید.");
  if (/not enough rights|have no rights|need administrator|CHAT_WRITE_FORBIDDEN|can't send messages|rights to send/i.test(raw)) return mk("auth", "ربات اجازه‌ی نوشتن در این کانال/گروه را ندارد", "ربات را مدیر کانال کنید و دسترسی «ارسال پیام» را بدهید.");
  if (/chat not found|PEER_ID_INVALID|chat_id is empty/i.test(raw)) return mk("bad_target", "چت یا کانال پیدا نشد", "ربات را در پیام‌رسان Start کنید یا به کانال/گروه اضافه کنید؛ شناسه‌ی عددی گروه معمولاً با - شروع می‌شود.");
  return null;
}

export function explainDeliveryError(rawIn: string | null | undefined, provider = "generic"): ExplainedError {
  const raw = String(rawIn ?? "").trim().slice(0, 300);
  const messenger = MESSENGERS.includes(provider);
  const mk = (kind: ExplainedError["kind"], title: string, hint: string): ExplainedError => ({ kind, title, hint, raw });

  if (!raw) return mk("unknown", "علت مشخص نشد", "یک بار «تست» بزنید تا پیام دقیق‌تری ثبت شود.");

  const http = /^HTTP (\d{3})/.exec(raw);
  // M-10: خطای ساختاریافته‌ی پیام‌رسان («HTTP 400: chat not found») علت دقیق‌تری از خودِ کد وضعیت دارد
  if (http && messenger && raw.length > http[0].length) {
    const d = byDescription(raw, mk);
    if (d) return d;
  }
  if (http) {
    const code = Number(http[1]);
    if (code === 401 || code === 403) {
      return messenger
        ? mk("auth", "توکن ربات نپذیرفته شد یا ربات اجازه‌ی ارسال ندارد", "توکن را از BotFather/پدر بات‌ها دوباره بگیرید و ربات را به کانال یا گروه به‌عنوان مدیر اضافه کنید.")
        : mk("auth", `سرور مقصد دسترسی را رد کرد (${code})`, "اگر مقصد احراز هویت می‌خواهد، بررسی کنید فایروال یا افزونه‌ی امنیتی آدرس را نبسته باشد و کلید امضا (HMAC) در سمت گیرنده درست باشد.");
    }
    if (code === 404 || code === 410) {
      return messenger
        ? mk("not_found", "ربات یا آدرس API پیدا نشد", "توکن ربات را بررسی کنید؛ اگر از پروکسی استفاده می‌کنید، آدرس پروکسی را هم کنترل کنید.")
        : mk("not_found", "آدرس وب‌هوک در سرور مقصد وجود ندارد (۴۰۴)", "آدرس را با دقت بررسی کنید. اگر سایت وردپرس است، تغییر لینک‌های ثابت یا استقرار جدید ممکن است مسیر را موقتاً از کار انداخته باشد؛ ارسال خودکار دوباره تلاش می‌شود.");
    }
    if (code === 400) {
      return messenger
        ? mk("bad_target", "شناسه‌ی چت/کانال نادرست است یا ربات به آن دسترسی ندارد", "ربات را در بله/تلگرام «Start» کنید یا در کانال/گروه عضو و مدیر کنید و شناسه را دوباره بررسی کنید.")
        : mk("rejected", "سرور مقصد درخواست را نامعتبر دانست (۴۰۰)", "فرمت پیام را با راهنمای سازنده‌ی سرویس مقصد مقایسه کنید.");
    }
    if (code === 408 || code === 425) return mk("timeout", "سرور مقصد دیر پاسخ داد", "معمولاً موقتی است؛ ارسال خودکار دوباره تلاش می‌شود.");
    if (code === 429) return mk("rate_limit", "سرور مقصد درخواست‌ها را محدود کرده است (۴۲۹)", "نیازی به اقدام نیست؛ ارسال با فاصله‌ی بیشتر دوباره انجام می‌شود.");
    if (code >= 500) return mk("server", `سرور مقصد خطا داد (${code})`, "مشکل از سمت مقصد است و معمولاً موقتی؛ ارسال خودکار دوباره تلاش می‌شود. اگر ادامه داشت سرویس مقصد را بررسی کنید.");
    return mk("rejected", `سرور مقصد پاسخ غیرمنتظره داد (${code})`, "آدرس و تنظیمات سرویس مقصد را بررسی کنید.");
  }

  const byDesc = byDescription(raw, mk);
  if (byDesc) return byDesc;
  if (/chat not found|PEER_ID_INVALID|chat_id is empty/i.test(raw)) return mk("bad_target", "چت یا کانال پیدا نشد", "ربات را در پیام‌رسان Start کنید یا به کانال/گروه اضافه کنید؛ شناسه‌ی عددی گروه معمولاً با - شروع می‌شود.");
  if (/bot was blocked|user is deactivated|kicked|not a member/i.test(raw)) return mk("bad_target", "ربات از این چت بیرون شده یا مسدود است", "ربات را دوباره Start کنید یا به گروه/کانال برگردانید.");
  if (/not enough rights|have no rights|need administrator|CHAT_WRITE_FORBIDDEN/i.test(raw)) return mk("auth", "ربات اجازه‌ی نوشتن در این کانال/گروه را ندارد", "ربات را مدیر کانال کنید و دسترسی «ارسال پیام» را بدهید.");
  if (/unauthorized|invalid token|توکن/i.test(raw)) return mk("auth", "توکن ربات نامعتبر است", "توکن را دوباره از BotFather/پدر بات‌ها بگیرید و مقصد را با توکن جدید بسازید.");
  if (/too many requests|flood/i.test(raw)) return mk("rate_limit", "سقف ارسال پیام‌رسان پر شده است", "نیازی به اقدام نیست؛ کمی بعد دوباره تلاش می‌شود.");

  if (/فقط آدرس HTTPS|آدرس نامعتبر/.test(raw)) return mk("blocked_url", "آدرس باید معتبر باشد و با https:// شروع شود", "آدرس کامل را با https:// وارد کنید.");
  if (/داخلی مجاز نیست|میزبان قابل شناسایی نیست/.test(raw)) return mk("blocked_url", "این آدرس از بیرون قابل‌دسترسی نیست", "آدرس‌های داخلی (localhost، شبکه‌ی خصوصی) مجاز نیستند؛ آدرس عمومی سرویس مقصد را بدهید.");

  if (/مهلت|timeout|timed out|aborted|ETIMEDOUT/i.test(raw)) return mk("timeout", "سرور مقصد در زمان مقرر پاسخ نداد", "سرور مقصد کند یا از دسترس خارج است؛ ارسال خودکار دوباره تلاش می‌شود.");
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return mk("network", "نام دامنه‌ی مقصد پیدا نشد", "املای دامنه را بررسی کنید.");
  if (/certificate|CERT_|SSL|TLS|self.signed/i.test(raw)) return mk("tls", "گواهی HTTPS مقصد معتبر نیست", "گواهی SSL سرور مقصد را تمدید یا درست نصب کنید.");
  if (/ارتباط با .* برقرار نشد|fetch failed|ECONN|socket|terminated/i.test(raw)) {
    return mk("network", "ارتباط با سرور مقصد برقرار نشد", messenger ? "اگر سرور شما داخل ایران است و مقصد تلگرام است، «آدرس پروکسی API» را وارد کنید؛ برای بله و ایتا معمولاً نیازی نیست." : "سرور مقصد خاموش است یا دسترسی را بسته؛ ارسال خودکار دوباره تلاش می‌شود.");
  }
  if (/ریدایرکت|redirect/i.test(raw)) return mk("rejected", "آدرس مقصد به جای دیگری هدایت می‌شود", "آدرس نهایی (با www یا بدون آن) را وارد کنید.");

  return mk("unknown", raw, "یک بار «تست» بزنید؛ اگر ادامه داشت متن خطا را برای پشتیبانی بفرستید.");
}

/** یک‌خطی برای اعلان‌ها: «علت. راه‌حل» */
export function explainLine(raw: string | null | undefined, provider = "generic"): string {
  const e = explainDeliveryError(raw, provider);
  return `${e.title}. ${e.hint}`;
}
