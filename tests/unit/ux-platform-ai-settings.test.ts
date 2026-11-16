/**
 * ممیزی UX: پنل پلتفرم، هوش مصنوعی و تنظیمات — منطق خالص.
 * فایل جدید است؛ هیچ آزمون موجودی تغییر نکرده است.
 */
import { describe, expect, it } from "vitest";
import { aiHttpError, providerMessage } from "@/modules/ai/client";
import { modelWarning, suggestModels } from "@/modules/ai/model-check";
import { quotaExhaustedMessage } from "@/modules/ai/quota-status";
import { friendlySmtpError } from "@/lib/smtp-errors";
import { validateGeneralSettings } from "@/modules/settings/validate";
import { SETTING_KEYS, type SettingKey } from "@/modules/settings/service";
import { DEFAULT_REFERRAL, sanitizeReferralConfig } from "@/modules/referral/config";
import { searchWorkspaces, type WorkspaceOption } from "@/lib/workspace-search";
import { buildActionItems, type ActionCenterInput } from "@/modules/platform/action-center";

const base = (): Record<SettingKey, string> => Object.fromEntries(SETTING_KEYS.map((k) => [k, ""])) as Record<SettingKey, string>;

describe("پیام‌های خطای سرویس هوش مصنوعی: علت + راه‌حل", () => {
  it("پیام‌های قبلی حفظ شده‌اند", () => {
    expect(aiHttpError(401).message).toMatch(/نامعتبر/);
    expect(aiHttpError(429).message).toMatch(/محدودیت/);
    expect(aiHttpError(500, "boom").message).toMatch(/خطای سرویس هوش مصنوعی \(500\)/);
  });
  it("۴۰۲ = اعتبار تمام شده، ۴۰۴/۴۰۰ = مدل نادرست با پیام خود سرویس، ۴۱۳ = متن بزرگ", () => {
    expect(aiHttpError(402).message).toMatch(/شارژ/);
    const nf = aiHttpError(404, JSON.stringify({ error: { message: "The model `gpt-9` does not exist" } })).message;
    expect(nf).toMatch(/\(404\)/);
    expect(nf).toMatch(/gpt-9/);
    expect(aiHttpError(400, JSON.stringify({ error: { message: "bad model" } })).message).toMatch(/نام مدل/);
    expect(aiHttpError(413).message).toMatch(/کوتاه‌تر/);
  });
  it("پیام سرویس: فرمت‌های مختلف، کوتاه‌سازی و حذف کلید احتمالی", () => {
    expect(providerMessage(JSON.stringify({ error: "plain" }))).toBe("plain");
    expect(providerMessage(JSON.stringify([{ error: { message: "gemini style" } }]))).toBe("gemini style");
    expect(providerMessage("<html>nope</html>")).toBe("");
    expect(providerMessage(JSON.stringify({ error: { message: "Incorrect API key provided: sk-abcdef1234567890" } }))).not.toMatch(/abcdef1234/);
    expect(providerMessage(JSON.stringify({ message: "x".repeat(900) })).length).toBeLessThanOrEqual(160);
  });
});

describe("بررسی نام مدل در برابر فهرست زنده", () => {
  const models = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"];
  it("مدل موجود (با/بدون پیشوند models/ و حروف بزرگ) هشدار ندارد", () => {
    expect(modelWarning(models, "gpt-4o")).toBe("");
    expect(modelWarning(["models/gemini-2.5-flash"], "Gemini-2.5-Flash")).toBe("");
  });
  it("مدل ناموجود هشدار و پیشنهاد می‌دهد؛ فهرست خالی یا مدل خالی قضاوت نمی‌کند", () => {
    const w = modelWarning(models, "gpt-4");
    expect(w).toMatch(/gpt-4/);
    expect(w).toMatch(/gpt-4o/);
    expect(modelWarning(models, "totally-unknown")).toMatch(/یکی از مدل‌های فهرست/);
    expect(modelWarning([], "x")).toBe("");
    expect(modelWarning(models, "")).toBe("");
    expect(suggestModels(models, "mini")).toContain("gpt-4o-mini");
  });
});

describe("پیام اتمام سهمیه‌ی AI", () => {
  const now = Date.UTC(2026, 0, 1, 12);
  it("زمان آزادشدن و راه‌حل ارتقا را می‌گوید", () => {
    expect(quotaExhaustedMessage(8, new Date(now + 20 * 60_000), now)).toMatch(/۲۰ دقیقه/);
    expect(quotaExhaustedMessage(8, new Date(now + 5 * 3600_000), now)).toMatch(/۵ ساعت/);
    expect(quotaExhaustedMessage(8, new Date(now + 90 * 60_000), now)).toMatch(/۱ ساعت/);
    expect(quotaExhaustedMessage(8, new Date(now - 1000), now)).toMatch(/۱ دقیقه/);
    const m = quotaExhaustedMessage(8, null, now);
    expect(m).toMatch(/ارتقا/);
    expect(m).toMatch(/سهمیه‌ی ۸ تولید در ۲۴ ساعت/);
  });
});

