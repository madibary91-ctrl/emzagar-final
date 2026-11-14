import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIpFrom, peerIpFrom } from "@/lib/request";
import { installPeerIpStamp, PEER_IP_HEADER, stampPeerIp } from "@/lib/peer-ip";
import { rateLimit, resetRateLimit, UNKNOWN_IP_LIMIT_MULTIPLIER } from "@/lib/rate-limit";

/**
 * H-04 — شناسایی IP کلاینت:
 *  • آدرس واقعی سوکت جعل‌ناپذیر است (هدر ورودی همنام حذف و بازنویسی می‌شود)؛
 *  • بدون پراکسی (سوکت عمومی) هدر X-Forwarded-For جعلی نادیده گرفته می‌شود؛
 *  • TRUSTED_PROXY_HOPS=0 به‌جای «unknown» مشترک، IP واقعی سوکت را می‌دهد؛
 *  • سطل مشترک «unknown» نمی‌تواند با چند درخواست ورود همه را قفل کند.
 */
const hdr = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;

afterEach(() => vi.unstubAllEnvs());

describe("H-04 — clientIpFrom با آدرس واقعی سوکت", () => {
  it("سناریو ب: بدون پراکسی و env خالی، X-Forwarded-For جعلی از سوکت عمومی نادیده گرفته می‌شود", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    const h = hdr({ [PEER_IP_HEADER]: "93.184.216.34", "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" });
    expect(clientIpFrom(h)).toBe("93.184.216.34");
    // IPv4-mapped IPv6 هم نرمال می‌شود
    expect(clientIpFrom(hdr({ [PEER_IP_HEADER]: "::ffff:93.184.216.35", "x-forwarded-for": "1.2.3.4" }))).toBe("93.184.216.35");
  });

  it("پشت پراکسی محلی/خصوصی (loopback، شبکه‌ی Docker) هدر forwarded از «سمت راست» خوانده می‌شود و جعل چپ بی‌اثر است", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
    expect(clientIpFrom(hdr({ [PEER_IP_HEADER]: "127.0.0.1", "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFrom(hdr({ [PEER_IP_HEADER]: "172.18.0.5", "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    // پراکسی هدر نفرستاده ⇒ آدرس خود سوکت (نه unknown مشترک)
    expect(clientIpFrom(hdr({ [PEER_IP_HEADER]: "127.0.0.1" }))).toBe("127.0.0.1");
  });

  it("سناریو الف (Docker پیش‌فرض، TRUSTED_PROXY_HOPS=0): هر کلاینت IP واقعی خودش را دارد، نه «unknown» مشترک", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    const a = clientIpFrom(hdr({ [PEER_IP_HEADER]: "203.0.113.1", "x-forwarded-for": "9.9.9.9" }));
    const b = clientIpFrom(hdr({ [PEER_IP_HEADER]: "203.0.113.2", "x-forwarded-for": "9.9.9.9" }));
    expect(a).toBe("203.0.113.1");
    expect(b).toBe("203.0.113.2");
    expect(a).not.toBe(b);
  });

  it("مقدار نامعتبر env هم بسته است: forwarded نادیده و سوکت پذیرفته می‌شود", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "abc");
    expect(clientIpFrom(hdr({ [PEER_IP_HEADER]: "203.0.113.7", "x-forwarded-for": "9.9.9.9" }))).toBe("203.0.113.7");
  });

  it("زنجیره‌ی کوتاه‌تر از انتظار یا نامعتبر ⇒ آدرس سوکت؛ بدون هیچ منبعی ⇒ unknown", () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    expect(clientIpFrom(hdr({ [PEER_IP_HEADER]: "10.0.0.2", "x-forwarded-for": "6.6.6.6" }))).toBe("10.0.0.2");
    expect(clientIpFrom(hdr({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
    expect(clientIpFrom(hdr({}))).toBe("unknown");
  });

  it("مقدار peer نامعتبر نادیده گرفته می‌شود", () => {
    expect(peerIpFrom(hdr({ [PEER_IP_HEADER]: "not-an-ip" }))).toBe("");
    expect(peerIpFrom(hdr({ [PEER_IP_HEADER]: "1.2.3.4, 5.6.7.8" }))).toBe("");
  });
});

describe("H-04 — قلاب سرور: هدر peer جعل‌ناپذیر است", () => {
  it("stampPeerIp نسخه‌ی کلاینتی را از headers و rawHeaders حذف و آدرس سوکت را می‌نویسد", () => {
    const req = {
      headers: { [PEER_IP_HEADER]: "6.6.6.6", host: "x" } as Record<string, string>,
      rawHeaders: ["X-Emz-Peer-Ip", "6.6.6.6", "Host", "x", "x-EMZ-peer-ip", "7.7.7.7"],
      socket: { remoteAddress: "203.0.113.5" },
    };
    stampPeerIp(req as unknown as Parameters<typeof stampPeerIp>[0]);
    expect(req.headers[PEER_IP_HEADER]).toBe("203.0.113.5");
    expect(req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === PEER_IP_HEADER)).toHaveLength(1);
    expect(req.rawHeaders).not.toContain("6.6.6.6");
    expect(req.rawHeaders).not.toContain("7.7.7.7");
  });

  it("روی یک http.Server واقعی: هدرهای جعلی کلاینت (peer و XFF) نمی‌توانند IP را عوض کنند", async () => {
    expect(installPeerIpStamp()).toBe(true);
    expect(installPeerIpStamp()).toBe(false); // ایدمپوتنت
    const server = http.createServer((req, res) => {
      const get = (n: string) => (req.headers[n] as string | undefined) ?? null;
      res.end(JSON.stringify({ peer: get(PEER_IP_HEADER), ip: clientIpFrom(get) }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      // کلاینت loopback است (پراکسی محلی): XFF سمت راست را می‌خوانیم، ولی peer همیشه 127.0.0.1 است نه مقدار جعلی
      vi.stubEnv("TRUSTED_PROXY_HOPS", "");
      const r1 = (await (await fetch(`http://127.0.0.1:${port}/`, { headers: { [PEER_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "7.7.7.7, 203.0.113.9" } })).json()) as { peer: string; ip: string };
      expect(r1.peer).toBe("127.0.0.1");
      expect(r1.ip).toBe("203.0.113.9");
      // بدون پراکسی مورد اعتماد: XFF کاملاً نادیده و IP همان سوکت است
      vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
      const r2 = (await (await fetch(`http://127.0.0.1:${port}/`, { headers: { [PEER_IP_HEADER]: "6.6.6.6", "x-forwarded-for": "7.7.7.7" } })).json()) as { peer: string; ip: string };
      expect(r2.peer).toBe("127.0.0.1");
      expect(r2.ip).toBe("127.0.0.1");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("H-04 — سطل مشترک «unknown» ورود همه را قفل نمی‌کند", () => {
  it("IP معلوم با سقف عادی؛ IP نامعلوم با سقف چندبرابر (فقط سیل واقعی را می‌گیرد)", () => {
    const real = `h04:login:ip:203.0.113.99:${Date.now()}`;
    for (let i = 0; i < 30; i++) expect(rateLimit(real, 30, 60_000).ok).toBe(true);
    expect(rateLimit(real, 30, 60_000).ok).toBe(false);

    const unk = "h04:login:ip:unknown";
    resetRateLimit(unk);
    // ۳۰ تلاش مهاجم (سقف قدیمی) دیگر کاربران قانونی را قفل نمی‌کند
    for (let i = 0; i < 30; i++) rateLimit(unk, 30, 60_000);
    expect(rateLimit(unk, 30, 60_000).ok).toBe(true);
    // اما سیل واقعاً بزرگ هنوز مهار می‌شود
    for (let i = 0; i < 30 * UNKNOWN_IP_LIMIT_MULTIPLIER; i++) rateLimit(unk, 30, 60_000);
    expect(rateLimit(unk, 30, 60_000).ok).toBe(false);
    resetRateLimit(unk);
  });

  it("کلیدهای ترکیبی شامل unknown هم همین رفتار را دارند و کلید «unknownuser» تأثیر نمی‌گیرد", () => {
    const k = "h04:register:unknown";
    resetRateLimit(k);
    for (let i = 0; i < 7; i++) expect(rateLimit(k, 6, 60_000).ok).toBe(true);
    resetRateLimit(k);
    const other = `h04:login:email:unknownuser@example.com:${Date.now()}`;
    for (let i = 0; i < 8; i++) rateLimit(other, 8, 60_000);
    expect(rateLimit(other, 8, 60_000).ok).toBe(false);
  });
});
