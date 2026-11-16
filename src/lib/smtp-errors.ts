/**
 * خطای خام SMTP/شبکه → پیام فارسی با «علت» و «راه‌حل» (خالص؛ قابل‌آزمون).
 * پیش‌تر مدیر عباراتی مثل «Invalid login: 535 5.7.8 Error» یا «wrong version number» می‌دید و نمی‌فهمید چه کند.
 */
export function friendlySmtpError(raw: string | null | undefined): string {
  const m = String(raw || "").trim();
  if (!m) return "ارسال ناموفق بود (علت نامشخص)";
  const l = m.toLowerCase();
  if (/invalid login|eauth|535|authentication (failed|unsuccessful)|username and password not accepted/.test(l))
    return "ورود به سرور ایمیل رد شد: نام کاربری یا رمز عبور اشتباه است. (برای Gmail/Yandex از «رمز برنامه» استفاده کنید، نه رمز اصلی حساب.)";
  if (/wrong version number|ssl routines|ssl3_get_record|unknown protocol/.test(l))
    return "پروتکل رمزنگاری با پورت هم‌خوان نیست: پورت ۴۶۵ برای SSL مستقیم و پورت‌های ۵۸۷ و ۲۵۲۵ برای STARTTLS است؛ پورت را عوض کنید.";
  if (/esmtptarget|مجاز نیست/.test(l) || /esmtptarget/.test(m.toLowerCase()))
    return "میزبان یا پورت SMTP مجاز نیست: فقط میزبان عمومی و یکی از پورت‌های ۲۵، ۴۶۵، ۵۸۷ یا ۲۵۲۵ پذیرفته می‌شود.";
  if (/enotfound|getaddrinfo|eai_again|dns/.test(l)) return "آدرس میزبان SMTP پیدا نشد؛ املای میزبان (مثلاً smtp.example.com) را بررسی کنید.";
  if (/econnrefused/.test(l)) return "سرور ایمیل اتصال را نپذیرفت؛ میزبان و پورت را بررسی کنید (ممکن است فایروال سرور پورت خروجی را بسته باشد).";
  if (/etimedout|timeout|timed out|esocket|econnreset|socket hang up/.test(l)) return "مهلت اتصال به سرور ایمیل تمام شد؛ پورت/میزبان را بررسی کنید یا مطمئن شوید هاست پورت خروجی SMTP را مسدود نکرده است.";
  if (/self.signed|certificate|cert_|unable to verify/.test(l)) return "گواهی امنیتی سرور ایمیل معتبر نیست؛ نام میزبان باید دقیقاً همان دامنه‌ی گواهی باشد.";
  if (/\b55[0-4]\b|sender|from address|not authorized|relay/.test(l)) return "سرور ایمیل فرستنده را نپذیرفت؛ «ایمیل فرستنده» باید متعلق به همین حساب/دامنه‌ی SMTP باشد.";
  return `ارسال ناموفق بود: ${m.slice(0, 160)}`;
}

/**
 * R-0x: طبقه‌بندی خطای ارسال ایمیل برای تصمیم «تلاش دوباره یا نه».
 *  - دائمی: رد صریح سرور (۵xx به‌جز خطاهای زیرساختی ۵۲۱/۵۵۲ و … که گذرا حساب می‌شوند)؛ آدرس نامعتبر/محتوای رد‌شده با تلاش دوباره درست نمی‌شود.
 *  - گذرا: شبکه، مهلت، DNS، ۴xx (greylisting، «بعداً دوباره»)، احراز هویت (مدیر ممکن است رمز را اصلاح کند) و هر چیز ناشناخته (محتاطانه).
 */
export function smtpErrorKind(e: unknown): "transient" | "permanent" {
  const err = e as { responseCode?: unknown; code?: unknown; message?: unknown } | null;
  const code = typeof err?.responseCode === "number" ? err.responseCode : NaN;
  if (code >= 400 && code < 500) return "transient";
  if (code >= 500 && code < 600) {
    // ۵۲۱ (سرور ایمیل نمی‌پذیرد)، ۵۳۰/۵۳۵ (احراز) و ۵۵۲ (فضای صندوق) با اصلاح تنظیمات/گذشت زمان درست می‌شوند
    return [421, 521, 530, 534, 535, 552].includes(code) ? "transient" : "permanent";
  }
  const text = `${String(err?.code ?? "")} ${String(err?.message ?? "")}`;
  if (/EENVELOPE|invalid (recipient|address)|no recipients defined/i.test(text)) return "permanent";
  return "transient";
}
