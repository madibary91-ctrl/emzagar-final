import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as licensePOST } from "@/app/api/license/v1/check/route";
import { POST as updatePOST } from "@/app/api/updates/v1/check/route";
import { POST as downloadPOST } from "@/app/api/updates/v1/download/route";
import { activateLicense, getLicenseInfo, refreshLicense, removeLicense } from "@/modules/license/client";
import { checkForUpdate, installUpdate, updateSupport } from "@/modules/license/updater";
import { getServerKeys, issueLicense, listLicenses, RELEASES_DIR, saveRelease, setLicenseStatus, releaseActivation, licenseServerEnabled } from "@/modules/license/server";
import { signPayload } from "@/modules/license/crypto";

const handlers: Record<string, (r: Request) => Promise<Response>> = {
  "/api/license/v1/check": licensePOST,
  "/api/updates/v1/check": updatePOST,
  "/api/updates/v1/download": downloadPOST,
};
let tamper: ((body: { payload: string; sig: string }) => unknown) | null = null;
let offline = false;

beforeAll(async () => {
  process.env.LICENSE_SERVER_ENABLED = "1";
  process.env.LICENSE_SERVER_URL = "http://license.test";
  const keys = await getServerKeys();
  process.env.LICENSE_PUBLIC_KEY = keys.publicKey;
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (offline) throw new TypeError("fetch failed");
    const u = new URL(String(input));
    const h = handlers[u.pathname];
    if (!h) throw new Error(`no route ${u.pathname}`);
    const res = await h(new Request(u, init));
    if (tamper && res.headers.get("content-type")?.includes("json")) return new Response(JSON.stringify(tamper(await res.json())), { status: res.status, headers: { "content-type": "application/json" } });
    return res;
  });
});
afterEach(() => {
  tamper = null;
  offline = false;
});
afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.LICENSE_SERVER_ENABLED;
  delete process.env.LICENSE_PUBLIC_KEY;
  process.env.APP_URL = "http://localhost:3000";
});

const useDomain = (d: string) => void (process.env.APP_URL = `https://${d}`);

describe("سرور و کلاینت لایسنس", () => {
  it("سرور فقط با LICENSE_SERVER_ENABLED=1 فعال است", async () => {
    expect(licenseServerEnabled()).toBe(true);
    delete process.env.LICENSE_SERVER_ENABLED;
    const res = await licensePOST(new Request("http://x/api/license/v1/check", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
    process.env.LICENSE_SERVER_ENABLED = "1";
  });

  it("فعال‌سازی: کلید نامعتبر رد، کلید درست پذیرفته و پاسخ امضاشده تایید می‌شود", async () => {
    useDomain("shop-a.example.com");
    expect((await activateLicense("bad")).ok).toBe(false);
    const unknown = await activateLicense("EMZ-AAAAA-BBBBB-CCCCC-DDDDD");
    expect(unknown).toMatchObject({ ok: false });
    const lic = await issueLicense({ customerName: "فروشگاه الف", customerEmail: "a@example.com", plan: "standard", maxDomains: 1, expiresInDays: null, updatesInDays: 365, notes: "" });
    const r = await activateLicense(lic.key, undefined, undefined);
    expect(r.ok).toBe(true);
    const info = await getLicenseInfo();
    expect(info).toMatchObject({ state: "active", licensed: true, verified: true, customer: "فروشگاه الف", domain: "shop-a.example.com", usedDomains: 1, maxDomains: 1 });
    expect(info.keyMasked).not.toContain(lic.key);
  });

  it("پاسخ دستکاری‌شده یا امضای سرور جعلی رد می‌شود (حتی «معتبر» جعلی)", async () => {
    const lic = (await listLicenses())[0];
    useDomain("shop-a.example.com");
    tamper = (b) => ({ ...b, payload: b.payload.replace('"valid":true', '"valid":false') });
    const bad = await activateLicense(lic.key);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/امضا/);
    // سرور جعلی با کلید دیگر
    const fake = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    tamper = (b) => signPayload({ ...JSON.parse(b.payload), valid: true }, fake);
    expect((await activateLicense(lic.key)).ok).toBe(false);
  });

  it("سقف دامنه، آزادسازی، ابطال و تعلیق", async () => {
    const lic = (await listLicenses())[0];
    useDomain("shop-b.example.com");
    const second = await activateLicense(lic.key);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/ظرفیت/);
    // آزادسازی دامنه‌ی اول ⇒ دامنه‌ی دوم می‌تواند فعال شود
    await releaseActivation(lic.activations[0].id);
    expect((await activateLicense(lic.key)).ok).toBe(true);
    // ابطال سمت فروشنده ⇒ بررسی بعدی نتیجه را تغییر می‌دهد
    await setLicenseStatus(lic.id, "revoked");
    expect((await refreshLicense()).state).toBe("revoked");
    await setLicenseStatus(lic.id, "suspended");
    expect((await refreshLicense()).state).toBe("suspended");
    await setLicenseStatus(lic.id, "active");
    expect((await refreshLicense()).state).toBe("active");
  });

  it("قطعی سرور: وضعیت قبلی حفظ می‌شود (مهلت آفلاین) و خطا ثبت می‌شود", async () => {
    offline = true;
    const info = await refreshLicense();
    expect(info.state).toBe("active");
    expect(info.lastError).toMatch(/ارتباط|سرور/);
  });

  it("به‌روزرسانی: نسخه‌ی جدید با مانیفست امضاشده، دانلود و کنترل SHA-256", async () => {
    // بدون نسخه‌ی منتشرشده
    expect((await checkForUpdate()).updateAvailable).toBe(false);
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
    const content = Buffer.concat([Buffer.from("PK\u0003\u0004"), crypto.randomBytes(2000)]);
    fs.writeFileSync(path.join(RELEASES_DIR, "emzagar-99.1.0.zip"), content);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    await saveRelease({ version: "99.1.0", channel: "stable", changelog: "رفع باگ‌ها", security: true, fileName: "emzagar-99.1.0.zip", sha256: sha, size: content.length });
    const info = await checkForUpdate();
    expect(info.updateAvailable).toBe(true);
    expect(info.latest).toMatchObject({ version: "99.1.0", sha256: sha, security: true });

    const lic = (await listLicenses())[0];
    const dl = await downloadPOST(new Request("http://x/api/updates/v1/download", { method: "POST", body: JSON.stringify({ key: lic.key, domain: "shop-b.example.com", version: "99.1.0" }) }));
    expect(dl.status).toBe(200);
    expect(crypto.createHash("sha256").update(Buffer.from(await dl.arrayBuffer())).digest("hex")).toBe(sha);
    // کلید باطل ⇒ دانلود ممنوع
    await setLicenseStatus(lic.id, "revoked");
    const denied = await downloadPOST(new Request("http://x/api/updates/v1/download", { method: "POST", body: JSON.stringify({ key: lic.key, domain: "shop-b.example.com", version: "99.1.0" }) }));
    expect(denied.status).toBe(403);
    await setLicenseStatus(lic.id, "active");
  });

  it("نصب خودکار در محیط غیر-release امن رد می‌شود و چیزی تغییر نمی‌کند", async () => {
    expect(updateSupport().supported).toBe(false);
    const r = await installUpdate(1);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), ".update-staging"))).toBe(false);
  });

  it("حذف لایسنس: وضعیت به «فعال‌نشده» برمی‌گردد", async () => {
    await removeLicense();
    expect((await getLicenseInfo()).state).toBe("unlicensed");
    expect((await checkForUpdate()).error).toMatch(/لایسنس/);
  });
});