describe("خطای SMTP قابل‌فهم", () => {
  it.each([
    ["Invalid login: 535 5.7.8 Username and Password not accepted", /رمز/],
    ["error:0A00010B:SSL routines:ssl3_get_record:wrong version number", /پورت/],
    ["getaddrinfo ENOTFOUND smtp.exmple.com", /پیدا نشد/],
    ["connect ECONNREFUSED 1.2.3.4:25", /نپذیرفت/],
    ["Connection timeout", /مهلت/],
    ["self signed certificate", /گواهی/],
    ["میزبان یا پورت SMTP مجاز نیست", /مجاز نیست/],
  ])("%s", (raw, re) => {
    expect(friendlySmtpError(raw)).toMatch(re);
  });
  it("ورودی خالی/ناشناخته", () => {
    expect(friendlySmtpError("")).toMatch(/نامشخص/);
    expect(friendlySmtpError("weird")).toMatch(/weird/);
  });
});

describe("اعتبارسنجی تنظیمات عمومی", () => {
  const run = (v: Partial<Record<SettingKey, string>>, cur = base()) => validateGeneralSettings(v, cur);
  it("نام سایت خالی، ایمیل مدیر و فرستنده‌ی نامعتبر رد می‌شود", () => {
    expect(run({ site_name: "  " })).toMatchObject({ ok: false });
    expect(run({ admin_email: "not-an-email" })).toMatchObject({ ok: false, error: expect.stringMatching(/ایمیل مدیر/) });
    expect(run({ smtp_from: "no at sign" })).toMatchObject({ ok: false });
    expect(run({ smtp_from: "امضاگیر <info@example.com>" })).toMatchObject({ ok: true });
    expect(run({ sms_provider: "evil" })).toMatchObject({ ok: false });
  });
  it("میزبان SMTP با http:// یا پورت چسبیده رد می‌شود", () => {
    for (const h of ["smtp://mail.example.com", "mail.example.com:587", "https://mail.example.com/", "mail example.com"]) expect(run({ smtp_host: h })).toMatchObject({ ok: false });
    expect(run({ smtp_host: "mail.example.com" })).toMatchObject({ ok: true });
  });
  it("پورت فارسی نرمال می‌شود (۴۶۵ ← 465، نه 587)؛ متن نامعتبر رد؛ خالی ← 587", () => {
    const a = run({ smtp_host: "mail.example.com", smtp_port: "۴۶۵" });
    expect(a.ok && a.values.smtp_port).toBe("465");
    expect(run({ smtp_port: "abc" })).toMatchObject({ ok: false });
    const b = run({ smtp_port: "" });
    expect(b.ok && b.values.smtp_port).toBe("587");
  });
  it("هشدارهای ناقص‌بودن (ذخیره می‌شود)", () => {
    const r = run({ sms_provider: "kavenegar", smtp_host: "mail.example.com", smtp_user: "u", smtp_pass: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.join("\n")).toMatch(/کاوه‌نگار/);
      expect(r.warnings.join("\n")).toMatch(/رمز عبور خالی/);
    }
    const mp = run({ sms_provider: "melipayamak", melipayamak_username: "a" });
    expect(mp.ok && mp.warnings.join("\n")).toMatch(/ملی‌پیامک/);
    // کلید ذخیره‌شده‌ی قبلی (فرم خالی فرستاده) هشدار نمی‌دهد
    const cur = { ...base(), kavenegar_api_key: "k-123" };
    const ok = run({ sms_provider: "kavenegar" }, cur);
    expect(ok.ok && ok.warnings.join("\n")).not.toMatch(/کاوه‌نگار/);
  });
});

