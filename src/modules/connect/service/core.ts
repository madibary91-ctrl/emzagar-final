import { EMAIL_RE } from "@/modules/tenancy/service";
import { and, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { db } from "@/db";
import { isPrivateIp } from "@/lib/ssrf";
import net from "node:net";
import { wpConnections } from "@/db/schema";

/**
 * اتصال بدون تنظیم (Zero-Config) افزونه‌ی وردپرس
 * ───────────────────────────────────────────────
 * ۱) register : افزونه اطلاعات سایت را می‌فرستد؛ ابر یک «چالش» تصادفی می‌سازد.
 * ۲) افزونه چالش را روی مسیر REST خودش (/wp-json/emzagar/v1/verify) در دسترس می‌گذارد.
 * ۳) complete : ابر همان مسیر را از بیرون فراخوانی می‌کند؛ اگر چالش برگردد، مالکیت دامنه ثابت شده است.
 * ۴) فضای کاری + قالب‌های نمونه + کلید API ساخته می‌شود و کلید فقط یک‌بار به سرور وردپرس تحویل می‌شود.
 *
 * کاربر نهایی هیچ‌چیزی کپی/وارد نمی‌کند.
 */

export const HANDSHAKE_TTL_MS = 15 * 60_000;
export const PAIRING_TTL_MS = 7 * 24 * 3600_000;
export const SSO_TTL_MS = 90_000;
export class ConnectError extends Error {
  constructor(public code: string, public status = 422, message?: string) {
    super(message ?? code);
  }
}
export type RegisterInput = {
  installId: string;
  siteUrl: string;
  siteName: string;
  adminEmail: string;
  adminName: string;
  pluginVersion: string;
  wpVersion: string;
  wcActive: boolean;
  locale: string;
  pairing?: string;
};
export type HandshakeData = RegisterInput & { challenge: string; host: string; pairingHash?: string };
const CTRL = /[\u0000-\u001f\u007f]/g;
export const clean = (v: unknown, max: number) => String(v ?? "").replace(CTRL, " ").trim().slice(0, max);
/** آدرس سایت وردپرس را نرمال می‌کند: فقط http(s)، بدون اسلش پایانی، بدون کوئری و هش */
export function normalizeSiteUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new ConnectError("site_url_invalid");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConnectError("site_url_invalid");
  if (u.username || u.password) throw new ConnectError("site_url_invalid");
  u.search = "";
  u.hash = "";
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u;
}
/**
 * سایت‌های «واقعاً محلی/آزمایشی» که ابر نمی‌تواند به آن‌ها دسترسی بگیرد (localhost، IP خصوصی، پسوندهای رزروشده).
 * پروتکل ملاک نیست: یک آدرس http:// روی دامنه‌ی عمومی «محلی» نیست و باید مالکیت دامنه‌اش تایید شود
 * (در غیر این صورت هر کسی با ثبت یک آدرس http جعلی، بی‌نهایت فضای کاری و کلید API می‌ساخت — SEC-03).
 */
export function isLocalSite(u: URL): boolean {
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (net.isIP(host)) return isPrivateIp(host);
  return host === "localhost" || !host.includes(".") || /\.(local|localhost|test|internal|lan|example|invalid)$/.test(host);
}
/**
 * حالت Sandbox (اتصال بدون تایید دامنه برای سایت محلی) فقط برای توسعه/آزمون است و روی سرور production به‌طور
 * پیش‌فرض «خاموش» است؛ در production سایت محلی فقط با «کد جفت‌سازی» حساب کاربری اتصال می‌گیرد.
 * اگر واقعاً لازم بود، مدیر سرور با ALLOW_SANDBOX_CONNECT=1 آن را آگاهانه روشن می‌کند.
 */
export function sandboxConnectAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_SANDBOX_CONNECT === "1";
}
/** سقف روزانه‌ی اتصال‌های تایید‌نشده (Sandbox) در کل سامانه؛ حتی با روشن بودن Sandbox، ساخت بی‌نهایت فضای کاری ممکن نیست */
const SANDBOX_DAILY_CAP = Number(process.env.SANDBOX_DAILY_CAP) > 0 ? Number(process.env.SANDBOX_DAILY_CAP) : 50;
export async function assertSandboxQuota(): Promise<void> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(wpConnections)
    .where(and(eq(wpConnections.verified, false), sql`${wpConnections.createdAt} > now() - interval '1 day'`));
  if ((row?.n ?? 0) >= SANDBOX_DAILY_CAP) throw new ConnectError("sandbox_quota", 429, "سقف روزانه‌ی اتصال آزمایشی پر شده است؛ دامنه‌ی خود را تایید کنید.");
}
export function parseInput(raw: unknown): { input: RegisterInput; url: URL } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const installId = clean(b.installId, 64);
  if (!/^[a-f0-9]{32}$/.test(installId)) throw new ConnectError("install_id_invalid");
  const url = normalizeSiteUrl(String(b.siteUrl || ""));
  const adminEmail = clean(b.adminEmail, 200).toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) throw new ConnectError("admin_email_invalid");
  const pairing = clean(b.pairing, 80);
  if (pairing && !/^emzp_[a-f0-9]{40}$/.test(pairing)) throw new ConnectError("pairing_invalid");
  const siteName = clean(b.siteName, 60) || url.hostname;
  return {
    url,
    input: {
      installId,
      siteUrl: url.origin + url.pathname,
      siteName,
      adminEmail,
      adminName: clean(b.adminName, 100) || siteName,
      pluginVersion: clean(b.pluginVersion, 20),
      wpVersion: clean(b.wpVersion, 20),
      wcActive: b.wcActive === true,
      locale: clean(b.locale, 20),
      pairing: pairing || undefined,
    },
  };
}
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
