import { beforeEach, describe, expect, it } from "vitest";
import { __resetSeenIps, noteClientIp } from "@/lib/ip-bucket";
import { canonicalRateKey, rateLimit } from "@/lib/rate-limit";
import { clientIpFrom } from "@/lib/request";

/** S00-F06 — چرخاندن آدرس منبع داخل یک بلوک IPv6 /64 نباید سقف «به‌ازای IP» را دور بزند. */
const note = (...ips: string[]) => ips.forEach((i) => noteClientIp(i));
beforeEach(() => __resetSeenIps());

describe("canonicalRateKey", () => {
  it("IPv4 و کلیدهای بدون IPv6 دست‌نخورده‌اند", () => {
    for (const k of ["login:1.2.3.4", "otp:contract:12:ab", "unknown", "api:badkey:10.0.0.1", "x:a:b:c:d:e:f", "sign:ip:::ffff:1.2.3.4".replace("::ffff:", "")]) {
      expect(canonicalRateKey(k)).toBe(k);
    }
  });
  it("همه‌ی آدرس‌های یک /64 به یک کلید می‌رسند", () => {
    note("2001:db8:aaaa:bbbb:1:2:3:4", "2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff", "2001:db8:aaaa:bbbb::1", "2001:0DB8:AAAA:BBBB:0:0:0:9");
    const a = canonicalRateKey("login:ip:2001:db8:aaaa:bbbb:1:2:3:4");
    const b = canonicalRateKey("login:ip:2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff");
    const c = canonicalRateKey("login:ip:2001:db8:aaaa:bbbb::1");
    const d = canonicalRateKey("login:ip:2001:0DB8:AAAA:BBBB:0:0:0:9");
    expect(new Set([a, b, c, d]).size).toBe(1);
    expect(a).toBe("login:ip:v6/2001:db8:aaaa:bbbb");
  });
  it("/64 دیگر یا کلید دیگر جدا می‌ماند و بخش‌های بعدی کلید حفظ می‌شود", () => {
    note("2001:db8:aaaa:bbbc::1", "2001:db8:aaaa:bbbb::1", "2001:db8::1", "2001:db8:1:2::5");
    expect(canonicalRateKey("login:2001:db8:aaaa:bbbc::1")).not.toBe(canonicalRateKey("login:2001:db8:aaaa:bbbb::1"));
    expect(canonicalRateKey("login:2001:db8::1")).not.toBe(canonicalRateKey("otp:2001:db8::1"));
    expect(canonicalRateKey("pay:ip:2001:db8:1:2::5:code123")).toBe("pay:ip:v6/2001:db8:1:2:code123");
  });
  it("شناسه‌های هگزمانند کنار IP (مثل 1234 یا bad) با آدرس قاطی نمی‌شوند", () => {
    note("2001:db8:1:2::5");
    expect(canonicalRateKey("otp:1234:2001:db8:1:2::5")).toBe("otp:1234:v6/2001:db8:1:2");
    expect(canonicalRateKey("bad:b:2001:db8:1:2::5:dead")).toBe("bad:b:v6/2001:db8:1:2:dead");
    // رشته‌ای که IPv6 معتبر است ولی «از clientIpFrom نیامده» دست‌نخورده می‌ماند
    expect(canonicalRateKey("x:2001:db8:9:9::9")).toBe("x:2001:db8:9:9::9");
  });
  it("آدرس‌های فشرده (::) و loopback", () => {
    note("::1", "2001:db8::", "fe80::1ff:fe23:4567:890a", "::ffff:1.2.3.4");
    expect(canonicalRateKey("k:::1")).toBe("k:v6/0:0:0:0");
    expect(canonicalRateKey("k:2001:db8::")).toBe("k:v6/2001:db8:0:0");
    expect(canonicalRateKey("k:fe80::1ff:fe23:4567:890a")).toBe("k:v6/fe80:0:0:0");
    expect(canonicalRateKey("k:::ffff:1.2.3.4")).toBe("k:v6/0:0:0:0");
  });
});

describe("rateLimit با IPv6", () => {
  it("۲۰ آدرس متفاوت از یک /64 یک سطل مشترک دارند", () => {
    const prefix = "2001:db8:5555:6666";
    let blocked = 0;
    for (let i = 0; i < 20; i++) {
      const ip = `${prefix}:${i}:${i + 1}:${i + 2}:${i + 3}`;
      noteClientIp(ip);
      if (!rateLimit(`s00f06:login:${ip}`, 5, 60_000).ok) blocked++;
    }
    expect(blocked).toBe(15);
  });
  it("/64 دیگر سطل جدا دارد", () => {
    note("2001:db8:7777:2::1", "2001:db8:7777:1::99", ...[1, 2, 3, 4, 5, 6].map((i) => `2001:db8:7777:1::${i}`));
    for (let i = 0; i < 6; i++) rateLimit(`s00f06:b:2001:db8:7777:1::${i + 1}`, 5, 60_000);
    expect(rateLimit("s00f06:b:2001:db8:7777:2::1", 5, 60_000).ok).toBe(true);
    expect(rateLimit("s00f06:b:2001:db8:7777:1::99", 5, 60_000).ok).toBe(false);
  });
});

describe("clientIpFrom ← ثبت IPv6 (یکپارچگی)", () => {
  it("IPv6 تحویل‌شده توسط clientIpFrom در کلید فشرده می‌شود ولی خودِ IP کامل برمی‌گردد (برای شواهد)", () => {
    const ip = clientIpFrom((n) => ({ "x-forwarded-for": "9.9.9.9, 2001:db8:abcd:1234:1:2:3:4" })[n] ?? null);
    expect(ip).toBe("2001:db8:abcd:1234:1:2:3:4");
    expect(canonicalRateKey(`login:${ip}`)).toBe("login:v6/2001:db8:abcd:1234");
  });
});
