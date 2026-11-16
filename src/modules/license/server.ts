import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { appReleases, licenseActivations, licenseKeys } from "@/db/schema";
import { STORAGE_DIR } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { compareVersions, isValidVersion, PRODUCT_ID } from "@/lib/version";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { generateKeyPair, isDevDomain, newLicenseKey, normalizeDomain, signPayload, type Signed } from "./crypto";

/**
 * «سرور لایسنس» فروشنده. همان کدبیس است و فقط وقتی LICENSE_SERVER_ENABLED=1 باشد فعال می‌شود
 * (روی سایت خریداران خاموش است و مسیرهای آن ۴۰۴ می‌دهد).
 */
export const licenseServerEnabled = () => process.env.LICENSE_SERVER_ENABLED === "1";

export const RELEASES_DIR = path.join(STORAGE_DIR, "releases");

/** کلید امضای سرور: متغیر محیطی LICENSE_PRIVATE_KEY، وگرنه یک‌بار ساخته و رمزنگاری‌شده در دیتابیس نگه‌داری می‌شود */
export async function getServerKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const env = (process.env.LICENSE_PRIVATE_KEY || "").trim();
  if (env) {
    const raw = env.replace(/\\n/g, "\n");
    const pem = raw.includes("BEGIN") ? raw : `-----BEGIN PRIVATE KEY-----\n${raw}\n-----END PRIVATE KEY-----`;
    const pub = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: "spki", format: "pem" }).toString();
    return { privateKey: pem, publicKey: pub };
  }
  const stored = decryptSecret(await getGlobalSetting("license_server_private_key"));
  const pub = await getGlobalSetting("license_server_public_key");
  if (stored && pub) return { privateKey: stored, publicKey: pub };
  const kp = generateKeyPair();
  await saveGlobalSetting("license_server_private_key", encryptSecret(kp.privateKey));
  await saveGlobalSetting("license_server_public_key", kp.publicKey);
  return kp;
}

/* ───────── صدور و مدیریت لایسنس ───────── */

export const PLANS = { standard: "استاندارد", extended: "گسترده", enterprise: "سازمانی" } as const;
export type LicensePlan = keyof typeof PLANS;

export async function issueLicense(p: { customerName: string; customerEmail: string; plan: LicensePlan; maxDomains: number; expiresInDays: number | null; updatesInDays: number | null; notes: string }) {
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    try {
      const [row] = await db
        .insert(licenseKeys)
        .values({
          key: newLicenseKey(),
          customerName: p.customerName.slice(0, 120),
          customerEmail: p.customerEmail.slice(0, 160),
          plan: p.plan,
          maxDomains: Math.min(500, Math.max(1, Math.round(p.maxDomains))),
          notes: p.notes.slice(0, 500),
          expiresAt: p.expiresInDays ? new Date(now + p.expiresInDays * 86400_000) : null,
          updatesUntil: p.updatesInDays ? new Date(now + p.updatesInDays * 86400_000) : null,
        })
        .returning();
      return row;
    } catch (e) {
      if (i === 4) throw e;
    }
  }
  throw new Error("صدور لایسنس ناموفق بود");
}

export async function listLicenses() {
  const rows = await db.select().from(licenseKeys).orderBy(desc(licenseKeys.id)).limit(300);
  const acts = await db.select().from(licenseActivations).orderBy(desc(licenseActivations.lastSeenAt)).limit(2000);
  return rows.map((l) => ({ ...l, activations: acts.filter((a) => a.licenseId === l.id) }));
}

export async function setLicenseStatus(id: number, status: "active" | "suspended" | "revoked") {
  await db.update(licenseKeys).set({ status }).where(eq(licenseKeys.id, id));
}

export async function releaseActivation(activationId: number) {
  await db.delete(licenseActivations).where(eq(licenseActivations.id, activationId));
}

/* ───────── بررسی لایسنس (فراخوانی از برنامه‌ی خریدار) ───────── */

export interface LicenseVerdict {
  valid: boolean;
  status: "active" | "suspended" | "revoked" | "expired" | "invalid" | "domain_limit";
  plan: string;
  customer: string;
  domain: string;
  expiresAt: string | null;
  updatesUntil: string | null;
  maxDomains: number;
  usedDomains: number;
}

