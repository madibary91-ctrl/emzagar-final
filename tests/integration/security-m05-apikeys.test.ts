import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { generateKey, authenticateApi } from "@/modules/api/service";
import { ALL_SCOPES, DEFAULT_NEW_KEY_SCOPES, parseScopes, requiredScope, serializeScopes } from "@/modules/api/scopes";
import { ipAllowed, parseIpAllowlist } from "@/modules/api/ip-allowlist";
import { GET as statsGET } from "@/app/api/v1/stats/route";
import { GET as templatesGET } from "@/app/api/v1/templates/route";
import { GET as contractsGET, POST as contractsPOST } from "@/app/api/v1/contracts/route";
import { POST as handshakePOST } from "@/app/api/v1/sync/handshake/route";
import { POST as ssoPOST } from "@/app/api/v1/connect/sso/route";
import { setupWorkspace } from "../flows";
import { uniq } from "../helpers";

let wsId = 0;
const ORIGIN = "http://localhost:3000";

async function mkKey(over: Partial<typeof apiKeys.$inferInsert> = {}) {
  const k = generateKey();
  await db.insert(apiKeys).values({ workspaceId: wsId, name: uniq("k"), prefix: k.prefix, keyHash: k.hash, ...over });
  return k.plain;
}
const req = (path: string, key: string, init: RequestInit & { ip?: string } = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "x-forwarded-for": init.ip ?? "10.50.0.1", "content-type": "application/json" } });

beforeAll(async () => {
  wsId = (await setupWorkspace("API scopes")).wsId;
});

describe("M-05: نگاشت مسیر ← scope (یک نقطه، fail-closed)", () => {
  it("scope لازم هر endpoint درست استخراج می‌شود", () => {
    expect(requiredScope("GET", "/api/v1/contracts")).toBe("contracts:read");
    expect(requiredScope("POST", "/api/v1/contracts")).toBe("contracts:write");
    expect(requiredScope("GET", "/api/v1/contracts/12")).toBe("contracts:read");
    expect(requiredScope("GET", "/api/v1/contracts/12/pdf")).toBe("contracts:read");
    expect(requiredScope("POST", "/api/v1/contracts/12/cancel")).toBe("contracts:write");
    expect(requiredScope("POST", "/api/v1/contracts/12/remind")).toBe("contracts:write");
    expect(requiredScope("GET", "/api/v1/templates")).toBe("templates:read");
    expect(requiredScope("GET", "/api/v1/stats")).toBe("stats:read");
    expect(requiredScope("POST", "/api/v1/sync/handshake")).toBe("sync");
    expect(requiredScope("POST", "/api/v1/connect/sso")).toBe("connect");
    expect(requiredScope("GET", "/api/v1/hub/pipeline")).toBe("hub");
  });
  it("مسیر/متد ناشناخته رد می‌شود (endpoint جدید بدون تعریف scope دسترسی رایگان نمی‌دهد)", () => {
    expect(requiredScope("GET", "/api/v1/new-thing")).toBeNull();
    expect(requiredScope("DELETE", "/api/v1/contracts/1")).toBeNull();
    expect(requiredScope("PUT", "/api/v1/templates")).toBeNull();
    expect(requiredScope("GET", "/api/v1/contracts/1/cancel")).toBeNull();
    expect(requiredScope("POST", "/api/v1/stats")).toBeNull();
  });
  it("parse/serialize: مقدارهای ناشناخته حذف می‌شوند", () => {
    expect([...parseScopes("contracts:read, hub ,evil,*,")].sort()).toEqual(["contracts:read", "hub"]);
    expect(serializeScopes(["hub", "contracts:read", "nope"])).toBe("contracts:read,hub");
    expect(DEFAULT_NEW_KEY_SCOPES.every((s) => !["sync", "connect", "contracts:write"].includes(s))).toBe(true);
    expect(ALL_SCOPES).toContain("connect");
  });
});

