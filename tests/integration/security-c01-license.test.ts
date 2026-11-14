import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateLicense, callLicenseServer, getLicenseInfo, licenseServerUrl, DEFAULT_LICENSE_SERVER, removeLicense } from "@/modules/license/client";
import { generateKeyPair, signPayload, trustedPublicKey } from "@/modules/license/crypto";
import { checkForUpdate } from "@/modules/license/updater";
import { parseManifest, updateZipPath } from "@/modules/license/updater/manifest";
import { download } from "@/modules/license/updater/package";
import { UPDATES_DIR } from "@/modules/license/updater/paths";
import { saveGlobalSetting } from "@/modules/settings/service";
import { encryptSecret } from "@/lib/crypto";
import { PRODUCT_ID } from "@/lib/version";

/**
 * C-01 — زنجیره‌ی لایسنس/به‌روزرسانی باید «بسته شکست بخورد» (fail-closed):
 * بدون کلید عمومی معتبر هیچ پاسخی، مانیفستی یا نسخه‌ای پذیرفته نمی‌شود؛ نسخه/هش/اندازه‌ی مانیفست ورودی بیرونی است؛
 * مسیر دانلود نمی‌تواند از UPDATES_DIR بیرون برود؛ و نشانی سرور در production فقط HTTPS است.
 */
const KEY = "EMZ-AAAAA-BBBBB-CCCCC-DDDDD";
const SHA = "a".repeat(64);
const pairA = generateKeyPair();
const pairB = generateKeyPair();

let calls = 0;
type Reply = (path: string, body: { nonce: string }) => unknown;
let reply: Reply = () => ({});

beforeEach(() => {
  calls = 0;
  delete process.env.LICENSE_PUBLIC_KEY;
  delete process.env.EMZ_EMBEDDED_LICENSE_PUBLIC_KEY;
  process.env.LICENSE_SERVER_URL = "http://license.test";
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { nonce: string };
    return new Response(JSON.stringify(reply(new URL(String(input)).pathname, body)), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.LICENSE_PUBLIC_KEY;
  delete process.env.EMZ_EMBEDDED_LICENSE_PUBLIC_KEY;
  delete process.env.LICENSE_SERVER_URL;
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("offline");
  });
  await removeLicense();
  vi.unstubAllGlobals();
});

const unsignedValid: Reply = (_p, b) => ({ ok: true, payload: JSON.stringify({ nonce: b.nonce, product: PRODUCT_ID, valid: true, status: "active" }), sig: "AAAA" });