export async function evaluateLicense(p: { key: string; domain: string; instanceId: string; version: string; ip: string; touch: boolean }): Promise<LicenseVerdict> {
  const domain = normalizeDomain(p.domain);
  const blank: LicenseVerdict = { valid: false, status: "invalid", plan: "", customer: "", domain, expiresAt: null, updatesUntil: null, maxDomains: 0, usedDomains: 0 };
  const [lic] = await db.select().from(licenseKeys).where(eq(licenseKeys.key, p.key.trim().toUpperCase()));
  if (!lic) return blank;
  const base = { plan: lic.plan, customer: lic.customerName, domain, expiresAt: lic.expiresAt?.toISOString() ?? null, updatesUntil: lic.updatesUntil?.toISOString() ?? null, maxDomains: lic.maxDomains };
  const [{ n }] = await db.select({ n: count() }).from(licenseActivations).where(eq(licenseActivations.licenseId, lic.id));
  const out = (status: LicenseVerdict["status"], usedDomains = n): LicenseVerdict => ({ ...base, valid: status === "active", status, usedDomains });

  if (lic.status === "revoked") return out("revoked");
  if (lic.status === "suspended") return out("suspended");
  if (lic.expiresAt && lic.expiresAt.getTime() < Date.now()) return out("expired");

  const [existing] = await db.select().from(licenseActivations).where(and(eq(licenseActivations.licenseId, lic.id), eq(licenseActivations.domain, domain)));
  if (!existing && !isDevDomain(domain)) {
    if (n >= lic.maxDomains) return out("domain_limit");
  }
  if (p.touch && !isDevDomain(domain)) {
    await db
      .insert(licenseActivations)
      .values({ licenseId: lic.id, domain, instanceId: p.instanceId.slice(0, 64), version: p.version.slice(0, 20), ip: p.ip.slice(0, 64) })
      .onConflictDoUpdate({ target: [licenseActivations.licenseId, licenseActivations.domain], set: { lastSeenAt: new Date(), version: p.version.slice(0, 20), instanceId: p.instanceId.slice(0, 64), ip: p.ip.slice(0, 64) } });
    await db.update(licenseKeys).set({ lastCheckAt: new Date() }).where(eq(licenseKeys.id, lic.id));
  }
  const [{ n: used }] = await db.select({ n: count() }).from(licenseActivations).where(eq(licenseActivations.licenseId, lic.id));
  return out("active", used);
}

export async function deactivateDomain(key: string, domain: string): Promise<boolean> {
  const [lic] = await db.select().from(licenseKeys).where(eq(licenseKeys.key, key.trim().toUpperCase()));
  if (!lic) return false;
  await db.delete(licenseActivations).where(and(eq(licenseActivations.licenseId, lic.id), eq(licenseActivations.domain, normalizeDomain(domain))));
  return true;
}

/** پاسخ امضاشده‌ی بررسی لایسنس؛ nonce همان مقدار درخواست است (جلوگیری از بازپخش پاسخ قدیمی) */
export async function signedVerdict(verdict: LicenseVerdict, nonce: string): Promise<Signed> {
  const keys = await getServerKeys();
  return signPayload({ product: PRODUCT_ID, ...verdict, nonce, issuedAt: new Date().toISOString() }, keys.privateKey);
}

/* ───────── انتشار نسخه ───────── */

export async function listReleases() {
  return db.select().from(appReleases).orderBy(desc(appReleases.publishedAt)).limit(100);
}

export function releaseFilePath(fileName: string): string {
  const safe = path.basename(fileName);
  return path.join(RELEASES_DIR, safe);
}

export async function saveRelease(p: { version: string; channel: string; changelog: string; security: boolean; fileName: string; sha256: string; size: number }) {
  if (!isValidVersion(p.version)) throw new Error("قالب نسخه نامعتبر است (مثل 2.1.0)");
  await db
    .insert(appReleases)
    .values({ version: p.version, channel: p.channel === "beta" ? "beta" : "stable", changelog: p.changelog.slice(0, 5000), security: p.security, fileName: p.fileName, sha256: p.sha256, size: p.size })
    .onConflictDoUpdate({ target: appReleases.version, set: { channel: p.channel === "beta" ? "beta" : "stable", changelog: p.changelog.slice(0, 5000), security: p.security, fileName: p.fileName, sha256: p.sha256, size: p.size, yanked: false } });
}

export async function setReleaseYanked(id: number, yanked: boolean) {
  await db.update(appReleases).set({ yanked }).where(eq(appReleases.id, id));
}

/** جدیدترین نسخه‌ی مجاز برای این لایسنس و کانال */
export async function latestReleaseFor(p: { currentVersion: string; channel: string; updatesUntil: Date | null }) {
  const all = await db.select().from(appReleases).where(eq(appReleases.yanked, false));
  const eligible = all
    .filter((r) => r.fileName && (p.channel === "beta" || r.channel === "stable"))
    // پشتیبانی/به‌روزرسانی تا تاریخ مشخص: فقط نسخه‌هایی که پیش از آن منتشر شده‌اند
    .filter((r) => !p.updatesUntil || r.publishedAt.getTime() <= p.updatesUntil.getTime())
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = eligible[0];
  return { latest, updateAvailable: !!latest && compareVersions(latest.version, p.currentVersion) > 0 };
}

export async function releaseByVersion(version: string) {
  const [r] = await db.select().from(appReleases).where(eq(appReleases.version, version));
  return r;
}

/** SHA-256 فایل روی دیسک (استریم) */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}
