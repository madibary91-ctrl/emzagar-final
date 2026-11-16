"use server";

import { revalidatePath } from "next/cache";
import { requireTeam } from "@/modules/tenancy/context";
import { SETTING_KEYS, SECRET_SETTING_KEYS, saveSettings, getAllSettings, isApprovalsEnabled, type SettingKey } from "./service";
import { clearDraftApprovals } from "@/modules/contracts/approvals";
import { logAudit } from "@/modules/audit/service";
import { assertPublicHost } from "@/lib/ssrf";
import { isAllowedSmtpPort, parseSmtpPort, SMTP_PORT_ALLOWLIST } from "@/lib/smtp-guard";
import { verifyAppUrlOwnership } from "./app-url";
import { validateGeneralSettings } from "./validate";
import { friendlySmtpError } from "@/lib/smtp-errors";
import { sendMail } from "@/modules/mail";
import { rateLimit } from "@/lib/rate-limit";
import { escapeHtml } from "@/lib/html";

// approvals_enabled فقط از کلید مستقل خودش (setApprovalsEnabledAction) عوض می‌شود تا ذخیره‌ی فرم عمومی آن را ناخواسته خاموش نکند
// app_url_proof فقط توسط سرور (پس از تأیید مالکیت دامنه) نوشته می‌شود؛ هرگز از فرم پذیرفته نمی‌شود (M-08)
const PROTECTED_KEYS: SettingKey[] = ["brand_logo_file", "brand_logo_v", "approvals_enabled", "app_url_proof"];

export type SettingsState = { saved?: boolean; error?: string; warnings?: string[] };

export async function saveSettingsAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const admin = await requireTeam("settings");
  const current = await getAllSettings(admin.workspaceId);
  const values: Partial<Record<SettingKey, string>> = {};
  for (const key of SETTING_KEYS) {
    if (!formData.has(key)) continue;
    if ((PROTECTED_KEYS as string[]).includes(key)) continue;
    const v = String(formData.get(key) ?? "").trim();
    // فیلدهای محرمانه: اگر خالی ارسال شد مقدار قبلی حفظ شود
    if (SECRET_SETTING_KEYS.includes(key) && v === "") {
      values[key] = current[key];
    } else {
      values[key] = v;
    }
  }
  const checked = validateGeneralSettings(values, current);
  if (!checked.ok) return { error: checked.error };
  Object.assign(values, checked.values);
  if (values.app_url) {
    try {
      const u = new URL(values.app_url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      values.app_url = u.origin;
    } catch {
      return { error: "آدرس سایت نامعتبر است (مثال: https://sign.example.com)" };
    }
    // M-08: آدرس پایه‌ی لینک‌های امضا/پرداخت فقط برای دامنه‌ی «تأییدشده» پذیرفته می‌شود (مالکیت از راه DNS TXT)
    if (values.app_url !== current.app_url) {
      const own = await verifyAppUrlOwnership(admin.workspaceId, values.app_url);
      if (!own.ok) return { error: own.error };
      values.app_url_proof = own.proof;
    }
  } else if (values.app_url === "") {
    values.app_url_proof = "";
  }

  // جلوگیری از اسکن شبکه‌ی داخلی از طریق میزبان SMTP دلخواه
  if (values.smtp_host) {
    try {
      await assertPublicHost(values.smtp_host);
    } catch (e) {
      return { error: `میزبان SMTP نامعتبر است: ${e instanceof Error ? e.message : ""}` };
    }
    // M-01: پورت فقط از فهرست سفید (مانع اسکن پورت/اتصال به Redis، Postgres و …)؛ اتصال واقعی هم هنگام ارسال دوباره بررسی می‌شود
    if (!isAllowedSmtpPort(parseSmtpPort(values.smtp_port))) return { error: `پورت SMTP باید یکی از ${SMTP_PORT_ALLOWLIST.join("، ")} باشد` };
  }
  await saveSettings(values, admin.workspaceId);
  await logAudit({ workspaceId: admin.workspaceId, action: "settings.saved", userId: admin.id });
  revalidatePath("/admin/settings");
  return { saved: true, warnings: checked.warnings };
}

export type TestEmailState = { ok?: boolean; level?: "success" | "warn" | "error"; message?: string };

/**
 * «ارسال ایمیل آزمایشی» به خود مدیر با تنظیمات «ذخیره‌شده».
 * پیش‌تر تنها راه فهمیدن غلط‌بودن SMTP، شکست خوردن ارسال لینک امضا برای مشتری واقعی بود.
 */
export async function sendTestEmailAction(): Promise<TestEmailState> {
  const admin = await requireTeam("settings");
  if (!rateLimit(`settings-test-mail:${admin.id}`, 5, 60_000).ok) return { level: "warn", message: "آزمایش‌های پشت‌سرهم زیاد بود؛ یک دقیقه صبر کنید." };
  const r = await sendMail({
    to: admin.email,
    workspaceId: admin.workspaceId,
    subject: "آزمایش ایمیل — امضاگیر",
    html: `<div dir="rtl" style="font-family:Tahoma,sans-serif"><p>سلام ${escapeHtml(admin.name)}،</p><p>این ایمیل آزمایشی است؛ اگر آن را می‌بینید تنظیمات ایمیل سایت درست کار می‌کند.</p></div>`,
  });
  await logAudit({ workspaceId: admin.workspaceId, userId: admin.id, action: "settings.test_email", detail: r.status });
  if (r.status === "sent") return { ok: true, level: "success", message: `ایمیل آزمایشی به ${admin.email} ارسال شد. صندوق ورودی (و پوشه‌ی هرزنامه) را بررسی کنید.` };
  if (r.status === "logged") return { level: "warn", message: "میزبان SMTP تنظیم نشده است؛ ایمیل فقط در لاگ ثبت شد و به کسی نمی‌رسد. میزبان SMTP را وارد و «ذخیره» کنید، سپس دوباره آزمایش کنید." };
  return { level: "error", message: friendlySmtpError(r.error) };
}

export type ToggleState = { enabled: boolean; error?: string; message?: string };

/** کلید «تأیید داخلی پیش از انتشار» (پیش‌فرض خاموش). خاموش‌کردن، درخواست‌های تأییدِ باز پیش‌نویس‌ها را پاک می‌کند. */
export async function setApprovalsEnabledAction(_prev: ToggleState, formData: FormData): Promise<ToggleState> {
  const admin = await requireTeam("settings");
  const want = formData.get("enabled") === "1";
  const before = await isApprovalsEnabled(admin.workspaceId);
  await saveSettings({ approvals_enabled: want ? "1" : "0" }, admin.workspaceId);
  let message = want ? "تأیید داخلی روشن شد؛ پنل تأیید در صفحه‌ی پیش‌نویس‌ها دیده می‌شود." : "تأیید داخلی خاموش شد.";
  if (!want && before) {
    const n = await clearDraftApprovals(admin.workspaceId);
    if (n > 0) message += ` ${n.toLocaleString("fa-IR")} درخواست تأییدِ باز پاک شد تا پیش‌نویس‌ها بدون مانع منتشر شوند.`;
  }
  await logAudit({ workspaceId: admin.workspaceId, action: "settings.saved", userId: admin.id, detail: `approvals_enabled=${want ? "1" : "0"}` });
  revalidatePath("/admin/settings");
  revalidatePath("/admin");
  return { enabled: want, message };
}
