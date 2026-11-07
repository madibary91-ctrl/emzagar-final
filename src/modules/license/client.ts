import crypto from "node:crypto";
import { getConfig } from "@/lib/config";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import { friendlyNetworkError } from "@/lib/external";
import { APP_VERSION, PRODUCT_ID } from "@/lib/version";
import { logAudit } from "@/modules/audit/service";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { embeddedPublicKey, LICENSE_KEY_RE, normalizeDomain, verifyText } from "./crypto";

/**
 * سمت خریدار: فعال‌سازی لایسنس، بررسی دوره‌ای، و نگهداری آخرین پاسخ امضاشده.
 * - پاسخ سرور با Ed25519 راستی‌آزمایی می‌شود (کلید عمومی فروشنده: LICENSE_PUBLIC_KEY).
 * - قطع بودن سرور لایسنس هرگز سایت خریدار را از کار نمی‌اندازد: تا ۱۴ روز از آخرین تأیید موفق «مهلت آفلاین» است.
 */
export const DEFAULT_LICENSE_SERVER = "https://license.emzagar.ir";
export const OFFLINE_GRACE_MS = 14 * 86400_000;
const STALE_MS = 3 * 86400_000;

export function licenseServerUrl(): string {
  const raw = (process.env.LICENSE_SERVER_URL || DEFAULT_LICENSE_SERVER).trim().replace(/\/+$/, "");
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "")) : DEFAULT_LICENSE_SERVER;
  } catch {
    return DEFAULT_LICENSE_SERVER;
  }
}

export type LicenseState = "unlicensed" | "active" | "grace_expired" | "expired" | "revoked" | "suspended" | "invalid" | "domain_limit";

export interface LicenseInfo {
  state: LicenseState;
  licensed: boolean;
  keyMasked: string;
  plan: string;
  customer: string;
  domain: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  maxDomains: number;
  usedDomains: number;
  checkedAt: string | null;
  /** آخرین تأیید موفق */
  okAt: string | null;
  stale: boolean;
  /** پاسخ سرور با کلید عمومی فروشنده راستی‌آزمایی شده است؟ */
  verified: boolean;
  lastError: string | null;
  serverUrl: string;
}

interface Stored {
  payload: string;
  sig: string;
  checkedAt: string;
  okAt: string | null;
  verified: boolean;
  error: string | null;
}

const readStored = async (): Promise<Stored | null> => {
  try {
    const raw = await getGlobalSetting("license_state");
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
};

async function getKey(): Promise<string> {
  return decryptSecret(await getGlobalSetting("license_key"));
}

export async function getInstanceId(): Promise<string> {
  let id = await getGlobalSetting("license_instance");
  if (!id) {
    id = crypto.randomBytes(12).toString("hex");
    await saveGlobalSetting("license_instance", id);
  }
  return id;
}

/** دامنه‌ی این نصب: APP_URL / آدرس ثبت‌شده‌ی نصب‌کننده / دامنه‌ی هنگام فعال‌سازی */
export async function resolveDomain(requestHost?: string): Promise<string> {
  const appUrl = getConfig().appUrl;
  if (appUrl) return normalizeDomain(appUrl);
  if (requestHost) return normalizeDomain(requestHost);
  return (await getGlobalSetting("license_domain")) || "localhost";
}

export async function getLicenseInfo(): Promise<LicenseInfo> {
  const key = await getKey();
  const base: LicenseInfo = {
    state: "unlicensed", licensed: false, keyMasked: key ? maskSecret(key) : "", plan: "", customer: "", domain: "", expiresAt: null, updatesUntil: null,
    maxDomains: 0, usedDomains: 0, checkedAt: null, okAt: null, stale: false, verified: false, lastError: null, serverUrl: licenseServerUrl(),
  };
  if (!key) return base;
  const st = await readStored();
  if (!st) return { ...base, state: "invalid" };
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(st.payload) as Record<string, unknown>;
  } catch {
    return { ...base, state: "invalid" };
  }
  const status = String(d.status || "invalid") as LicenseState;
  const okAge = st.okAt ? Date.now() - new Date(st.okAt).getTime() : Infinity;
  let state: LicenseState = status === "active" ? (okAge > OFFLINE_GRACE_MS ? "grace_expired" : "active") : status;
  // لایسنس دارای تاریخ پایان: حتی آفلاین هم پس از آن تاریخ منقضی است
  if (state === "active" && typeof d.expiresAt === "string" && new Date(d.expiresAt).getTime() < Date.now()) state = "expired";
  return {
    ...base,
    state,
    licensed: state === "active",
    plan: String(d.plan || ""),
    customer: String(d.customer || ""),
    domain: String(d.domain || ""),
    expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
    updatesUntil: typeof d.updatesUntil === "string" ? d.updatesUntil : null,
    maxDomains: Number(d.maxDomains) || 0,
    usedDomains: Number(d.usedDomains) || 0,
    checkedAt: st.checkedAt,
    okAt: st.okAt,
    stale: state === "active" && okAge > STALE_MS,
    verified: st.verified,
    lastError: st.error,
  };
}

export const isLicensed = async () => (await getLicenseInfo()).licensed;

