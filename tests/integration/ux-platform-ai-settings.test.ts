/**
 * ممیزی عمیق UX: پنل پلتفرم، هوش مصنوعی/RAG و تنظیمات.
 * فایل جدید است؛ هیچ آزمون موجودی تغییر نکرده است.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiGenerations, notifications, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createSession } from "@/modules/auth/session";
import { createWorkspace } from "@/modules/tenancy/service";
import { aiTestConnection } from "@/modules/ai/client";
import { reserveAiQuota } from "@/modules/ai/quota";
import { quotaExhaustedMessage } from "@/modules/ai/quota-status";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { saveKycThresholdAction } from "@/modules/kyc/actions";
import { getKycThreshold, saveKycThreshold } from "@/modules/kyc/service";
import { refundAction } from "@/modules/billing/refund-actions";
import { saveGatewaysAction, saveReferralConfigAction } from "@/modules/payments/actions";
import { getPrefs, savePrefs } from "@/modules/payments/registry";
import { REAL_GATEWAY_IDS } from "@/modules/payments/types";
import { DEFAULT_REFERRAL } from "@/modules/referral/config";
import { getReferralConfig, saveReferralConfig } from "@/modules/referral/service";
import { assignPlanAction } from "@/modules/billing/plan-actions";
import { saveSettingsAction, sendTestEmailAction } from "@/modules/settings/actions";
import { getAllSettings } from "@/modules/settings/service";
import { issueLicenseAction } from "@/modules/license/actions";
import { GET as aiStatus } from "@/app/api/ai/contract/route";
import { POST as aiTestRoute } from "@/app/api/ai/test/route";
import { form, freshBrowser, run, uniq } from "../helpers";

let seq = 0;
async function makeUser(role: "admin" | "user" = "user", label = "ux") {
  const [u] = await db
    .insert(users)
    .values({ name: `${label}-${++seq}`, email: `${uniq("pux")}@example.com`, mobile: `0913${String(5000000 + seq * 13)}`, passwordHash: hashPassword("Pux12345xy"), role, emailVerifiedAt: new Date() })
    .returning();
  const ws = await createWorkspace(u.id, `فضای ${label} ${seq}`);
  return { ...u, ws };
}
async function loginAs(u: { id: number; passwordHash: string }) {
  freshBrowser();
  await createSession(u.id, u.passwordHash);
}
const errorOf = (url?: string) => (url ? new URL(url, "http://x").searchParams.get("error") ?? "" : "");
const param = (url: string | undefined, k: string) => (url ? new URL(url, "http://x").searchParams.get(k) ?? "" : "");

let admin: Awaited<ReturnType<typeof makeUser>>;
let plain: Awaited<ReturnType<typeof makeUser>>;
beforeAll(async () => {
  admin = await makeUser("admin", "مدیرکل");
  plain = await makeUser("user", "مالک");
});
afterAll(async () => {
  // وضعیت سراسری برای فایل‌های بعدی بازگردانده می‌شود
  await savePrefs({ order: [...REAL_GATEWAY_IDS], disabled: [] });
  await saveKycThreshold(0);
  await saveReferralConfig(DEFAULT_REFERRAL);
});
afterEach(() => vi.unstubAllGlobals());

describe("دسترسی به /platform بدون اجازه: پیام روشن به‌جای بازگشت بی‌صدا", () => {
  it("مالک فضای کاری ← /admin?denied=platform ؛ مدیر کل رد نمی‌شود", async () => {
    await loginAs(plain);
    const r = await run(() => requirePlatformAdmin());
    expect(r.redirect).toBe("/admin?denied=platform");
    await loginAs(admin);
    expect((await run(() => requirePlatformAdmin())).redirect).toBeUndefined();
  });
  it("بدون نشست ← ورود", async () => {
    freshBrowser();
    expect((await run(() => requirePlatformAdmin())).redirect).toBe("/login");
  });
});

describe("تنظیمات پلتفرم: موفقیت دروغین و داده‌ی بی‌صدا از دست‌رفته", () => {
  it("آستانه‌ی KYC نامعتبر خطا می‌دهد (پیش‌تر «ذخیره شد» می‌گفت و چیزی ذخیره نمی‌شد)", async () => {
    await loginAs(admin);
    await saveKycThreshold(1_000_000);
    const bad = await run(() => saveKycThresholdAction(form({ threshold: "پنج میلیون" })));
    expect(errorOf(bad.redirect)).toMatch(/آستانه/);
    expect(await getKycThreshold()).toBe(1_000_000);
    const good = await run(() => saveKycThresholdAction(form({ threshold: "۵٬۰۰۰٬۰۰۰" })));
    expect(good.redirect).toContain("saved=kyc");
    expect(await getKycThreshold()).toBe(5_000_000);
    await run(() => saveKycThresholdAction(form({ threshold: "" })));
    expect(await getKycThreshold()).toBe(0);
  });

  it("مبلغ بازپرداخت غیرعددی دیگر «بازپرداخت کامل» تعبیر نمی‌شود", async () => {
    await loginAs(admin);
    for (const amount of ["abc", "۱۲٫۵", "12.5", "-5"]) {
      const r = await run(() => refundAction(form({ paymentId: "999999", amount, reason: "تست", method: "manual" })));
      expect(errorOf(r.redirect), amount).toMatch(/عدد صحیح/);
    }
    // مبلغ معتبر به منطق بازپرداخت می‌رسد (پرداخت وجود ندارد)
    const ok = await run(() => refundAction(form({ paymentId: "999999", amount: "۵۰٬۰۰۰", reason: "تست", method: "manual" })));
    expect(errorOf(ok.redirect)).toMatch(/پیدا نشد|یافت نشد/);
  });

  it("پاداش دعوت با ارقام فارسی همان مقدار را ذخیره می‌کند", async () => {
    await loginAs(admin);
    const r = await run(() => saveReferralConfigAction(form({ referrerWallet: "۴۵٬۰۰۰", referrerCredits: "۲", referredWallet: "۱۰۰۰۰", referredCredits: "۱", milestoneEvery: "۴", milestoneDays: "۱۴", maxRewarded: "۲۵", enabled: "on" })));
    expect(r.redirect).toContain("saved=referral");
    const c = await getReferralConfig();
    expect(c).toMatchObject({ referrerWallet: 45_000, referrerCredits: 2, referredWallet: 10_000, milestoneEvery: 4, milestoneDays: 14, maxRewarded: 25 });
  });

  it("خاموش‌کردن همه‌ی درگاه‌ها هشدار می‌دهد؛ اولویت فارسی اعمال می‌شود", async () => {
    await loginAs(admin);
    const none = await run(() => saveGatewaysAction(form({})));
    expect(none.redirect).toContain("saved=gateways");
    expect(param(none.redirect, "warn")).toMatch(/همه‌ی درگاه‌ها غیرفعال/);
    const fields: Record<string, string> = {};
    REAL_GATEWAY_IDS.forEach((id, i) => {
      fields[`enabled_${id}`] = "on";
      fields[`priority_${id}`] = String(REAL_GATEWAY_IDS.length - i).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
    });
    const ok = await run(() => saveGatewaysAction(form(fields)));
    expect(param(ok.redirect, "warn")).toBe("");
    expect((await getPrefs()).order[0]).toBe(REAL_GATEWAY_IDS[REAL_GATEWAY_IDS.length - 1]);
    expect((await getPrefs()).disabled).toEqual([]);
  });

  it("صدور لایسنس: مدت «۳۶۵» فارسی انقضا می‌گذارد (پیش‌تر بی‌صدا «بدون انقضا» می‌شد)", async () => {
    vi.stubEnv("LICENSE_SERVER_ENABLED", "1");
    await loginAs(admin);
    const r = await issueLicenseAction({}, form({ customerName: "خریدار آزمون", plan: "standard", maxDomains: "۳", expiresInDays: "۳۶۵", updatesInDays: "۱۸۰" }));
    vi.unstubAllEnvs();
    // سرور لایسنس در این محیط ممکن است غیرفعال باشد؛ در هر دو حالت «بدون انقضا»ی بی‌صدا نباید رخ دهد
    if (r.ok) {
      const { db: d } = await import("@/db");
      const { licenseKeys: licenses } = await import("@/db/schema");
      const [row] = await d.select().from(licenses).orderBy(desc(licenses.id)).limit(1);
      expect(row.maxDomains).toBe(3);
      expect(row.expiresAt).toBeTruthy();
    } else {
      expect(r.error).toBeTruthy();
    }
  });
});

describe("اختصاص طرح: پیام نام فضای کاری را می‌گوید و ورودی نامعتبر راهنمایی می‌کند", () => {
  it("متن به‌جای شناسه ← راهنمای انتخاب از فهرست؛ موفقیت ← نام فضای کاری در پیام", async () => {
    await loginAs(admin);
    const txt = await run(() => assignPlanAction(form({ workspaceId: "شرکت آرین", plan: "pro", months: "1", intent: "assign" })));
    expect(errorOf(txt.redirect)).toMatch(/از فهرست/);
    const missing = await run(() => assignPlanAction(form({ workspaceId: "99999999", plan: "pro", months: "1", intent: "assign" })));
    expect(errorOf(missing.redirect)).toMatch(/پیدا نشد/);
    const revoked = await run(() => assignPlanAction(form({ workspaceId: String(plain.ws), intent: "revoke" })));
    expect(param(revoked.redirect, "saved")).toBe("revoked");
    expect(param(revoked.redirect, "ws")).toContain("فضای مالک");
  });
});

describe("تنظیمات عمومی فضای کاری: اعتبارسنجی، هشدار و ایمیل آزمایشی", () => {
  const save = (v: Record<string, string>) => saveSettingsAction({}, form(v));
  it("ایمیل/نام سایت/میزبان نامعتبر ذخیره نمی‌شود و مقدار قبلی می‌ماند", async () => {
    await loginAs(plain);
    const before = (await getAllSettings(plain.ws)).site_name;
    expect(await save({ site_name: "   " })).toMatchObject({ error: expect.stringMatching(/نام سایت/) });
    expect(await save({ admin_email: "oops" })).toMatchObject({ error: expect.stringMatching(/ایمیل مدیر/) });
    expect(await save({ smtp_host: "smtp://mail.example.com" })).toMatchObject({ error: expect.stringMatching(/میزبان/) });
    expect((await getAllSettings(plain.ws)).site_name).toBe(before);
  });
  it("پورت فارسی با مقدار درست ذخیره می‌شود و هشدار ناقص‌بودن برمی‌گردد", async () => {
    await loginAs(plain);
    const r = await save({ site_name: "امضاگیر آزمون", sms_provider: "kavenegar", smtp_port: "۵۸۷" });
    expect(r.saved).toBe(true);
    expect(r.warnings?.join("\n")).toMatch(/کاوه‌نگار/);
    const s = await getAllSettings(plain.ws);
    expect(s.smtp_port).toBe("587");
    expect(s.site_name).toBe("امضاگیر آزمون");
    expect(await save({ sms_provider: "log" })).toMatchObject({ saved: true });
  });
  it("ایمیل آزمایشی: بدون SMTP می‌گوید «فقط در لاگ» و ردیف اعلان ثبت می‌شود", async () => {
    await loginAs(plain);
    await save({ smtp_host: "" });
    const r = await sendTestEmailAction();
    if (process.env.SMTP_HOST) return; // محیطی که SMTP پلتفرم دارد، ارسال واقعی می‌کند
    expect(r.level).toBe("warn");
    expect(r.message).toMatch(/SMTP تنظیم نشده|میزبان SMTP تنظیم نشده/);
    const [n] = await db.select().from(notifications).where(eq(notifications.recipient, plain.email)).orderBy(desc(notifications.id)).limit(1);
    expect(n?.subject).toMatch(/آزمایش ایمیل/);
  });
  it("ایمیل آزمایشی: نرخ محدود است", async () => {
    await loginAs(plain);
    let last = await sendTestEmailAction();
    for (let i = 0; i < 6; i++) last = await sendTestEmailAction();
    expect(last.message).toMatch(/صبر کنید/);
  });
});

describe("هوش مصنوعی: تست اتصال مدل اشتباه را قبل از تولید قرارداد لو می‌دهد", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const post = (body: Record<string, string>) =>
    aiTestRoute(new Request("http://localhost:3000/api/ai/test", { method: "POST", headers: { "content-type": "application/json", host: "localhost:3000" }, body: JSON.stringify(body) }));
  it("مدل در فهرست نیست ← ok همراه warning؛ مدل درست ← بدون warning", async () => {
    await loginAs(plain);
    vi.stubGlobal("fetch", async () => reply({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }));
    const bad = await (await post({ key: "sk-test-123456", baseUrl: "https://api.openai.com/v1", model: "gpt-4", provider: "openai" })).json();
    expect(bad.ok).toBe(true);
    expect(bad.warning).toMatch(/gpt-4/);
    expect(bad.warning).toMatch(/gpt-4o/);
    const good = await (await post({ key: "sk-test-123456", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", provider: "openai" })).json();
    expect(good.ok).toBe(true);
    expect(good.warning).toBeUndefined();
  });
  it("خطای ۴۰۲ سرویس برای کاربر قابل‌فهم است", async () => {
    vi.stubGlobal("fetch", async (url: string) => (String(url).endsWith("/models") ? reply({}, 404) : reply({ error: { message: "insufficient_quota" } }, 402)));
    const r = await aiTestConnection({ key: "sk-test-123456", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", provider: "openai" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/402|پاسخ ناموفق/);
  });
});

describe("سهمیه‌ی AI: وقتی تمام شد، زمان آزادشدن و راه‌حل را می‌گوید", () => {
  it("رزرو رد‌شده resetAt = قدیمی‌ترین مصرف + ۲۴ ساعت دارد", async () => {
    const o = await makeUser("user", "سهمیه");
    const oldest = new Date(Date.now() - 20 * 3600_000);
    for (let i = 0; i < 8; i++) await db.insert(aiGenerations).values({ workspaceId: o.ws, userId: o.id, status: "ok", createdAt: i === 0 ? oldest : new Date(Date.now() - i * 60_000) });
    const r = await reserveAiQuota({ workspaceId: o.ws, userId: o.id, kind: "contract", prompt: "p", model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.limit).toBe(8);
      expect(r.resetAt).toBeTruthy();
      expect(Math.abs(r.resetAt!.getTime() - (oldest.getTime() + 24 * 3600_000))).toBeLessThan(2000);
      const msg = quotaExhaustedMessage(r.limit, r.resetAt);
      expect(msg).toMatch(/۴ ساعت|۵ ساعت|۳ ساعت/);
      expect(msg).toMatch(/ارتقا/);
    }
  });
});

describe("وضعیت دستیار AI: نقش بدون دسترسی تنظیمات به‌جای لینک بن‌بست، راهنمای درست می‌گیرد", () => {
  it("مالک canConfigure=true", async () => {
    await loginAs(plain);
    const res = await aiStatus();
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.canConfigure).toBe(true);
  });
});
