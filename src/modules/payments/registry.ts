import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { SIM_MERCHANT_ID, simActive } from "@/lib/external";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { idpay } from "./gateways/idpay";
import { payir } from "./gateways/payir";
import { demoAllowed, sandboxGateway } from "./gateways/sandbox";
import { zarinpal } from "./gateways/zarinpal";
import { zibal } from "./gateways/zibal";
import { REAL_GATEWAY_IDS, isGatewayId, isRealGateway, type GatewayAdapter, type GatewayId, type RealGatewayId } from "./types";

/** ثبت آداپتورها؛ برای افزودن درگاه جدید فقط همین‌جا (و union نوع‌ها در types.ts) تغییر می‌کند */
const ADAPTERS: Record<GatewayId, GatewayAdapter> = { zarinpal, zibal, idpay, payir, sandbox: sandboxGateway };
export const getAdapter = (id: string): GatewayAdapter | null => (isGatewayId(id) ? ADAPTERS[id] : null);
export const realAdapters = (): GatewayAdapter[] => REAL_GATEWAY_IDS.map((id) => ADAPTERS[id]);

/* ───────── پیکربندی (تنظیمات سراسری پلتفرم) ───────── */
type StoredPrefs = { order: RealGatewayId[]; disabled: RealGatewayId[] };
const PREFS_KEY = "pay_gateways";
const credKey = (id: string) => `pay_cred_${id}`;

export async function getPrefs(): Promise<StoredPrefs> {
  try {
    const raw = JSON.parse((await getGlobalSetting(PREFS_KEY)) || "{}") as Partial<StoredPrefs>;
    const order = (Array.isArray(raw.order) ? raw.order : []).filter(isRealGateway);
    // درگاه‌هایی که در ترتیب ذخیره‌شده نیستند (مثلاً درگاه جدید) به انتها اضافه می‌شوند
    const full = [...new Set([...order, ...REAL_GATEWAY_IDS])] as RealGatewayId[];
    return { order: full, disabled: (Array.isArray(raw.disabled) ? raw.disabled : []).filter(isRealGateway) };
  } catch {
    return { order: [...REAL_GATEWAY_IDS], disabled: [] };
  }
}

export async function savePrefs(p: StoredPrefs) {
  await saveGlobalSetting(PREFS_KEY, JSON.stringify({ order: p.order.filter(isRealGateway), disabled: p.disabled.filter(isRealGateway) }));
}

/** اعتبارنامه: ابتدا مقدار ذخیره‌شده در پنل (رمزنگاری‌شده)، سپس متغیر محیطی؛ با شبیه‌ساز فعال، مرچنت ساختگی زرین‌پال */
export async function credentialFor(id: GatewayId): Promise<{ value: string; source: "panel" | "env" | "sim" | "none" }> {
  if (id === "sandbox") return { value: "sandbox", source: "sim" };
  const a = ADAPTERS[id];
  const stored = decryptSecret(await getGlobalSetting(credKey(id))).trim();
  if (stored && a.isValidCredential(stored)) return { value: stored, source: "panel" };
  const env = (process.env[a.envVar] || "").trim();
  if (env && a.isValidCredential(env)) return { value: env, source: "env" };
  if (id === "zarinpal" && simActive()) return { value: SIM_MERCHANT_ID, source: "sim" };
  return { value: "", source: "none" };
}

export async function saveCredential(id: RealGatewayId, value: string): Promise<{ ok: boolean; error?: string }> {
  const v = value.trim();
  if (v && !ADAPTERS[id].isValidCredential(v)) return { ok: false, error: `${ADAPTERS[id].credentialLabel} معتبر نیست` };
  await saveGlobalSetting(credKey(id), v ? encryptSecret(v) : "");
  return { ok: true };
}

/* ───────── سلامت درگاه (Circuit Breaker در حافظه) ─────────
 * پس از ۳ خرابی «قطعی/تایم‌اوت» پشت‌سرهم، درگاه ۳ دقیقه از انتخاب خودکار کنار می‌رود
 * و کاربران به درگاه بعدی هدایت می‌شوند. با اولین موفقیت دوباره سالم حساب می‌شود. */