describe("پاداش دعوت: ارقام فارسی بی‌صدا به پیش‌فرض برنمی‌گردد", () => {
  it("«۴۵٬۰۰۰» ← 45000 و «۲» ← 2 (پیش‌تر پیش‌فرض ۳۰۰۰۰ و ۳ می‌شد)", () => {
    const c = sanitizeReferralConfig({ referrerWallet: "۴۵٬۰۰۰", referrerCredits: "۲", milestoneEvery: "٥", enabled: "on" });
    expect(c.referrerWallet).toBe(45_000);
    expect(c.referrerCredits).toBe(2);
    expect(c.milestoneEvery).toBe(5);
  });
  it("صفر معتبر است؛ خالی/متن نامعتبر ← پیش‌فرض؛ سقف اعمال می‌شود", () => {
    expect(sanitizeReferralConfig({ referrerWallet: "0" }).referrerWallet).toBe(0);
    expect(sanitizeReferralConfig({ referrerWallet: "" }).referrerWallet).toBe(DEFAULT_REFERRAL.referrerWallet);
    expect(sanitizeReferralConfig({ referrerWallet: "abc" }).referrerWallet).toBe(DEFAULT_REFERRAL.referrerWallet);
    expect(sanitizeReferralConfig({ referrerWallet: "۹۹۹۹۹۹۹۹۹" }).referrerWallet).toBe(5_000_000);
  });
});

describe("جستجوی فضای کاری برای مدیر کل", () => {
  const list: WorkspaceOption[] = [
    { id: 12, name: "شرکت آرین", slug: "arian", owner: "ali@example.com", plan: "رایگان" },
    { id: 7, name: "آژانس كاوه", slug: "kaveh", owner: "sara@test.ir", plan: "حرفه‌ای" },
    { id: 120, name: "استودیو", slug: "studio", owner: "ali2@example.com", plan: "رایگان" },
  ];
  it("با نام، ایمیل مالک، شناسه (فارسی هم) و «ي/ك» عربی پیدا می‌شود", () => {
    expect(searchWorkspaces(list, "آرین").map((w) => w.id)).toEqual([12]);
    expect(searchWorkspaces(list, "sara").map((w) => w.id)).toEqual([7]);
    expect(searchWorkspaces(list, "۱۲")[0].id).toBe(12);
    expect(searchWorkspaces(list, "کاوه").map((w) => w.id)).toEqual([7]);
    expect(searchWorkspaces(list, "ali example").map((w) => w.id).sort()).toEqual([12, 120]);
    expect(searchWorkspaces(list, "")).toEqual([]);
    expect(searchWorkspaces(list, "zzz")).toEqual([]);
  });
});

describe("مرکز اقدام مدیر کل", () => {
  const healthy = (): ActionCenterInput => ({
    ticketsWaiting: 0,
    kycPending: 0,
    openIncidents: 0,
    backup: { enabled: true, hasAny: true, lastOk: true, recoveryConfigured: true, insideDataVolume: false },
    gateways: { total: 4, enabled: 2, configured: 1 },
    platformSmtp: true,
  });
  it("وضع سالم = فهرست خالی", () => expect(buildActionItems(healthy())).toEqual([]));
  it("بحرانی‌ها اول می‌آیند و شمارنده/لینک درست دارند", () => {
    const items = buildActionItems({ ...healthy(), ticketsWaiting: 3, kycPending: 2, openIncidents: 1, backup: { enabled: true, hasAny: true, lastOk: false, lastError: "disk full", recoveryConfigured: true, insideDataVolume: false } });
    expect(items.map((i) => i.id)).toEqual(["backup-failed", "health", "tickets", "kyc"]);
    expect(items[0].severity).toBe("critical");
    expect(items[0].detail).toMatch(/disk full/);
    expect(items.find((i) => i.id === "tickets")).toMatchObject({ count: 3, href: "/platform/tickets" });
  });
  it("درگاه: همه غیرفعال یا هیچ‌کدام تنظیم‌نشده = بحرانی", () => {
    expect(buildActionItems({ ...healthy(), gateways: { total: 4, enabled: 0, configured: 0 } })[0]).toMatchObject({ id: "gateways", severity: "critical", title: expect.stringMatching(/غیرفعال/) });
    expect(buildActionItems({ ...healthy(), gateways: { total: 4, enabled: 4, configured: 0 } })[0].title).toMatch(/تنظیم نشده/);
  });
  it("بک‌آپ: نبود نسخه، نبود کلید بازیابی، روی همان دیسک", () => {
    const b = healthy().backup;
    expect(buildActionItems({ ...healthy(), backup: { ...b, hasAny: false, lastOk: null } })[0].id).toBe("backup-none");
    expect(buildActionItems({ ...healthy(), backup: { ...b, recoveryConfigured: false } }).map((i) => i.id)).toContain("recovery-key");
    expect(buildActionItems({ ...healthy(), backup: { ...b, insideDataVolume: true } }).map((i) => i.id)).toContain("backup-inside");
    expect(buildActionItems({ ...healthy(), backup: { ...b, enabled: false } }).map((i) => i.id)).toContain("backup-off");
  });
});
