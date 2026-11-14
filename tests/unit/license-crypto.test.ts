import { describe, expect, it } from "vitest";
import { generateKeyPair, isDevDomain, LICENSE_KEY_RE, newLicenseKey, normalizeDomain, signPayload, verifyText } from "@/modules/license/crypto";
import { compareVersions, isValidVersion } from "@/lib/version";
import { safeEntryPath } from "@/modules/license/updater";
import { PROVIDERS, PROVIDER_LIST, protocolOf } from "@/modules/ai/providers";

describe("امضای Ed25519 لایسنس", () => {
  it("امضا راستی‌آزمایی می‌شود و دستکاری/کلید دیگر رد می‌شود", () => {
    const kp = generateKeyPair();
    const s = signPayload({ valid: true, plan: "pro" }, kp.privateKey);
    expect(verifyText(s.payload, s.sig, kp.publicKey)).toBe(true);
    expect(verifyText(s.payload.replace("true", "fals"), s.sig, kp.publicKey)).toBe(false);
    expect(verifyText(s.payload, s.sig, generateKeyPair().publicKey)).toBe(false);
    expect(verifyText(s.payload, "!!!", kp.publicKey)).toBe(false);
  });

  it("کلید عمومی تک‌خطی (Base64 بدون هدر) هم پذیرفته می‌شود", () => {
    const kp = generateKeyPair();
    const s = signPayload({ a: 1 }, kp.privateKey);
    const raw = kp.publicKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect(verifyText(s.payload, s.sig, raw)).toBe(true);
  });

  it("کلید لایسنس: قالب و یکتایی", () => {
    const keys = new Set(Array.from({ length: 200 }, newLicenseKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(LICENSE_KEY_RE);
    expect(LICENSE_KEY_RE.test("EMZ-AAAAA-BBBBB-CCCCC-0OIl1")).toBe(false);
  });

  it("نرمال‌سازی دامنه و دامنه‌های توسعه", () => {
    expect(normalizeDomain("https://WWW.Shop.Example.com:8443/path")).toBe("shop.example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(isDevDomain("localhost")).toBe(true);
    expect(isDevDomain("my.test")).toBe(true);
    expect(isDevDomain("example.com")).toBe(false);
  });
});

describe("نسخه‌ها و استخراج امن", () => {
  it("مقایسه‌ی نسخه‌ی معنایی", () => {
    expect(compareVersions("2.1.0", "2.0.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBeLessThan(0);
    expect(isValidVersion("2.1.0")).toBe(true);
    expect(isValidVersion("2.1")).toBe(false);
    expect(isValidVersion("../../x")).toBe(false);
  });

  it("safeEntryPath: Zip-Slip، مسیر مطلق و فایل‌های خارج از فهرست سفید رد می‌شوند", () => {
    expect(safeEntryPath("emzagar/.next/server/app.js", "emzagar/")).toBe(".next/server/app.js");
    expect(safeEntryPath("emzagar/server.js", "emzagar/")).toBe("server.js");
    expect(safeEntryPath("emzagar/../../etc/passwd", "emzagar/")).toBeNull();
    expect(safeEntryPath("emzagar/.next/../../x", "emzagar/")).toBeNull();
    expect(safeEntryPath("/etc/passwd", "")).toBeNull();
    expect(safeEntryPath("emzagar/storage/config.json", "emzagar/")).toBeNull();
    expect(safeEntryPath("emzagar/.env", "emzagar/")).toBeNull();
    expect(safeEntryPath("emzagar/public/a\\b", "emzagar/")).toBeNull();
    expect(safeEntryPath("emzagar/public/", "emzagar/")).toBeNull();
    expect(safeEntryPath("other/server.js", "emzagar/")).toBeNull();
  });
});

describe("فهرست سرویس‌های هوش مصنوعی", () => {
  it("هر سرویس تعریف کامل دارد و فقط custom آدرس الزامی دارد", () => {
    expect(PROVIDER_LIST.length).toBeGreaterThanOrEqual(8);
    for (const p of PROVIDER_LIST) {
      expect(p.label).toBeTruthy();
      if (p.id === "custom") expect(p.requiresBaseUrl).toBe(true);
      else {
        expect(p.baseUrl).toMatch(/^https:\/\//);
        expect(p.defaultModel).toBeTruthy();
      }
    }
    expect(protocolOf("anthropic")).toBe("anthropic");
    expect(protocolOf("openai")).toBe("openai");
    expect(protocolOf("نامعلوم")).toBe("openai");
    expect(PROVIDERS.gemini.baseUrl).toContain("generativelanguage.googleapis.com");
  });
});
