import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S00-F01 (Critical) — دروازه‌ی نصب نباید با هدرهای کلاینت‌ساخت (`Purpose: prefetch`، `Next-Router-Prefetch`) دور زده شود.
 * پیش‌تر `matcher` این درخواست‌ها را کلاً از پراکسی بیرون می‌گذاشت ⇒ پیش از ساخت مدیر، /register و APIها باز بودند و
 * «اولین ثبت‌نام‌کننده» مدیر کل می‌شد.
 */
let installed = false;
vi.mock("@/modules/install/service", () => ({ isInstalled: async () => installed }));

const { proxy, config } = await import("@/proxy");
const { isRscPrefetch } = await import("@/lib/csp");

const req = (path: string, headers: Record<string, string> = {}, method = "GET") => new NextRequest(`http://localhost:3000${path}`, { method, headers });

describe("matcher", () => {
  it("هیچ شرط missing/has وابسته به هدر در matcher نیست", () => {
    for (const m of config.matcher) expect(typeof m === "string" || (!("missing" in m) && !("has" in m))).toBe(true);
  });
});

describe("پیش از نصب", () => {
  beforeEach(() => void (installed = false));
  const spoofs: Record<string, string>[] = [
    {},
    { purpose: "prefetch" },
    { "next-router-prefetch": "1" },
    { "next-router-prefetch": "1", rsc: "1" },
    { purpose: "prefetch", rsc: "1" },
    { "next-action": "deadbeef", purpose: "prefetch" },
  ];

  it("صفحه‌ی ثبت‌نام همیشه به /install هدایت می‌شود", async () => {
    for (const h of spoofs) {
      const res = await proxy(req("/register", h));
      expect(res.status, JSON.stringify(h)).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/install");
    }
  });

  it("POST (Server Action) به صفحه‌ی ثبت‌نام هم هدایت می‌شود", async () => {
    for (const h of spoofs) {
      const res = await proxy(req("/register", { ...h, "next-action": "abc" }, "POST"));
      expect(res.status, JSON.stringify(h)).toBe(307);
    }
  });

  it("APIها 503 می‌گیرند", async () => {
    for (const h of spoofs) {
      const res = await proxy(req("/api/v1/contracts", h));
      expect(res.status, JSON.stringify(h)).toBe(503);
    }
  });

  it("/install و /api/health باز می‌مانند", async () => {
    for (const p of ["/install", "/api/health", "/api/health/status"]) {
      const res = await proxy(req(p));
      expect(res.status, p).toBe(200);
    }
  });
});

describe("پس از نصب", () => {
  beforeEach(() => void (installed = true));
  it("صفحه‌ی عادی CSP با nonce یکتا می‌گیرد (حتی با هدر prefetch تنها)", async () => {
    const a = await proxy(req("/login"));
    const b = await proxy(req("/login", { purpose: "prefetch" })); // بدون RSC ⇒ میان‌بر فعال نمی‌شود
    const ca = a.headers.get("content-security-policy")!;
    const cb = b.headers.get("content-security-policy")!;
    expect(ca).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(cb).toMatch(/script-src 'self' 'nonce-[^']+'/);
    expect(ca).not.toBe(cb);
    expect(ca).toContain("frame-ancestors 'none'");
  });
  it("پیش‌خوان واقعی RSC بدون ساخت nonce رد می‌شود", async () => {
    const res = await proxy(req("/dashboard", { "next-router-prefetch": "1", rsc: "1" }));
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
  it("frame mode مسیرها: embed=any, landing-preview=self", async () => {
    expect((await proxy(req("/embed/dashboard"))).headers.get("content-security-policy")).toContain("frame-ancestors *");
    expect((await proxy(req("/landing-preview"))).headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
  });
});

describe("isRscPrefetch", () => {
  const g = (h: Record<string, string>) => (n: string) => h[n] ?? null;
  it("فقط وقتی prefetch و RSC با هم باشند", () => {
    expect(isRscPrefetch(g({ "next-router-prefetch": "1", rsc: "1" }))).toBe(true);
    expect(isRscPrefetch(g({ purpose: "Prefetch", rsc: "1" }))).toBe(true);
    expect(isRscPrefetch(g({ purpose: "prefetch" }))).toBe(false);
    expect(isRscPrefetch(g({ rsc: "1" }))).toBe(false);
    expect(isRscPrefetch(g({}))).toBe(false);
  });
});
