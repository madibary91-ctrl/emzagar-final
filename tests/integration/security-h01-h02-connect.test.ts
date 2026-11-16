import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, userTotp, users, workspaceMembers, wpConnections } from "@/db/schema";
import { CONNECT_OWNER_EMAIL_RE, completeHandshake, startHandshake } from "@/modules/connect/service";
import { consumeSsoToken, createSsoToken, isSsoEligibleOwner } from "@/modules/connect/service/tokens";
import { createWorkspace } from "@/modules/tenancy/service";
import { getSetting } from "@/modules/settings/service";
import { registerAction } from "@/modules/auth/actions";
import { GET as ssoGET } from "@/app/connect/sso/route";
import { POST as mintPOST } from "@/app/api/v1/connect/sso/route";
import { env, form, freshBrowser, run, uniq } from "../helpers";

/**
 * H-02 — ایمیل ادعاشده‌ی مدیر وردپرس هرگز هویت حساب نمی‌شود (Email Squatting).
 * H-01 — کلید API هم‌ارز «ورود با رمز» نیست: SSO فقط برای حساب مالکِ تصاحب‌نشده‌ی اتصال خودکار، فقط همان یک فضای کاری،
 *        بدون 2FA، و توکن به کلید صادرکننده گره خورده و هنگام مصرف دوباره سنجیده می‌شود.
 */
async function connect(adminEmail: string) {
  const hs = await startHandshake({ installId: crypto.randomBytes(16).toString("hex"), siteUrl: `http://${uniq("wp")}.test`, siteName: "سایت آزمون", adminEmail, adminName: "مدیر", pluginVersion: "2.0.0", wpVersion: "6.7", wcActive: false, locale: "fa_IR" });
  const done = await completeHandshake(hs.handshakeId);
  const [conn] = await db.select().from(wpConnections).where(eq(wpConnections.workspaceId, done.workspaceId));
  return { ...done, conn, keyId: conn.apiKeyId!, ownerId: conn.ownerUserId! };
}
const ssoReq = (t: string) => new Request(`http://localhost:3000/connect/sso?t=${t}&to=admin`);

describe("H-02 — اتصال خودکار با ایمیل دلخواه حساب نمی‌سازد", () => {
  it("ایمیل تازه‌ی ادعاشده: هیچ کاربری با آن ایمیل ساخته نمی‌شود؛ مالک placeholder تأییدنشده و بی‌ایمیل مدیریتی است", async () => {
    const claimed = `${uniq("victim")}@example.com`;
    const c = await connect(claimed);
    expect(await db.select().from(users).where(eq(users.email, claimed))).toHaveLength(0);
    const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
    expect(owner.email).toMatch(CONNECT_OWNER_EMAIL_RE);
    expect(owner.emailVerifiedAt).toBeNull();
    expect(await getSetting("admin_email", c.workspaceId)).toBe("");
  });

  it("ایمیل حساب موجود (تأییدشده یا نه) دست‌نخورده می‌ماند و به مهاجم وصل نمی‌شود", async () => {
    const [victim] = await db.insert(users).values({ name: "قربانی", email: `${uniq("real")}@example.com`, mobile: "09120000000", passwordHash: "x:y", role: "user" }).returning();
    const c = await connect(victim.email);
    expect(c.ownerId).not.toBe(victim.id);
    const members = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, victim.id));
    expect(members).toHaveLength(0);
  });

  it("قربانی بعداً با همان ایمیل ثبت‌نام می‌کند: حساب تازه و فضای کاری خودش را می‌گیرد، نه فضای آلوده‌ی مهاجم؛ کلید مهاجم روی فضای او اثری ندارد", async () => {
    const claimed = `${uniq("victim2")}@example.com`;
    const c = await connect(claimed);
    freshBrowser();
    await run(() => registerAction({}, form({ name: "قربانی", email: claimed, mobile: "09123456789", password: "Passw0rdX9", workspaceName: "فضای قربانی" })));
    const [v] = await db.select().from(users).where(eq(users.email, claimed));
    expect(v).toBeDefined();
    expect(v.id).not.toBe(c.ownerId);
    const memberships = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, v.id));
    expect(memberships.map((m) => m.workspaceId)).not.toContain(c.workspaceId);
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, c.keyId));
    expect(key.workspaceId).toBe(c.workspaceId);
    expect(key.workspaceId).not.toBe(memberships[0].workspaceId);
  });
});

