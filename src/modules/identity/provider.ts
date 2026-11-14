import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { extTimeout } from "@/lib/external";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";

/**
 * سرویس‌دهنده‌ی «تطبیق کد ملی ↔ موبایل» (استعلام شاهکار).
 *  - off      غیرفعال: سطح «شاهکار» قابل انتخاب نیست؛ سطح «مدارک هویتی» همچنان کار می‌کند (بدون سرویس بیرونی)
 *  - zibal    زیبال (POST https://api.zibal.ir/v1/facility/shahkarInquiry با Bearer token)
 *  - sandbox  آزمایشی/آموزشی: بدون تماس بیرونی؛ «تطبیق» وقتی است که رقم آخر موبایل با رقم آخر کد ملی یکی باشد
 * پیکربندی در تنظیمات سراسری پلتفرم (مدیر کل) است؛ توکن با AES-256-GCM رمزنگاری می‌شود و هرگز به مرورگر برنمی‌گردد.
 */
export type IdentityMode = "off" | "zibal" | "sandbox";
export const IDENTITY_MODES: { id: IdentityMode; label: string }[] = [
  { id: "off", label: "غیرفعال (فقط مدارک هویتی)" },
  { id: "zibal", label: "زیبال — استعلام شاهکار واقعی" },
  { id: "sandbox", label: "آزمایشی (بدون تماس بیرونی)" },
];

const K_MODE = "identity_mode";
const K_TOKEN = "identity_zibal_token";
const K_PRICE = "identity_price";

export interface IdentityConfig {
  mode: IdentityMode;
  hasToken: boolean;
  /** هزینه‌ی هر استعلام از کیف پول «صادرکننده» (تومان)؛ ۰ = رایگان */
  price: number;
}

const isMode = (v: string): v is IdentityMode => v === "off" || v === "zibal" || v === "sandbox";
/** در محیط توسعه/آزمون پیش‌فرض «آزمایشی» است؛ در تولید تا تنظیم‌نشدن «غیرفعال» (fail-closed) */
const defaultMode = (): IdentityMode => (process.env.NODE_ENV !== "production" ? "sandbox" : "off");

export async function getIdentityConfig(): Promise<IdentityConfig> {
  const raw = (await getGlobalSetting(K_MODE)).trim();
  const mode = isMode(raw) ? raw : defaultMode();
  const priceRaw = (await getGlobalSetting(K_PRICE)).trim();
  const token = decryptSecret(await getGlobalSetting(K_TOKEN));
  return { mode, hasToken: !!token, price: /^\d+$/.test(priceRaw) ? Math.min(Number(priceRaw), 1_000_000) : 0 };
}

export async function saveIdentityConfig(p: { mode: string; token?: string; clearToken?: boolean; price: number }) {
  await saveGlobalSetting(K_MODE, isMode(p.mode) ? p.mode : "off");
  if (p.clearToken) await saveGlobalSetting(K_TOKEN, "");
  else if (p.token && p.token.trim()) await saveGlobalSetting(K_TOKEN, encryptSecret(p.token.trim()));
  await saveGlobalSetting(K_PRICE, String(Math.max(0, Math.min(1_000_000, Math.round(p.price || 0)))));
}

/** آیا استعلام خودکار شاهکار در دسترس است؟ (zibal فقط با توکن) */
export async function shahkarAvailable(): Promise<boolean> {
  const c = await getIdentityConfig();
  return c.mode === "sandbox" || (c.mode === "zibal" && c.hasToken);
}

export type InquiryResult = { ok: true; matched: boolean; provider: IdentityMode; ref: string } | { ok: false; error: string };

const ZIBAL_ERRORS: Record<number, string> = {
  2: "توکن زیبال ارسال نشده است",
  3: "توکن زیبال نادرست است",
  4: "توکن زیبال اجازه‌ی استعلام شاهکار ندارد",
  6: "ورودی استعلام نامعتبر است",
  7: "IP سرور در فهرست مجاز زیبال نیست",
  8: "توکن زیبال غیرفعال است",
  29: "موجودی کیف پول کارمزد زیبال کافی نیست",
  45: "سرویس‌دهنده‌های استعلام موقتاً در دسترس نیستند",
};

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const j: unknown = JSON.parse(await res.text());
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** تطبیق «مالکیت سیم‌کارت ↔ کد ملی». ورودی‌ها باید پیش‌تر اعتبارسنجی شده باشند (09xxxxxxxxx و کد ملی معتبر). */
export async function inquireShahkar(mobile: string, nationalCode: string): Promise<InquiryResult> {
  const cfg = await getIdentityConfig();
  if (cfg.mode === "off") return { ok: false, error: "استعلام هویتی روی این سامانه فعال نیست" };
  if (cfg.mode === "sandbox") {
    return { ok: true, matched: mobile.slice(-1) === nationalCode.slice(-1), provider: "sandbox", ref: `sbx-${Date.now().toString(36)}` };
  }
  const token = decryptSecret(await getGlobalSetting(K_TOKEN));
  if (!token) return { ok: false, error: "توکن سرویس استعلام تنظیم نشده است" };
  try {
    const res = await fetch("https://api.zibal.ir/v1/facility/shahkarInquiry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ mobile, nationalCode }),
      signal: AbortSignal.timeout(extTimeout(15000)),
      redirect: "error",
    });
    const body = await readJson(res);
    if (!body) return { ok: false, error: "پاسخ سرویس استعلام نامعتبر بود" };
    const result = Number(body.result);
    if (result !== 1) return { ok: false, error: ZIBAL_ERRORS[result] ?? `سرویس استعلام خطا داد (${String(body.message ?? result).slice(0, 80)})` };
    const d = body.data;
    const matched = d === true || (!!d && typeof d === "object" && ((d as Record<string, unknown>).matched === true || (d as Record<string, unknown>).isMatched === true));
    const ref = d && typeof d === "object" ? String((d as Record<string, unknown>).trackId ?? (d as Record<string, unknown>).track_id ?? "") : "";
    return { ok: true, matched, provider: "zibal", ref: ref.slice(0, 60) };
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, error: timeout ? "سرویس استعلام پاسخ نداد؛ کمی بعد دوباره تلاش کنید" : "اتصال به سرویس استعلام برقرار نشد" };
  }
}