/** تماس با سرور فروشنده + راستی‌آزمایی امضا و nonce */
export async function callLicenseServer(path: string, body: Record<string, unknown>): Promise<{ data: Record<string, unknown>; payload: string; sig: string; verified: boolean }> {
  const nonce = crypto.randomBytes(12).toString("hex");
  let res: Response;
  try {
    res = await fetch(`${licenseServerUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `${PRODUCT_ID}/${APP_VERSION}` },
      body: JSON.stringify({ ...body, nonce }),
      signal: AbortSignal.timeout(Number(process.env.LICENSE_TIMEOUT_MS) || 12_000),
      redirect: "error",
    });
  } catch (e) {
    throw new Error(friendlyNetworkError(e, "سرور لایسنس"));
  }
  if (res.status === 429) throw new Error("تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کنید");
  const json = (await res.json().catch(() => null)) as { ok?: boolean; payload?: string; sig?: string; error?: string } | null;
  if (!json?.ok || typeof json.payload !== "string" || typeof json.sig !== "string") throw new Error("پاسخ سرور لایسنس معتبر نیست");
  const pub = embeddedPublicKey();
  if (pub && !verifyText(json.payload, json.sig, pub)) throw new Error("امضای پاسخ سرور لایسنس معتبر نیست (احتمال سرور جعلی)");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json.payload) as Record<string, unknown>;
  } catch {
    throw new Error("پاسخ سرور لایسنس معتبر نیست");
  }
  if (data.nonce !== nonce || data.product !== PRODUCT_ID) throw new Error("پاسخ سرور لایسنس با درخواست مطابقت ندارد");
  return { data, payload: json.payload, sig: json.sig, verified: !!pub };
}

const MESSAGES: Record<string, string> = {
  invalid: "کلید لایسنس نامعتبر است",
  revoked: "این لایسنس باطل شده است",
  suspended: "این لایسنس موقتاً معلق است؛ با پشتیبانی تماس بگیرید",
  expired: "مدت این لایسنس تمام شده است",
};

export async function activateLicense(rawKey: string, requestHost?: string, actorId?: number): Promise<{ ok: true; info: LicenseInfo } | { ok: false; error: string }> {
  const key = rawKey.trim().toUpperCase();
  if (!LICENSE_KEY_RE.test(key)) return { ok: false, error: "قالب کلید لایسنس درست نیست (مثل EMZ-XXXXX-XXXXX-XXXXX-XXXXX)" };
  const domain = await resolveDomain(requestHost);
  try {
    const r = await callLicenseServer("/api/license/v1/check", { key, domain, instanceId: await getInstanceId(), version: APP_VERSION });
    const status = String(r.data.status || "invalid");
    if (r.data.valid !== true) {
      if (status === "domain_limit") return { ok: false, error: `ظرفیت دامنه‌های این لایسنس پر است (${Number(r.data.usedDomains) || 0} از ${Number(r.data.maxDomains) || 0}). از پنل فروشنده یک دامنه را آزاد کنید.` };
      return { ok: false, error: MESSAGES[status] ?? MESSAGES.invalid };
    }
    await saveGlobalSetting("license_key", encryptSecret(key));
    await saveGlobalSetting("license_domain", domain);
    await persist(r, true);
    await logAudit({ workspaceId: 0, userId: actorId ?? null, action: "license.activated", detail: `${maskSecret(key)} · ${domain}`, actor: actorId ? undefined : "system" }).catch(() => undefined);
    return { ok: true, info: await getLicenseInfo() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فعال‌سازی ناموفق بود" };
  }
}

async function persist(r: { payload: string; sig: string; verified: boolean }, ok: boolean) {
  const prev = await readStored();
  const now = new Date().toISOString();
  const stored: Stored = { payload: r.payload, sig: r.sig, verified: r.verified, checkedAt: now, okAt: ok ? now : prev?.okAt ?? null, error: null };
  await saveGlobalSetting("license_state", JSON.stringify(stored));
}

/** بررسی دوباره‌ی لایسنس (زمان‌بند روزانه یا دکمه‌ی «بررسی مجدد») */
export async function refreshLicense(): Promise<LicenseInfo> {
  const key = await getKey();
  if (!key) return getLicenseInfo();
  try {
    const r = await callLicenseServer("/api/license/v1/check", { key, domain: await resolveDomain(), instanceId: await getInstanceId(), version: APP_VERSION });
    await persist(r, r.data.valid === true);
  } catch (e) {
    // قطعی سرور: وضعیت قبلی حفظ می‌شود و فقط خطا ثبت می‌شود (مهلت آفلاین)
    const prev = await readStored();
    if (prev) await saveGlobalSetting("license_state", JSON.stringify({ ...prev, checkedAt: new Date().toISOString(), error: e instanceof Error ? e.message : "خطا" } satisfies Stored));
  }
  return getLicenseInfo();
}

export async function removeLicense(actorId?: number): Promise<void> {
  const key = await getKey();
  if (key) {
    // آزادسازی دامنه روی سرور (در صورت قطعی نادیده گرفته می‌شود)
    await fetch(`${licenseServerUrl()}/api/license/v1/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, domain: await resolveDomain(), action: "deactivate", nonce: crypto.randomBytes(8).toString("hex") }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    }).catch(() => undefined);
  }
  for (const k of ["license_key", "license_state", "update_state"]) await saveGlobalSetting(k, "");
  await logAudit({ workspaceId: 0, userId: actorId ?? null, action: "license.removed", detail: "" }).catch(() => undefined);
}

/** بررسی روزانه (از زمان‌بند داخلی) */
export async function refreshLicenseIfDue(): Promise<void> {
  if (!(await getKey())) return;
  const st = await readStored();
  if (st && Date.now() - new Date(st.checkedAt).getTime() < 23 * 3600_000) return;
  await refreshLicense();
}

export async function lastCheckedUpdateAt(): Promise<number> {
  try {
    const raw = await getGlobalSetting("update_state");
    return raw ? new Date((JSON.parse(raw) as { checkedAt?: string }).checkedAt || 0).getTime() : 0;
  } catch {
    return 0;
  }
}