type Health = { failures: number; openUntil: number; lastError: string; lastAt: number };
const g = globalThis as typeof globalThis & { __payHealth?: Map<string, Health> };
const health = (g.__payHealth ??= new Map<string, Health>());
const TRIP_AFTER = 3;
const OPEN_MS = 3 * 60_000;

export function recordGatewayResult(id: string, ok: boolean, error = "") {
  const h = health.get(id) ?? { failures: 0, openUntil: 0, lastError: "", lastAt: 0 };
  h.lastAt = Date.now();
  if (ok) {
    h.failures = 0;
    h.openUntil = 0;
    h.lastError = "";
  } else {
    h.failures += 1;
    h.lastError = error.slice(0, 200);
    if (h.failures >= TRIP_AFTER) h.openUntil = Date.now() + OPEN_MS;
  }
  health.set(id, h);
}

export function gatewayHealth(id: string): { degraded: boolean; failures: number; lastError: string; retryInSec: number } {
  const h = health.get(id);
  const now = Date.now();
  const degraded = !!h && h.openUntil > now;
  return { degraded, failures: h?.failures ?? 0, lastError: h?.lastError ?? "", retryInSec: degraded ? Math.ceil((h!.openUntil - now) / 1000) : 0 };
}

export function resetGatewayHealth() {
  health.clear();
}

/* ───────── فهرست درگاه‌های قابل‌استفاده ───────── */
export type GatewayStatus = {
  id: GatewayId;
  label: string;
  blurb: string;
  credentialLabel: string;
  envVar: string;
  configured: boolean;
  source: "panel" | "env" | "sim" | "none";
  enabled: boolean;
  /** درگاه در حال حاضر از انتخاب خودکار کنار گذاشته شده (چند خطای پشت‌سرهم) */
  degraded: boolean;
  lastError: string;
  retryInSec: number;
  priority: number;
};

/** وضعیت همه‌ی درگاه‌های واقعی به ترتیب اولویت (برای پنل مدیر) */
export async function listGatewayStatuses(): Promise<GatewayStatus[]> {
  const prefs = await getPrefs();
  return Promise.all(
    prefs.order.map(async (id, idx) => {
      const a = ADAPTERS[id];
      const cred = await credentialFor(id);
      const h = gatewayHealth(id);
      return { id, label: a.label, blurb: a.blurb, credentialLabel: a.credentialLabel, envVar: a.envVar, configured: !!cred.value, source: cred.source, enabled: !prefs.disabled.includes(id), degraded: h.degraded, lastError: h.lastError, retryInSec: h.retryInSec, priority: idx + 1 };
    }),
  );
}

export type CheckoutGateway = { id: GatewayId; label: string; blurb: string; degraded: boolean };

/** درگاه‌هایی که کاربر می‌تواند انتخاب کند. بدون هیچ درگاه واقعی: فقط در محیط توسعه، درگاه آزمایشی */
export async function availableGateways(): Promise<CheckoutGateway[]> {
  const list = (await listGatewayStatuses()).filter((s) => s.configured && s.enabled);
  if (list.length > 0) return list.map((s) => ({ id: s.id, label: s.label, blurb: s.blurb, degraded: s.degraded }));
  if (demoAllowed()) return [{ id: "sandbox", label: sandboxGateway.label, blurb: sandboxGateway.blurb, degraded: false }];
  return [];
}

/** حالت کلی برای نمایش: live (درگاه واقعی) | demo (آزمایشی) | none */
export async function checkoutMode(): Promise<"live" | "demo" | "none"> {
  const a = await availableGateways();
  if (a.length === 0) return "none";
  return a[0].id === "sandbox" ? "demo" : "live";
}

/** ترتیب تلاش: درگاه انتخابی کاربر اول، سپس بقیه به ترتیب اولویت؛ درگاه‌های ناسالم آخر صف می‌روند (ولی کاملاً حذف نمی‌شوند) */
export async function candidateOrder(preferred?: string): Promise<GatewayId[]> {
  const avail = await availableGateways();
  const healthy = avail.filter((g2) => !g2.degraded).map((g2) => g2.id);
  const sick = avail.filter((g2) => g2.degraded).map((g2) => g2.id);
  const rest = [...healthy, ...sick];
  if (preferred && rest.includes(preferred as GatewayId) && !sick.includes(preferred as GatewayId)) return [preferred as GatewayId, ...rest.filter((x) => x !== preferred)];
  return rest;
}