describe("H-01 — SSO فقط برای مالک تصاحب‌نشده‌ی اتصال خودکار", () => {
  it("مسیر سالم: توکن صادر، یک‌بار مصرف و نشست ساخته می‌شود", async () => {
    const c = await connect(`${uniq("ok")}@example.com`);
    expect(await isSsoEligibleOwner(c.ownerId, c.workspaceId)).toBe(true);
    const t = await createSsoToken(c.keyId, c.workspaceId);
    expect(t).toMatch(/^[a-f0-9]{64}$/);
    freshBrowser();
    const r = await run(() => ssoGET(ssoReq(t!)));
    expect(r.redirect).toBe("/admin");
    expect(env.cookies.has("amz_session")).toBe(true);
    // بازپخش همان توکن
    freshBrowser();
    const again = await run(() => ssoGET(ssoReq(t!)));
    expect(again.redirect).toBe("/login?sso=expired");
    expect(env.cookies.has("amz_session")).toBe(false);
  });

  it("حساب واقعی (ایمیل غیر-placeholder) هرگز با کلید API نشست نمی‌گیرد", async () => {
    const c = await connect(`${uniq("real1")}@example.com`);
    await db.update(users).set({ email: `${uniq("human")}@example.com` }).where(eq(users.id, c.ownerId));
    expect(await createSsoToken(c.keyId, c.workspaceId)).toBeNull();
  });

  it("مالکی که ایمیلش تأیید شده (تصاحب شده) SSO ندارد", async () => {
    const c = await connect(`${uniq("claim")}@example.com`);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, c.ownerId));
    expect(await createSsoToken(c.keyId, c.workspaceId)).toBeNull();
  });

  it("مالک با ورود دومرحله‌ی فعال: SSO هرگز 2FA را دور نمی‌زند", async () => {
    const c = await connect(`${uniq("tfa")}@example.com`);
    await db.insert(userTotp).values({ userId: c.ownerId, secret: "x", enabledAt: new Date() });
    expect(await createSsoToken(c.keyId, c.workspaceId)).toBeNull();
  });

  it("مالک عضو فضای کاری دیگری هم باشد (دسترسی به چند فضا) SSO بسته است", async () => {
    const c = await connect(`${uniq("multi")}@example.com`);
    await createWorkspace(c.ownerId, "فضای دوم");
    expect(await createSsoToken(c.keyId, c.workspaceId)).toBeNull();
  });

  it("مدیر کل پلتفرم و مهمان SSO ندارند", async () => {
    const c = await connect(`${uniq("adm")}@example.com`);
    await db.update(users).set({ role: "admin" }).where(eq(users.id, c.ownerId));
    expect(await createSsoToken(c.keyId, c.workspaceId)).toBeNull();
    await db.update(users).set({ role: "user", isGuest: true }).where(eq(users.id, c.ownerId));
    expect(await createSsoToken(c.keyId, c.workspaceId)).toBeNull();
  });

  it("کلید فضای کاری دیگر برای فضای کاری غیرمرتبط توکن نمی‌سازد", async () => {
    const a = await connect(`${uniq("a")}@example.com`);
    const b = await connect(`${uniq("b")}@example.com`);
    expect(await createSsoToken(a.keyId, b.workspaceId)).toBeNull();
  });

  it("توکن صادرشده، هنگام مصرف دوباره سنجیده می‌شود: ابطال کلید یا تصاحب حساب بعد از صدور توکن را بی‌اثر می‌کند", async () => {
    const c1 = await connect(`${uniq("late1")}@example.com`);
    const t1 = (await createSsoToken(c1.keyId, c1.workspaceId))!;
    await db.update(apiKeys).set({ active: false }).where(eq(apiKeys.id, c1.keyId));
    expect(await consumeSsoToken(t1)).toBeNull();

    const c2 = await connect(`${uniq("late2")}@example.com`);
    const t2 = (await createSsoToken(c2.keyId, c2.workspaceId))!;
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, c2.ownerId));
    expect(await consumeSsoToken(t2)).toBeNull();

    const c3 = await connect(`${uniq("late3")}@example.com`);
    const t3 = (await createSsoToken(c3.keyId, c3.workspaceId))!;
    await db.update(wpConnections).set({ status: "disconnected" }).where(and(eq(wpConnections.id, c3.conn.id)));
    expect(await consumeSsoToken(t3)).toBeNull();
  });

  it("نقطه‌ی صدور: برای مالک واجد شرایط URL ورود یک‌کلیکی؛ برای حساب تصاحب‌شده فقط صفحه‌ی ورود عادی (رمز + 2FA)", async () => {
    const c = await connect(`${uniq("mint")}@example.com`);
    const mint = async () => (await (await mintPOST(new Request("http://localhost:3000/api/v1/connect/sso", { method: "POST", headers: { authorization: `Bearer ${c.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ target: "admin" }) }))).json()) as { sso: boolean; url: string };
    const ok = await mint();
    expect(ok.sso).toBe(true);
    expect(ok.url).toMatch(/\/connect\/sso\?t=[a-f0-9]{64}/);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, c.ownerId));
    const after = await mint();
    expect(after.sso).toBe(false);
    expect(after.url).toMatch(/\/login\?next=/);
  });

  it("سقف صدور توکن به‌ازای هر کلید: انبوه‌سازی توکن با کلید لورفته مهار می‌شود", async () => {
    const c = await connect(`${uniq("flood")}@example.com`);
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await mintPOST(new Request("http://localhost:3000/api/v1/connect/sso", { method: "POST", headers: { authorization: `Bearer ${c.apiKey}`, "content-type": "application/json" }, body: "{}" }))).status);
    expect(codes.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(codes.slice(10).every((s) => s === 429)).toBe(true);
  });
});
