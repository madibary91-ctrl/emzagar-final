import crypto from "node:crypto";
import { getSecret } from "@/lib/secret";

/**
 * توابع خالص ماژول ربات‌های پیام‌رسان (بدون دسترسی به دیتابیس/شبکه؛ قابل آزمون واحد).
 *
 * مدل کلی: تلگرام و «بله» هر دو Bot API یکسانی دارند (بله بر پایه‌ی API تلگرام است و داخل ایران بدون فیلتر در دسترس است)؛
 * پس یک «آداپتور» برای هر دو کافی است و فقط آدرس پایه و لینک عمیق فرق می‌کند.
 */
import { isProvider, providerLabel, MESSENGER_PROVIDERS, type MessengerProvider } from "./meta";
export { isProvider, providerLabel, MESSENGER_PROVIDERS, type MessengerProvider };

/** قالب توکن ربات: <شناسه‌ی عددی>:<رشته‌ی تصادفی> */
export const BOT_TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{20,80}$/;

/* ───────── شماره‌ی موبایل ───────── */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** هر قالب رایج شماره‌ی ایرانی (+98912…، 0098912…، 912…، ارقام فارسی) را به 09xxxxxxxxx تبدیل می‌کند؛ نامعتبر = "" */
export function normalizeMobile(raw: unknown): string {
  let s = String(raw ?? "").replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  s = s.replace(/[^\d]/g, "");
  if (s.startsWith("0098")) s = "0" + s.slice(4);
  else if (s.startsWith("98") && s.length === 12) s = "0" + s.slice(2);
  else if (s.startsWith("9") && s.length === 10) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : "";
}

export const maskMobile = (m: string): string => (m.length >= 6 ? `${m.slice(0, 4)}***${m.slice(-2)}` : "");

/* ───────── کدهای اتصال ───────── */

export const sha256Hex = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** کد یک‌بارمصرف اتصال حساب پنل (پارامتر ‎/start‎؛ فقط [A-Za-z0-9_-] و حداکثر ۶۴ نویسه) */
export function newLinkCode(): string {
  return "l" + crypto.randomBytes(24).toString("base64url");
}

const guestMac = (body: string) => crypto.createHmac("sha256", getSecret()).update(`msg-guest-link:${body}`).digest().subarray(0, 10).toString("base64url");

/**
 * کد بدون‌وضعیت (امضاشده با HMAC) برای «امضاکننده‌ی مهمان»: روی صفحه‌ی لینک امضا نمایش داده می‌شود و فقط
 * چت را به همان مهمان وصل می‌کند. هویت‌گواهی‌شده (برای OTP) فقط با اشتراک شماره از خود پیام‌رسان به‌دست می‌آید.
 */
export function makeGuestLinkCode(userId: number, ttlMinutes = 360, nowMs = Date.now()): string {
  const body = `${userId.toString(36)}_${(Math.floor(nowMs / 60000) + ttlMinutes).toString(36)}`;
  return `g${body}_${guestMac(body)}`;
}

export function parseGuestLinkCode(code: string, nowMs = Date.now()): number | null {
  const m = /^g([0-9a-z]+)_([0-9a-z]+)_([A-Za-z0-9_-]{14})$/.exec(code);
  if (!m) return null;
  const body = `${m[1]}_${m[2]}`;
  const a = Buffer.from(m[3]);
  const b = Buffer.from(guestMac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (parseInt(m[2], 36) < Math.floor(nowMs / 60000)) return null;
  const id = parseInt(m[1], 36);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** مقایسه‌ی ایمن رازها (طول‌های متفاوت = نابرابر، بدون استثنا) */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** رازی که تلگرام در هدر X-Telegram-Bot-Api-Secret-Token می‌فرستد؛ از راز آدرس مشتق می‌شود (جدا از خودِ آدرس) */
export const headerSecretFor = (webhookSecret: string): string => crypto.createHmac("sha256", getSecret()).update(`msg-hdr:${webhookSecret}`).digest("hex").slice(0, 48);

export const newWebhookSecret = (): string => crypto.randomBytes(24).toString("hex");

/** لینک عمیق ربات: t.me برای تلگرام و ble.ir برای بله */
export function deepLink(provider: string, username: string, code?: string): string {
  const host = provider === "bale" ? "https://ble.ir" : "https://t.me";
  return `${host}/${username}${code ? `?start=${code}` : ""}`;
}

/* ───────── متن ───────── */

/** پیام‌های بلند به تکه‌های کوچک‌تر از سقف پیام‌رسان (۴۰۹۶) شکسته می‌شوند؛ ترجیحاً سر خط */
export function chunkText(text: string, max = 3800): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** نشان‌دهنده‌ی نوع اعلان درون‌برنامه‌ای در پیام‌رسان */
export const NOTICE_ICON: Record<string, string> = { info: "ℹ️", action: "✍️", success: "✅", warning: "⚠️", security: "🔐" };

export interface Btn {
  text: string;
  url?: string;
  data?: string;
}

/** صفحه‌کلید inline استاندارد Bot API */
export function inlineKeyboard(rows: Btn[][]): { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } | undefined {
  const kb = rows
    .map((r) => r.filter((b) => b.text && (b.url || b.data)).map((b) => (b.url ? { text: clip(b.text, 60), url: b.url } : { text: clip(b.text, 60), callback_data: (b.data as string).slice(0, 64) })))
    .filter((r) => r.length > 0);
  return kb.length ? { inline_keyboard: kb } : undefined;
}

/** تلگرام دکمه‌ی URL به آدرس محلی/بدون دامنه را رد می‌کند */
export function urlButtonSafe(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname;
    return h.includes(".") && h !== "localhost" && !/^(127\.|10\.|192\.168\.)/.test(h);
  } catch {
    return false;
  }
}