describe("C-01 — نبود کلید عمومی = بسته (نه باز)", () => {
  it("بدون LICENSE_PUBLIC_KEY پاسخ بی‌امضای «valid:true» پذیرفته نمی‌شود و حتی تماس شبکه‌ای انجام نمی‌شود", async () => {
    reply = unsignedValid;
    expect(trustedPublicKey()).toBeNull();
    await expect(callLicenseServer("/api/license/v1/check", {})).rejects.toThrow(/کلید عمومی/);
    expect(calls).toBe(0);
    const r = await activateLicense(KEY);
    expect(r.ok).toBe(false);
    expect(await getLicenseInfo()).toMatchObject({ state: "unlicensed", licensed: false });
  });

  it("کلید عمومی خراب/غیر-Ed25519 هم مثل نبود کلید است", async () => {
    reply = unsignedValid;
    process.env.LICENSE_PUBLIC_KEY = "not-a-key";
    expect(trustedPublicKey()).toBeNull();
    await expect(callLicenseServer("/x", {})).rejects.toThrow(/کلید عمومی/);
    process.env.LICENSE_PUBLIC_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(trustedPublicKey()).toBeNull();
  });

  it("کلید تعبیه‌شده‌ی زمان build بر env زمان اجرا اولویت دارد (env نمی‌تواند ریشه‌ی اعتماد را عوض کند)", async () => {
    process.env.EMZ_EMBEDDED_LICENSE_PUBLIC_KEY = pairA.publicKey;
    process.env.LICENSE_PUBLIC_KEY = pairB.publicKey;
    reply = (_p, b) => ({ ok: true, ...signPayload({ nonce: b.nonce, product: PRODUCT_ID, valid: true }, pairB.privateKey) });
    const forged = await callLicenseServer("/x", {}).then(() => "accepted", (e: Error) => e.message);
    expect(forged).toMatch(/امضا/);
  });

  it("امضای سرور جعلی (کلید دیگر) یا پایلود دستکاری‌شده رد می‌شود؛ امضای درست پذیرفته", async () => {
    process.env.LICENSE_PUBLIC_KEY = pairA.publicKey;
    reply = (_p, b) => ({ ok: true, ...signPayload({ nonce: b.nonce, product: PRODUCT_ID, valid: true }, pairB.privateKey) });
    await expect(callLicenseServer("/x", {})).rejects.toThrow(/امضا/);
    reply = (_p, b) => {
      const s = signPayload({ nonce: b.nonce, product: PRODUCT_ID, valid: false }, pairA.privateKey);
      return { ok: true, payload: s.payload.replace("false", "true "), sig: s.sig };
    };
    await expect(callLicenseServer("/x", {})).rejects.toThrow(/امضا/);
    reply = (_p, b) => ({ ok: true, ...signPayload({ nonce: b.nonce, product: PRODUCT_ID, valid: true }, pairA.privateKey) });
    const ok = await callLicenseServer("/x", {});
    expect(ok.verified).toBe(true);
    expect(ok.data.valid).toBe(true);
  });

  it("وضعیت ذخیره‌شده‌ی بی‌امضا (ردیف قدیمی) هرگز «فعال» نیست؛ فقط با امضای معتبر فعال می‌شود", async () => {
    const payload = JSON.stringify({ status: "active", valid: true, plan: "pro", customer: "x", domain: "d" });
    const stored = (sig: string) => JSON.stringify({ payload, sig, checkedAt: new Date().toISOString(), okAt: new Date().toISOString(), verified: true, error: null });
    await saveGlobalSetting("license_key", encryptSecret(KEY));
    process.env.LICENSE_PUBLIC_KEY = pairA.publicKey;

    await saveGlobalSetting("license_state", stored("AAAA"));
    expect(await getLicenseInfo()).toMatchObject({ state: "invalid", licensed: false });

    const good = signPayload({ status: "active", valid: true, plan: "pro", customer: "x", domain: "d" }, pairA.privateKey);
    await saveGlobalSetting("license_state", JSON.stringify({ payload: good.payload, sig: good.sig, checkedAt: new Date().toISOString(), okAt: new Date().toISOString(), verified: true, error: null }));
    expect(await getLicenseInfo()).toMatchObject({ state: "active", licensed: true, verified: true });

    // با حذف کلید عمومی (مثلاً env پاک شد) همان وضعیت دیگر فعال نیست
    delete process.env.LICENSE_PUBLIC_KEY;
    expect(await getLicenseInfo()).toMatchObject({ state: "invalid", licensed: false });
  });
});

describe("C-01 — نشانی سرور لایسنس", () => {
  it("در production فقط HTTPS؛ http، نام‌کاربری/رمز و مقدار نامعتبر به سرور پیش‌فرض برمی‌گردد", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.LICENSE_SERVER_URL = "http://evil.example";
    expect(licenseServerUrl()).toBe(DEFAULT_LICENSE_SERVER);
    process.env.LICENSE_SERVER_URL = "https://user:pw@evil.example";
    expect(licenseServerUrl()).toBe(DEFAULT_LICENSE_SERVER);
    process.env.LICENSE_SERVER_URL = "ftp://evil.example";
    expect(licenseServerUrl()).toBe(DEFAULT_LICENSE_SERVER);
    process.env.LICENSE_SERVER_URL = "https://license.vendor.example/";
    expect(licenseServerUrl()).toBe("https://license.vendor.example");
  });
  it("در توسعه/آزمون http پذیرفته است", () => {
    process.env.LICENSE_SERVER_URL = "http://license.test";
    expect(licenseServerUrl()).toBe("http://license.test");
  });
});

