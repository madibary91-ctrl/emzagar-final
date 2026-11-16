import dns from "node:dns/promises";

/**
 * فیلتر ایمیل‌های جعلی در ثبت‌نام (لایه‌ی اول؛ مالکیت واقعی ایمیل با کد/لینک تأیید اثبات می‌شود):
 *  ۱) دامنه‌های ایمیل یک‌بارمصرف شناخته‌شده
 *  ۲) دامنه‌ای که اصلاً وجود ندارد (NXDOMAIN) یا نه MX دارد و نه A
 * خطاهای شبکه/DNS هرگز مانع ثبت‌نام نمی‌شوند (fail-open) تا قطعی DNS سرور، کسب‌وکار را متوقف نکند.
 */
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "sharklasers.com", "grr.la", "spam4.me",
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmailo.com", "tempail.com",
  "throwawaymail.com", "yopmail.com", "yopmail.net", "yopmail.fr", "getnada.com", "nada.email", "maildrop.cc", "dispostable.com", "trashmail.com",
  "trashmail.net", "trashmail.de", "fakeinbox.com", "mailnesia.com", "mintemail.com", "mohmal.com", "emailondeck.com", "burnermail.io", "mytemp.email",
  "moakt.com", "tmail.ws", "tmpmail.org", "tmpmail.net", "discard.email", "mailcatch.com", "spamgourmet.com", "getairmail.com", "inboxkitten.com",
  "anonbox.net", "33mail.com", "mailforspam.com", "tempinbox.com", "emailfake.com", "fakemail.net", "harakirimail.com", "luxusmail.org", "owlymail.com",
  "linshiyouxiang.net", "email-temp.com", "cs.email", "tempr.email", "1secmail.com", "1secmail.org", "1secmail.net", "wegwerfmail.de", "byom.de",
]);

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

export function isDisposableEmail(email: string): boolean {
  const d = emailDomain(email);
  if (DISPOSABLE.has(d)) return true;
  // زیر‌دامنه‌ها (x.mailinator.com)
  const parts = d.split(".");
  for (let i = 1; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("dns_timeout"), { code: "ETIMEOUT" })), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const definitelyMissing = (e: unknown) => ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(String((e as { code?: string })?.code));

/** آیا دامنه قطعاً نمی‌تواند ایمیل دریافت کند؟ (فقط وقتی DNS صراحتاً «وجود ندارد» می‌گوید) */
export async function domainCannotReceiveMail(domain: string): Promise<boolean> {
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return true;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 2500);
    if (mx.length > 0) return false;
  } catch (e) {
    if (!definitelyMissing(e)) return false; // خطای موقت DNS
  }
  // طبق RFC 5321 اگر MX نبود، رکورد A/AAAA هم پذیرفته می‌شود
  try {
    await withTimeout(dns.resolve4(domain), 2500);
    return false;
  } catch (e) {
    if (!definitelyMissing(e)) return false;
  }
  try {
    await withTimeout(dns.resolve6(domain), 2500);
    return false;
  } catch (e) {
    return definitelyMissing(e);
  }
}

/** پیام خطا برای کاربر؛ null یعنی ایمیل پذیرفته می‌شود */
export async function emailRejection(email: string): Promise<string | null> {
  if (process.env.SKIP_EMAIL_DOMAIN_CHECK === "1") return null;
  if (isDisposableEmail(email)) return "ایمیل‌های موقت (یک‌بارمصرف) پذیرفته نمی‌شوند؛ از ایمیل واقعی خود استفاده کنید.";
  if (await domainCannotReceiveMail(emailDomain(email))) return "دامنه‌ی این ایمیل وجود ندارد یا ایمیل دریافت نمی‌کند. آدرس را بررسی کنید.";
  return null;
}
