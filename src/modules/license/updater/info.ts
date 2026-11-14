import { APP_VERSION, compareVersions } from "@/lib/version";
import { parseManifest } from "./manifest";
import { ROOT } from "./paths";
import { callLicenseServer, lastCheckedUpdateAt, resolveDomain } from "../client";
import { decryptSecret } from "@/lib/crypto";
import fs from "node:fs";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import path from "node:path";

export interface UpdateSupport {
  supported: boolean;
  reason: string;
}
export function updateSupport(): UpdateSupport {
  if (process.env.EMZ_UPDATER_DISABLED === "1") return { supported: false, reason: "به‌روزرسانی از داخل پنل توسط مدیر سرور غیرفعال شده است." };
  if (fs.existsSync("/.dockerenv") && process.env.EMZ_UPDATER_FORCE !== "1") {
    return { supported: false, reason: "این نصب در Docker اجرا می‌شود؛ برای به‌روزرسانی ایمیج را بگیرید: docker compose pull && docker compose up -d (داده‌ها حفظ می‌شود)." };
  }
  if (!fs.existsSync(path.join(ROOT, "server.js"))) return { supported: false, reason: "این نصب از «بسته‌ی آماده‌ی release» نیست (حالت سورس/توسعه). به‌روزرسانی را با git pull و build انجام دهید." };
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
  } catch {
    return { supported: false, reason: "پوشه‌ی برنامه روی سرور قابل نوشتن نیست." };
  }
  return { supported: true, reason: "" };
}
export interface UpdateInfo {
  checkedAt: string | null;
  updateAvailable: boolean;
  latest: { version: string; changelog: string; publishedAt: string; size: number; sha256: string; security: boolean } | null;
  error: string | null;
  current: string;
}
export async function getUpdateInfo(): Promise<UpdateInfo> {
  try {
    const raw = await getGlobalSetting("update_state");
    if (raw) {
      const s = JSON.parse(raw) as Omit<UpdateInfo, "current">;
      // C-01: حتی داده‌ی ذخیره‌شده در دیتابیس دوباره اعتبارسنجی می‌شود (ردیف قدیمی/دستکاری‌شده)
      s.latest = parseManifest(s.latest);
      // اگر نسخه‌ی ثبت‌شده از نسخه‌ی فعلی بالاتر نیست، به‌روزرسانی در دسترس نیست
      const available = !!s.latest && compareVersions(s.latest.version, APP_VERSION) > 0;
      return { ...s, updateAvailable: available && s.updateAvailable, current: APP_VERSION };
    }
  } catch {
    /* خراب */
  }
  return { checkedAt: null, updateAvailable: false, latest: null, error: null, current: APP_VERSION };
}
export async function saveUpdateState(s: Omit<UpdateInfo, "current">) {
  await saveGlobalSetting("update_state", JSON.stringify(s));
}
export const licenseKey = async () => decryptSecret(await getGlobalSetting("license_key"));
/** بررسی نسخه‌ی جدید از سرور فروشنده */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const key = await licenseKey();
  if (!key) {
    const s = { checkedAt: new Date().toISOString(), updateAvailable: false, latest: null, error: "برای دریافت به‌روزرسانی ابتدا لایسنس را فعال کنید." };
    await saveUpdateState(s);
    return { ...s, current: APP_VERSION };
  }
  try {
    const r = await callLicenseServer("/api/updates/v1/check", { key, domain: await resolveDomain(), version: APP_VERSION, channel: process.env.UPDATE_CHANNEL === "beta" ? "beta" : "stable" });
    if (r.data.valid !== true) {
      const s = { checkedAt: new Date().toISOString(), updateAvailable: false, latest: null, error: "لایسنس معتبر نیست؛ وضعیت لایسنس را بررسی کنید." };
      await saveUpdateState(s);
      return { ...s, current: APP_VERSION };
    }
    // مانیفست فقط پس از امضای معتبر و اعتبارسنجی ساختاری (نسخه/هش/اندازه) ذخیره می‌شود
    const latest = parseManifest(r.data.latest);
    if (r.data.latest && !latest) throw new Error("مانیفست به‌روزرسانی نامعتبر است؛ نادیده گرفته شد.");
    const s = { checkedAt: new Date().toISOString(), updateAvailable: !!latest && r.data.updateAvailable === true && compareVersions(latest.version, APP_VERSION) > 0, latest, error: null };
    await saveUpdateState(s);
    return { ...s, current: APP_VERSION };
  } catch (e) {
    const prev = await getUpdateInfo();
    const s = { checkedAt: new Date().toISOString(), updateAvailable: prev.updateAvailable, latest: prev.latest, error: e instanceof Error ? e.message : "بررسی ناموفق بود" };
    await saveUpdateState(s);
    return { ...s, current: APP_VERSION };
  }
}
export async function checkUpdatesIfDue(): Promise<void> {
  if (!(await licenseKey())) return;
  if (Date.now() - (await lastCheckedUpdateAt()) < 23 * 3600_000) return;
  await checkForUpdate();
}
