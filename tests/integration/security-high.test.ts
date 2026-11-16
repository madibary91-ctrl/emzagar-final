import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { apiKeys, notifications, templates, users, workspaceInvites, workspaceMembers, wpConnections } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { forgotPasswordAction } from "@/modules/auth/actions";
import { completeHandshake, startHandshake } from "@/modules/connect/service";
import { acceptInvite } from "@/modules/tenancy/invites";
import { ensureClient, listWorkspaceUsers } from "@/modules/tenancy/service";
import { POST as issuePOST } from "@/app/api/v1/contracts/route";
import { generateKey } from "@/modules/api/service";

import { setupWorkspace } from "../flows";
import { env, form, freshBrowser, uniq } from "../helpers";

// فقط APP_URL محیط معیار «آدرس مورد اعتماد» باشد
vi.mock("@/lib/config", async (orig) => {
  const m = await orig<typeof import("@/lib/config")>();
  return {
    ...m,
    trustedAppOrigin: () => {
      const v = String(process.env.APP_URL || "").replace(/\/+$/, "");
      return /^https?:\/\/[A-Za-z0-9.\-:]+$/.test(v) ? v : "";
    },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  env.headers.delete("host");
  env.headers.delete("x-forwarded-host");
});

describe("SEC-01 — لینک بازیابی رمز با هدر Host مهاجم ساخته نمی‌شود", () => {
  it("بدون APP_URL: توکن صادر و ایمیلی ارسال نمی‌شود؛ با APP_URL لینک روی دامنه‌ی مورد اعتماد است", async () => {
    const { owner } = await setupWorkspace();
    const [victim] = await db.insert(users).values({ name: "قربانی", email: `${uniq("v")}@example.com`, mobile: "09121234567", passwordHash: hashPassword("Victim123x"), role: "user", emailVerifiedAt: new Date() }).returning();
    void owner;

    freshBrowser();
    env.headers.set("host", "evil.example");
    env.headers.set("x-forwarded-host", "evil.example");
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const r1 = await forgotPasswordAction({}, form({ email: victim.email }));
    expect(r1.ok).toBe(true); // پاسخ عمومی (ضد شمارش ایمیل)
    expect(r1.devLink).toBeUndefined();
    const mails = await db.select().from(notifications).where(eq(notifications.recipient, victim.email));
    expect(mails.filter((m) => /evil\.example/.test(JSON.stringify(m)))).toHaveLength(0);
    expect(mails).toHaveLength(0);

    vi.unstubAllEnvs();
    freshBrowser();
    env.headers.set("host", "evil.example");
    const r2 = await forgotPasswordAction({}, form({ email: victim.email }));
    expect(r2.ok).toBe(true);
    const sent = await db.select().from(notifications).where(eq(notifications.recipient, victim.email));
    expect(sent.length).toBeGreaterThan(0);
    const blob = JSON.stringify(sent);
    expect(blob).toContain("localhost:3000/reset/");
    expect(blob).not.toContain("evil.example");
  });
});

describe("SEC-03 — ساخت Workspace ناشناس", () => {
  const body = (siteUrl: string) => ({ installId: Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""), siteUrl, siteName: "x", adminEmail: `${uniq("w")}@example.com`, adminName: "m", pluginVersion: "2", wpVersion: "6", wcActive: false, locale: "fa_IR" });

  it("آدرس http روی دامنه‌ی عمومی بدون تایید مالکیت هرگز فضای کاری نمی‌سازد", async () => {
    const hs = await startHandshake(body(`http://${uniq("evil")}.com`));
    expect(hs.mode).toBe("verify");
    const before = await db.select().from(wpConnections);
    await expect(completeHandshake(hs.handshakeId)).rejects.toMatchObject({ code: "site_unreachable" });
    expect(await db.select().from(wpConnections)).toHaveLength(before.length);
  });

  it("حالت Sandbox روی production خاموش است (مگر ALLOW_SANDBOX_CONNECT=1) و فقط برای سایت محلی", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(startHandshake(body("http://localhost:8080"))).rejects.toMatchObject({ code: "sandbox_disabled" });
    await expect(startHandshake(body(`https://${uniq("s")}.test`))).rejects.toMatchObject({ code: "sandbox_disabled" });
    vi.stubEnv("ALLOW_SANDBOX_CONNECT", "1");
    expect((await startHandshake(body("http://localhost:8080"))).mode).toBe("sandbox");
    vi.unstubAllEnvs();
    expect((await startHandshake(body(`http://${uniq("dev")}.test`))).mode).toBe("sandbox");
  });

  it("handshake ساخته‌شده‌ی قبلی هم روی production بدون جفت‌سازی تکمیل نمی‌شود", async () => {
    const hs = await startHandshake(body(`http://${uniq("late")}.test`));
    vi.stubEnv("NODE_ENV", "production");
    await expect(completeHandshake(hs.handshakeId)).rejects.toMatchObject({ code: "sandbox_disabled" });
  });
});

