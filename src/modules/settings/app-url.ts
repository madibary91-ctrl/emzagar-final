import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { trustedAppOrigin } from "@/lib/config";
import { isTrustedHostName } from "@/lib/origin";
import { getSecret } from "@/lib/secret";

/**
 * M-08 — «آدرس سایت» (app_url) هر فضای کاری پایه‌ی لینک‌های امضا/پرداخت/دعوت است و توکن امضای ۲۵۶ بیتی داخل آن می‌نشیند.
 * اگر مدیر یک فضای کاری بتواند هر دامنه‌ای بگذارد، پلتفرم (برند، SMTP و پیامک پلتفرم) به ابزار فیشینگ تبدیل می‌شود.
 *
 * قاعده‌ی جدید (fail-closed): یک app_url فقط وقتی «مؤثر» است که
 *   ۱) همان آدرس مورد اعتماد پلتفرم باشد (APP_URL نصب‌کننده / TRUSTED_HOSTS)، یا
 *   ۲) مالکیت دامنه با رکورد DNS TXT اثبات شده و «گواهی HMAC» آن (`app_url_proof`) معتبر باشد.
 * در غیر این صورت به آدرس مورد اعتماد پلتفرم برمی‌گردیم (نه دامنه‌ی مهاجم). این بررسی در «لایه‌ی خواندن تنظیمات» است؛
 * پس داده‌ی آلوده‌ی قبلی در دیتابیس و هر مسیر آینده‌ای که از cfg.app_url بخواند هم خودکار امن است.
 *
 * گواهی بدون جدول اضافه و stateless است: HMAC(SESSION_SECRET, workspace + origin). مدیر فضای کاری راز را ندارد و فرم نمی‌تواند آن را بنویسد.
 */
export const APP_URL_CHALLENGE_LABEL = "_emzagar-challenge";

const hmac = (label: string) => crypto.createHmac("sha256", getSecret()).update(label).digest("hex");
export const appUrlProofOf = (workspaceId: number, origin: string) => hmac(`app_url:${workspaceId}:${origin}`);
/** مقدار رکورد TXT که مالک دامنه باید بگذارد */
export const appUrlChallengeValue = (workspaceId: number, host: string) => `emzagar-verify=${hmac(`app_url_dns:${workspaceId}:${host}`).slice(0, 40)}`;

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** آیا origin همان آدرس مورد اعتماد پلتفرم است (نصب‌کننده یا TRUSTED_HOSTS)؟ */
export function isPlatformOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const fixed = trustedAppOrigin();
  if (fixed) {
    try {
      if (new URL(fixed).origin === u.origin) return true;
    } catch {
      /* نامعتبر */
    }
  }
  return isTrustedHostName(u.host);
}

/** آدرسی که واقعاً برای ساخت لینک استفاده می‌شود */
export function effectiveAppUrl(workspaceId: number, stored: string, proof: string): string {
  const raw = (stored || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    return trustedAppOrigin();
  }
  if (isPlatformOrigin(origin)) return origin;
  if (proof && safeEq(proof, appUrlProofOf(workspaceId, origin))) return origin;
  return trustedAppOrigin();
}

export type OwnershipResult = { ok: true; proof: string } | { ok: false; error: string };

/** هنگام ذخیره: دامنه باید HTTPS، عمومی و با TXT تأییدشده باشد (مگر آدرس خود پلتفرم) */
export async function verifyAppUrlOwnership(workspaceId: number, rawOrigin: string): Promise<OwnershipResult> {
  let u: URL;
  try {
    u = new URL(rawOrigin);
  } catch {
    return { ok: false, error: "آدرس سایت نامعتبر است" };
  }
  const origin = u.origin;
  if (isPlatformOrigin(origin)) return { ok: true, proof: appUrlProofOf(workspaceId, origin) };
  if (u.protocol !== "https:") return { ok: false, error: "آدرس سایت باید HTTPS باشد (فقط آدرس خود پلتفرم می‌تواند غیر HTTPS باشد)" };
  const host = u.hostname.toLowerCase();
  if (net.isIP(host) || !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    return { ok: false, error: "آدرس سایت باید یک نام دامنه‌ی عمومی باشد (نه IP یا نام داخلی)" };
  }
  const expected = appUrlChallengeValue(workspaceId, host);
  const records = await dns.resolveTxt(`${APP_URL_CHALLENGE_LABEL}.${host}`).catch(() => [] as string[][]);
  if (records.some((r) => r.join("").trim() === expected)) return { ok: true, proof: appUrlProofOf(workspaceId, origin) };
  return {
    ok: false,
    error: `مالکیت دامنه تأیید نشد. برای جلوگیری از سوءاستفاده‌ی فیشینگ، یک رکورد DNS از نوع TXT با نام «${APP_URL_CHALLENGE_LABEL}.${host}» و مقدار «${expected}» بسازید، چند دقیقه صبر کنید و دوباره ذخیره کنید.`,
  };
}