describe("C-01 — مانیفست به‌روزرسانی و مسیر دانلود (Path Traversal)", () => {
  const good = { version: "9.9.9", sha256: SHA, size: 1234, changelog: "x", publishedAt: "2026-01-01", security: true };

  it("مانیفست سالم نرمال می‌شود؛ نسخه/هش/اندازه‌ی نامعتبر null است", () => {
    expect(parseManifest(good)).toMatchObject({ version: "9.9.9", sha256: SHA, size: 1234, security: true });
    expect(parseManifest({ ...good, sha256: "A".repeat(64) })?.sha256).toBe(SHA);
    for (const version of ["../../x", "9.9.9/../..", "1.0.0\u0000", "..", "1.0", "v1.0.0", "1.0.0-" + "a".repeat(40), "", 5]) expect(parseManifest({ ...good, version }), String(version)).toBeNull();
    for (const sha256 of ["", "abc", "g".repeat(64), "a".repeat(63), 5, null]) expect(parseManifest({ ...good, sha256 }), String(sha256)).toBeNull();
    for (const size of [0, -1, 1.5, Number.NaN, 10 ** 12, "100", null]) expect(parseManifest({ ...good, size }), String(size)).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("x")).toBeNull();
  });

  it("updateZipPath همیشه داخل UPDATES_DIR می‌ماند و نسخه‌ی مخرب خطا می‌دهد", () => {
    const f = updateZipPath("2.2.0");
    expect(path.dirname(f)).toBe(path.resolve(UPDATES_DIR));
    expect(path.basename(f)).toBe("emzagar-2.2.0.zip");
    for (const v of ["../../evil", "1.0.0/../../etc/passwd", "1.0.0/..", "..\\..\\x"]) expect(() => updateZipPath(v), v).toThrow();
  });

  it("download با نسخه/هش/اندازه‌ی نامعتبر پیش از هر تماس شبکه‌ای یا نوشتن فایل رد می‌شود", async () => {
    const marker = path.resolve(UPDATES_DIR, "..", "evil.zip.part");
    await expect(download("../../../evil", SHA, 10)).rejects.toThrow(/نامعتبر/);
    await expect(download("9.9.9", "zz", 10)).rejects.toThrow(/نامعتبر/);
    await expect(download("9.9.9", SHA, 0)).rejects.toThrow(/نامعتبر/);
    expect(calls).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("حتی مانیفستِ «امضاشده» با نسخه‌ی مخرب ذخیره/پیشنهاد نمی‌شود", async () => {
    process.env.LICENSE_PUBLIC_KEY = pairA.publicKey;
    await saveGlobalSetting("license_key", encryptSecret(KEY));
    const mk = (latest: unknown): Reply => (_p, b) => ({ ok: true, ...signPayload({ nonce: b.nonce, product: PRODUCT_ID, valid: true, updateAvailable: true, latest }, pairA.privateKey) });

    reply = mk({ version: "../../evil", sha256: SHA, size: 100 });
    let info = await checkForUpdate();
    expect(info.updateAvailable).toBe(false);
    expect(info.latest).toBeNull();
    expect(info.error).toMatch(/نامعتبر/);

    reply = mk({ version: "99.0.0", sha256: "short", size: 100 });
    info = await checkForUpdate();
    expect(info.updateAvailable).toBe(false);

    reply = mk({ version: "99.0.0", sha256: SHA, size: 100, changelog: "ok" });
    info = await checkForUpdate();
    expect(info).toMatchObject({ updateAvailable: true, latest: { version: "99.0.0", sha256: SHA, size: 100 } });
  });

  it("بدون کلید عمومی، بررسی به‌روزرسانی هیچ مانیفستی نمی‌پذیرد", async () => {
    await saveGlobalSetting("license_key", encryptSecret(KEY));
    reply = (_p, b) => ({ ok: true, payload: JSON.stringify({ nonce: b.nonce, product: PRODUCT_ID, valid: true, updateAvailable: true, latest: { version: "99.0.0", sha256: SHA, size: 100 } }), sig: "AAAA" });
    const info = await checkForUpdate();
    expect(info.updateAvailable).toBe(false);
    expect(info.latest).toBeNull();
    expect(info.error).toMatch(/کلید عمومی/);
    expect(calls).toBe(0);
  });
});
