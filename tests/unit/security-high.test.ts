import http from "node:http";
import dns from "node:dns";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPng } from "@/lib/png";
import { clientIpFrom } from "@/lib/request";
import { resolveTrustedOrigin } from "@/lib/origin";
import { isPrivateIp, safeFetch } from "@/lib/ssrf";
import { parseSignatureDataUrl } from "@/modules/signing/types";
import { isLocalSite } from "@/modules/connect/service";
import { makePng } from "../helpers";

// آدرس مورد اعتماد فقط از APP_URL محیط خوانده شود (فایل config.json بقیه‌ی آزمون‌ها اثر نگذارد)
vi.mock("@/lib/config", async (orig) => {
  const m = await orig<typeof import("@/lib/config")>();
  return { ...m, trustedAppOrigin: () => {
      const v = String(process.env.APP_URL || "").replace(/\/+$/, "");
      return /^https?:\/\/[A-Za-z0-9.\-:]+$/.test(v) ? v : "";
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const hdr = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;

describe("SEC-01 — مسموم‌سازی هدر Host", () => {
  it("بدون APP_URL هدر Host/X-Forwarded-Host مهاجم هرگز مبدأ لینک نمی‌شود", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("TRUSTED_HOSTS", "");
    for (const env of ["production", "development", "test"]) {
      vi.stubEnv("NODE_ENV", env);
      expect(resolveTrustedOrigin(hdr({ host: "evil.com" }))).toBe("");
      expect(resolveTrustedOrigin(hdr({ host: "evil.com", "x-forwarded-host": "evil.com", "x-forwarded-proto": "https" }))).toBe("");
      expect(resolveTrustedOrigin(hdr({ host: "app.example.com", "x-forwarded-host": "evil.com" }))).toBe("");
    }
  });
  it("APP_URL بر هر هدری مقدم است", () => {
    vi.stubEnv("APP_URL", "https://sign.example.com/");
    expect(resolveTrustedOrigin(hdr({ host: "evil.com", "x-forwarded-host": "evil.com" }))).toBe("https://sign.example.com");
  });
  it("فهرست سفید TRUSTED_HOSTS: فقط میزبان‌های فهرست‌شده", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("TRUSTED_HOSTS", "sign.example.com, www.example.com");
    expect(resolveTrustedOrigin(hdr({ host: "sign.example.com", "x-forwarded-proto": "https" }))).toBe("https://sign.example.com");
    expect(resolveTrustedOrigin(hdr({ host: "sign.example.com", "x-forwarded-host": "evil.com" }))).toBe("https://sign.example.com");
    expect(resolveTrustedOrigin(hdr({ host: "evil.com", "x-forwarded-host": "evil.com" }))).toBe("");
  });
  it("loopback فقط در حالت غیر production", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("TRUSTED_HOSTS", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveTrustedOrigin(hdr({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveTrustedOrigin(hdr({ host: "localhost:3000" }))).toBe("");
  });
});

describe("SEC-02 — جعل IP و TRUSTED_PROXY_HOPS", () => {
  it("TRUSTED_PROXY_HOPS=0 یعنی هیچ هدر forwarded پذیرفته نمی‌شود", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6, 7.7.7.7", "x-real-ip": "8.8.8.8" }))).toBe("unknown");
    expect(clientIpFrom(hdr({ "x-real-ip": "8.8.8.8" }))).toBe("unknown");
  });
  it("مقدار نامعتبر هم بسته شکست می‌خورد", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "abc");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "-1");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
  });
  it("پیش‌فرض ۱: از سمت راست خوانده می‌شود و جعل چپ بی‌اثر است", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6, 198.51.100.7, 203.0.113.9" }))).toBe("198.51.100.7");
  });
  it("زنجیره‌ی کوتاه‌تر از تعداد پراکسی‌ها و مقدارهای غیر IP رد می‌شود", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "not-an-ip" }))).toBe("unknown");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "203.0.113.9:4444" }))).toBe("203.0.113.9");
  });
});

