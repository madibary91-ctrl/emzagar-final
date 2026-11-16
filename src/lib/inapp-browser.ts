/**
 * U-09 — تشخیص مرورگر داخلیِ پیام‌رسان‌ها/شبکه‌های اجتماعی (WebView). این مرورگرها اغلب دانلود فایل (Content-Disposition: attachment)
 * را بی‌صدا نادیده می‌گیرند؛ کاربر روی «دریافت PDF» می‌زند و هیچ اتفاقی نمی‌افتد.
 * توابع خالص‌اند (UA ورودی می‌گیرند) تا بدون مرورگر آزمون شوند.
 */
const INAPP_PATTERNS: Array<[RegExp, string]> = [
  [/Telegram/i, "تلگرام"],
  [/Instagram/i, "اینستاگرام"],
  [/FBAN|FBAV|FB_IAB|FBIOS/i, "فیس‌بوک"],
  [/\bLine\//i, "لاین"],
  [/Snapchat/i, "اسنپ‌چت"],
  [/MicroMessenger/i, "ویچت"],
  [/Twitter|TwitterAndroid/i, "توییتر"],
  [/WhatsApp/i, "واتس‌اپ"],
  [/\bBale\b|Bale\//i, "بله"],
  [/Eitaa/i, "ایتا"],
  [/Rubika/i, "روبیکا"],
  [/Soroush|iGap/i, "پیام‌رسان"],
];

/** نام مرورگر داخلی (فارسی) یا null اگر مرورگر معمولی است */
export function detectInAppBrowser(ua: string): string | null {
  for (const [re, name] of INAPP_PATTERNS) if (re.test(ua)) return name;
  // WebView عمومی اندروید (`; wv)`) و iOS بدون نشانه‌ی Safari
  if (/; wv\)/i.test(ua)) return "مرورگر داخلی";
  if (/(iPhone|iPod|iPad)/i.test(ua) && !/Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua)) return "مرورگر داخلی";
  return null;
}

export function isAndroid(ua: string): boolean {
  return /Android/i.test(ua);
}

/** لینک intent اندروید برای باز کردن همین آدرس در Chrome (از داخل WebView کار می‌کند) */
export function androidChromeIntent(absoluteUrl: string): string | null {
  try {
    const u = new URL(absoluteUrl);
    const scheme = u.protocol.replace(":", "");
    if (scheme !== "http" && scheme !== "https") return null;
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${scheme};package=com.android.chrome;end`;
  } catch {
    return null;
  }
}

/** افزودن پارامتر query به آدرس نسبی/مطلق (بدون خراب‌کردن پارامترهای موجود) */
export function withQuery(href: string, key: string, value: string): string {
  const [path, hash = ""] = href.split("#");
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash ? `#${hash}` : ""}`;
}