describe("SEC-06 — نشت PII با ensureClient", () => {
  it("حساب موجود با ایمیل به فضای کاری مهاجم وصل نمی‌شود و نام/موبایلش دیده نمی‌شود؛ فقط با رضایت خودش", async () => {
    const victimWs = await setupWorkspace("فضای قربانی");
    const attacker = await setupWorkspace("فضای مهاجم");
    const email = `${uniq("victim")}@example.com`;
    const v = await ensureClient(victimWs.wsId, { name: "نام واقعی قربانی", email, mobile: "09129998877" });
    expect(v.created).toBe(true);

    const r = await ensureClient(attacker.wsId, { name: "x", email, mobile: "09120000000" });
    expect(r).toMatchObject({ userId: 0, linked: false, created: false, consentRequired: true });
    expect(r.inviteToken).toMatch(/^[a-f0-9]{64}$/);
    const roster = JSON.stringify(await listWorkspaceUsers(attacker.wsId));
    expect(roster).not.toContain("نام واقعی قربانی");
    expect(roster).not.toContain("09129998877");
    expect(roster).not.toContain(email);
    expect(await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, attacker.wsId), eq(workspaceMembers.userId, v.userId)))).toHaveLength(0);
    // حساب قربانی دست‌نخورده است
    const [still] = await db.select().from(users).where(eq(users.id, v.userId));
    expect(still).toMatchObject({ name: "نام واقعی قربانی", mobile: "09129998877" });

    // تکرار پشت‌سرهم: دعوت/ایمیل تازه‌ای ساخته نمی‌شود (ضد اسپم)
    const again = await ensureClient(attacker.wsId, { name: "x", email, mobile: "09120000000" });
    expect(again.consentRequired).toBe(true);
    expect(again.inviteToken).toBeUndefined();
    expect(await db.select().from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, attacker.wsId), eq(workspaceInvites.email, email)))).toHaveLength(1);

    // با رضایت صاحب حساب (ورود + پذیرش دعوت) عضویت ثبت می‌شود
    expect(await acceptInvite(r.inviteToken as string, v.userId + 99999)).toBeNull();
    expect(await acceptInvite(r.inviteToken as string, v.userId)).toEqual({ workspaceId: attacker.wsId });
    expect(await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, attacker.wsId), eq(workspaceMembers.userId, v.userId)))).toHaveLength(1);
    const ok = await ensureClient(attacker.wsId, { name: "x", email, mobile: "09120000000" });
    expect(ok).toMatchObject({ userId: v.userId, consentRequired: false });
  });

  it("API صدور قرارداد با کلید + ایمیل قربانی: ۴۰۹ و بدون هیچ داده‌ی قربانی", async () => {
    const victimWs = await setupWorkspace("ق");
    const attacker = await setupWorkspace("م");
    const email = `${uniq("v2")}@example.com`;
    await ensureClient(victimWs.wsId, { name: "قربانی محرمانه", email, mobile: "09127776655" });
    const k = generateKey();
    await db.insert(apiKeys).values({ workspaceId: attacker.wsId, name: "t", prefix: k.prefix, keyHash: k.hash, createdBy: attacker.owner.id });
    const [tpl] = await db.select().from(templates).where(eq(templates.workspaceId, attacker.wsId)).limit(1);
    const res = await issuePOST(new Request("http://localhost:3000/api/v1/contracts", { method: "POST", headers: { authorization: `Bearer ${k.plain}`, "content-type": "application/json" }, body: JSON.stringify({ templateId: tpl.id, customer: { name: "x", email, mobile: "09120001111" } }) }));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("customer_consent_required");
    expect(text).not.toContain("قربانی محرمانه");
    expect(text).not.toContain("09127776655");
    expect(JSON.stringify(await listWorkspaceUsers(attacker.wsId))).not.toContain("قربانی محرمانه");
  });
});

beforeAll(() => freshBrowser());