describe("SEC-04 — SSRF و DNS Rebinding", () => {
  it("isPrivateIp: شکل‌های مختلف IPv4/IPv6 داخلی", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "172.20.0.1", "100.64.0.1", "0.0.0.0", "::1", "::", "0:0:0:0:0:0:0:1", "::ffff:7f00:1", "::ffff:127.0.0.1", "fe80::1", "fd00::1", "64:ff9b::7f00:1", "2002:7f00:1::1", "not-an-ip"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("safeFetch: IP لیترال داخلی، localhost و http رد می‌شود", async () => {
    await expect(safeFetch("https://127.0.0.1/x")).rejects.toThrow();
    await expect(safeFetch("https://[::1]/x")).rejects.toThrow();
    await expect(safeFetch("https://localhost/x")).rejects.toThrow();
    await expect(safeFetch("http://example.com/x")).rejects.toThrow();
    await expect(safeFetch("https://user:pw@example.com/x")).rejects.toThrow();
  });

  it("rebinding: دامنه‌ای که در لحظه‌ی اتصال به 127.0.0.1 resolve شود هرگز به سرور داخلی نمی‌رسد", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits++;
      res.end("secret-internal");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // پرسش‌های DNS مهاجم: اول عمومی (برای بررسی‌های زودهنگام)، بعد 127.0.0.1 (برای اتصال واقعی)
    let calls = 0;
    const real = dns.lookup;
    vi.spyOn(dns, "lookup").mockImplementation(((host: string, opts: unknown, cb: (...a: unknown[]) => void) => {
      if (host !== "rebind.attacker.test") return (real as unknown as (...a: unknown[]) => void)(host, opts, cb);
      calls++;
      const addr = calls === 1 ? "93.184.216.34" : "127.0.0.1";
      cb(null, [{ address: addr, family: 4 }]);
    }) as unknown as typeof dns.lookup);
    try {
      // حتی اگر اولین پاسخ عمومی باشد، نگهبان در لحظه‌ی اتصال همه‌ی پاسخ‌ها را می‌سنجد؛ پاسخ دوم داخلی است
      calls = 1;
      await expect(safeFetch(`http://rebind.attacker.test:${port}/`, { allowHttp: true, signal: AbortSignal.timeout(4000) })).rejects.toMatchObject({ cause: { code: "ESSRF" } });
      expect(hits).toBe(0);
      // پاسخ مختلط (عمومی + داخلی) هم رد می‌شود
      vi.mocked(dns.lookup).mockImplementation(((_h: string, _o: unknown, cb: (...a: unknown[]) => void) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }])) as unknown as typeof dns.lookup);
      await expect(safeFetch(`http://mixed.attacker.test:${port}/`, { allowHttp: true, signal: AbortSignal.timeout(4000) })).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});

/* ───────────── SEC-05: PNG ───────────── */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer, badCrc = false) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(badCrc ? 1 : crc(td));
  return Buffer.concat([len, td, c]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = (w: number, h: number) => {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8;
  b[9] = 6;
  return b;
};
const png = (w: number, h: number, rawLen: number, extra: { badCrc?: boolean; trailing?: boolean } = {}) =>
  Buffer.concat([SIG, chunk("IHDR", ihdr(w, h)), chunk("IDAT", zlib.deflateSync(Buffer.alloc(rawLen), { level: 9 }), extra.badCrc), chunk("IEND", Buffer.alloc(0)), extra.trailing ? Buffer.from("junk") : Buffer.alloc(0)]);
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;

describe("SEC-05 — اعتبارسنجی ساختاری PNG امضا", () => {
  it("PNG سالم پذیرفته می‌شود", () => {
    const ok = parseSignatureDataUrl(makePng());
    expect("buffer" in ok).toBe(true);
    expect(inspectPng((ok as { buffer: Buffer }).buffer).ok).toBe(true);
    expect(inspectPng(png(64, 64, 64 * (64 * 4 + 1))).ok).toBe(true);
  });
  it("بمب فشرده‌سازی: IHDR کوچک ولی IDAT صدها مگابایت بازمی‌شود → رد، سریع و بدون حافظه‌ی زیاد", () => {
    const bomb = Buffer.concat([SIG, chunk("IHDR", ihdr(10, 10)), chunk("IDAT", zlib.deflateSync(Buffer.alloc(300 * 1024 * 1024), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
    expect(bomb.length).toBeLessThan(700 * 1024);
    const t0 = Date.now();
    const before = process.memoryUsage().rss;
    expect(inspectPng(bomb).ok).toBe(false);
    expect("error" in parseSignatureDataUrl(dataUrl(bomb))).toBe(true);
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it("ابعاد غول‌پیکر، CRC خراب، بایت اضافه و امضای جعلی رد می‌شود", () => {
    expect(inspectPng(png(60000, 60000, 100)).ok).toBe(false);
    expect(inspectPng(png(3000, 3000, 3000 * (3000 * 4 + 1))).ok).toBe(false); // بیش از سقف ۴ میلیون پیکسل
    expect(inspectPng(png(10, 10, 10 * (10 * 4 + 1), { badCrc: true })).ok).toBe(false);
    expect(inspectPng(png(10, 10, 10 * (10 * 4 + 1), { trailing: true })).ok).toBe(false);
    expect(inspectPng(png(10, 10, 5)).ok).toBe(false); // اندازه‌ی بازشده با ابعاد نمی‌خواند
    const fake = Buffer.concat([Buffer.from("89504e47", "hex"), Buffer.alloc(2000, 7)]);
    expect("error" in parseSignatureDataUrl(dataUrl(fake))).toBe(true);
  });
});

describe("SEC-03 — isLocalSite فقط برای میزبان‌های واقعاً محلی", () => {
  it("آدرس http روی دامنه‌ی عمومی «محلی» نیست", () => {
    expect(isLocalSite(new URL("http://evil.com"))).toBe(false);
    expect(isLocalSite(new URL("http://93.184.216.34"))).toBe(false);
    expect(isLocalSite(new URL("https://shop.example.org"))).toBe(false);
    expect(isLocalSite(new URL("http://localhost:8080"))).toBe(true);
    expect(isLocalSite(new URL("http://192.168.1.5"))).toBe(true);
    expect(isLocalSite(new URL("http://shop.test"))).toBe(true);
  });
});