describe("M-05: اعمال scope روی endpointهای واقعی", () => {
  it("کلید فقط‌خواندنی: GET مجاز، صدور قرارداد/همگام‌سازی/SSO ممنوع (۴۰۳)", async () => {
    const key = await mkKey({ scopes: "contracts:read,stats:read", expiresAt: new Date(Date.now() + 86400_000) });
    expect((await statsGET(req("/api/v1/stats", key))).status).toBe(200);
    expect((await contractsGET(req("/api/v1/contracts", key))).status).toBe(200);
    expect((await templatesGET(req("/api/v1/templates", key))).status).toBe(403); // templates:read ندارد
    const post = await contractsPOST(req("/api/v1/contracts", key, { method: "POST", body: JSON.stringify({ templateId: 1 }) }));
    expect(post.status).toBe(403);
    expect(((await post.json()) as { error: string }).error).toBe("insufficient_scope");
    expect((await handshakePOST(req("/api/v1/sync/handshake", key, { method: "POST", body: "{}" }))).status).toBe(403); // راز HMAC بدون scope «sync» داده نمی‌شود
    expect((await ssoPOST(req("/api/v1/connect/sso", key, { method: "POST", body: "{}" }))).status).toBe(403);
  });
  it("کلید قدیمی (پیش‌فرض ستون) سازگار می‌ماند؛ ولی صدور با scope جدا کنترل می‌شود", async () => {
    const legacy = await mkKey(); // بدون scopes/expires صریح = رفتار قبلی
    expect((await statsGET(req("/api/v1/stats", legacy))).status).toBe(200);
    expect((await templatesGET(req("/api/v1/templates", legacy))).status).toBe(200);
  });
  it("کلید منقضی‌شده ۴۰۱ می‌گیرد (و کلید عادی بدون انقضا قدیمی می‌ماند)", async () => {
    const key = await mkKey({ expiresAt: new Date(Date.now() - 1000) });
    const r = await statsGET(req("/api/v1/stats", key));
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe("api_key_expired");
  });
  it("کلید باطل‌شده و نامعتبر ۴۰۱", async () => {
    const key = await mkKey({ active: false });
    expect((await statsGET(req("/api/v1/stats", key))).status).toBe(401);
    expect((await statsGET(req("/api/v1/stats", `emz_${"0".repeat(48)}`))).status).toBe(401);
  });
  it("فهرست مجاز IP: فقط IP/CIDR مجاز، IP نامعلوم رد", async () => {
    const key = await mkKey({ allowedIps: "203.0.113.7, 198.51.100.0/24" });
    expect((await statsGET(req("/api/v1/stats", key, { ip: "203.0.113.7" }))).status).toBe(200);
    expect((await statsGET(req("/api/v1/stats", key, { ip: "198.51.100.200" }))).status).toBe(200);
    const bad = await statsGET(req("/api/v1/stats", key, { ip: "203.0.113.8" }));
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as { error: string }).error).toBe("ip_not_allowed");
  });
  it("ثبت آخرین استفاده throttle می‌شود و IP را ذخیره می‌کند", async () => {
    const key = await mkKey();
    const hash = generateKeyHash(key);
    await statsGET(req("/api/v1/stats", key, { ip: "10.50.9.9" }));
    const [a] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
    expect(a.lastUsedIp).toBe("10.50.9.9");
    const first = a.lastUsedAt!.getTime();
    await new Promise((r) => setTimeout(r, 15));
    await statsGET(req("/api/v1/stats", key, { ip: "10.50.9.9" })); // همان IP، زیر ۵ دقیقه → UPDATE نمی‌خورد
    const [b] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
    expect(b.lastUsedAt!.getTime()).toBe(first);
  });
  it("محدودیت نرخ پایدار به‌ازای هر کلید (۶۰ در دقیقه) و حدس کلید نامعتبر به‌ازای IP", async () => {
    const key = await mkKey();
    let last = 200;
    for (let i = 0; i < 62; i++) last = (await statsGET(req("/api/v1/stats", key, { ip: "10.50.7.7" }))).status;
    expect(last).toBe(429);
    let guess = 401;
    for (let i = 0; i < 33; i++) guess = (await statsGET(req("/api/v1/stats", `emz_${String(i).padStart(48, "a")}`.slice(0, 52), { ip: "10.50.8.8" }))).status;
    expect(guess).toBe(429);
  });
  it("authenticateApi: scope صریح (override) و مسیر ناشناخته", async () => {
    const key = await mkKey({ scopes: "stats:read" });
    const unknown = await authenticateApi(new Request(`${ORIGIN}/api/v1/whatever`, { headers: { authorization: `Bearer ${key}` } }));
    expect(unknown).toMatchObject({ ok: false, status: 403 });
    const forced = await authenticateApi(new Request(`${ORIGIN}/api/v1/whatever`, { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "10.50.6.6" } }), { scope: "stats:read" });
    expect(forced).toMatchObject({ ok: true });
  });
});

describe("M-05: فهرست IP", () => {
  it("تجزیه و تطبیق IPv4/IPv6/CIDR", () => {
    expect(parseIpAllowlist("1.2.3.4, 10.0.0.0/8, 2001:db8::/32, bad, 1.2.3.4/99")).toMatchObject({ invalid: ["bad", "1.2.3.4/99"] });
    expect(ipAllowed("", "9.9.9.9")).toBe(true);
    expect(ipAllowed("10.0.0.0/8", "10.200.1.1")).toBe(true);
    expect(ipAllowed("10.0.0.0/8", "11.0.0.1")).toBe(false);
    expect(ipAllowed("2001:db8::/32", "2001:db8::5")).toBe(true);
    expect(ipAllowed("1.2.3.4", "::ffff:1.2.3.4")).toBe(true);
    expect(ipAllowed("1.2.3.4", "unknown")).toBe(false);
  });
});

import crypto from "node:crypto";
function generateKeyHash(plain: string) {
  return crypto.createHash("sha256").update(plain).digest("hex");
}
