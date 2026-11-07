import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { workspaceOfContract } from "@/modules/tenancy/service";
import { getRequestInfo } from "@/lib/request";

export const ACTION_LABELS: Record<string, string> = {
  "contract.issued": "صدور قرارداد",
  "contract.viewed": "مشاهده قرارداد",
  "contract.signed": "امضای قرارداد",
  "contract.completed": "تکمیل قرارداد",
  "contract.rejected": "رد قرارداد",
  "contract.deleted": "حذف قرارداد",
  "otp.sent": "ارسال کد تایید",
  "otp.failed": "کد تایید نادرست",
  "otp.verified": "تایید کد پیامکی",
  "auth.login": "ورود به سیستم",
  "auth.failed": "ورود ناموفق",
  "template.saved": "ذخیره قالب",
  "template.deleted": "حذف قالب",
  "settings.saved": "ذخیره تنظیمات",
  "settings.ai_saved": "تنظیم هوش مصنوعی",
  "ticket.created": "ثبت تیکت پشتیبانی",
  "ticket.replied": "پاسخ به تیکت",
  "order.created": "ثبت سفارش",
  "access.denied": "دسترسی غیرمجاز",
  "contract.draft_saved": "ذخیره پیش‌نویس",
  "contract.published": "انتشار نسخه نهایی",
  "contract.cancelled": "لغو قرارداد",
  "contract.expired": "انقضای قرارداد",
  "contract.reminder": "ارسال یادآوری",
  "link.created": "ساخت لینک کوتاه",
  "link.opened": "بازشدن لینک کوتاه",
  "link.failed": "رمز لینک نادرست",
  "link.disabled": "غیرفعال‌سازی لینک",
  "webhook.saved": "ذخیره وب‌هوک",
  "webhook.deleted": "حذف وب‌هوک",
  "branding.saved": "ذخیره برندینگ",
  "apikey.created": "ساخت کلید API",
  "apikey.revoked": "ابطال کلید API",
  "api.contract_issued": "صدور از طریق API",
  "cron.run": "اجرای زمان‌بندی",
  "member.invited": "دعوت عضو تیم",
  "member.joined": "پیوستن عضو تیم",
  "member.role_changed": "تغییر نقش عضو",
  "member.removed": "حذف عضو",
  "client.added": "افزودن مشتری",
  "workspace.created": "ساخت فضای کاری",
  "ai.generated": "تولید متن با هوش مصنوعی",
  "demo.seeded": "ساخت داده‌های نمونه",
  "demo.cleared": "پاک‌سازی داده‌های نمونه",
  "license.activated": "فعال‌سازی لایسنس",
  "license.removed": "حذف لایسنس",
  "update.installed": "نصب به‌روزرسانی",
  "release.published": "انتشار نسخه‌ی جدید",
  "update.rolled_back": "بازگردانی نسخه‌ی قبل",
  "contract.bulk": "عملیات گروهی",
  "auth.registered": "ثبت‌نام",
  "report.exported": "خروجی گزارش",
  "auth.password_reset": "بازیابی رمز عبور",
  "account.profile_updated": "ویرایش مشخصات حساب",
  "account.password_changed": "تغییر رمز عبور",
  "auth.2fa_enabled": "فعال‌سازی ورود دومرحله‌ای",
  "auth.2fa_disabled": "غیرفعال‌سازی ورود دومرحله‌ای",
  "auth.2fa_failed": "کد ورود دومرحله‌ای نادرست",
  "auth.2fa_recovery_used": "ورود با کد بازیابی",
  "auth.2fa_recovery_regenerated": "ساخت دوباره‌ی کدهای بازیابی",
  "contract.duplicated": "کپی قرارداد (صدور مجدد)",
  "billing.checkout": "شروع پرداخت اشتراک",
  "billing.paid": "پرداخت موفق اشتراک",
  "risk.analyzed": "تحلیل ریسک قرارداد",
  "contract.verified": "استعلام اصالت سند",
  "auth.email_verified": "تأیید ایمیل",
  "auth.email_verify_failed": "کد تأیید ایمیل نادرست",
  "signlink.opened": "بازشدن لینک امضای امن",
  "signlink.resent": "ارسال مجدد لینک امضا",
  "document.generated": "ساخت PDF روی سرور",
  "document.downloaded": "دانلود PDF",
  "document.failed": "خطا در ساخت PDF",
  "document.tampered": "هشدار: مغایرت هش فایل PDF",
  "fields.filled": "پر کردن فیلدهای قرارداد",
  "amendment.created": "صدور الحاقیه",
  "amendment.accepted": "تأیید الحاقیه",
  "amendment.rejected": "رد الحاقیه",
  "amendment.completed": "اجرایی شدن الحاقیه",
  "amendment.cancelled": "لغو الحاقیه",
  "attachment.uploaded": "پیوست فایل",
  "attachment.downloaded": "دانلود پیوست",
  "attachment.deleted": "حذف پیوست",
  "attachment.tampered": "هشدار: مغایرت هش پیوست",
  "renewal.scheduled": "زمان‌بندی تمدید",
  "renewal.due": "یادآوری نزدیک شدن پایان مدت",
  "renewal.ended": "پایان مدت قرارداد",
  "renewal.created": "تمدید قرارداد (پیش‌نویس جدید)",
  "account.exported": "خروجی داده‌های شخصی",
  "billing.failover": "گذر خودکار به درگاه جایگزین",
  "wallet.topup": "شارژ کیف پول",
  "wallet.topup_started": "شروع شارژ کیف پول",
  "wallet.pack_purchased": "خرید بسته‌ی اعتباری",
  "referral.signup": "ثبت‌نام با کد دعوت",
  "referral.rewarded": "پرداخت پاداش دعوت",
  "referral.invited": "ارسال دعوت‌نامه",
  "kyc.submitted": "ارسال مدارک احراز هویت",
  "kyc.approved": "تایید احراز هویت",
  "kyc.rejected": "رد احراز هویت",
  "kyc.doc_viewed": "مشاهده‌ی مدرک هویتی",
  "kyc.doc_corrupt": "هشدار: مدرک هویتی ناسالم",
  "account.deleted": "حذف حساب کاربری",
  "account.session_revoked": "بستن نشست/دستگاه",
  "revision.restored": "بازگردانی نسخه‌ی متن",
  "comment.added": "پیام در گفتگوی قرارداد",
  "comment.change_requested": "درخواست اصلاح متن",
  "comment.resolved": "بستن موضوع مذاکره",
  "comment.reopened": "بازکردن مجدد موضوع مذاکره",
  "approval.requested": "درخواست تأیید داخلی",
  "approval.approved": "تأیید داخلی",
  "approval.changes_requested": "درخواست اصلاح توسط تأییدکننده",
  "approval.reset": "بازنشانی تأییدها (تغییر متن)",
  "approval.removed": "حذف تأییدکننده",
  "contract.archived": "انتقال به بایگانی",
  "contract.unarchived": "خروج از بایگانی",
  "contract.meta_updated": "ویرایش برچسب و ارزش قرارداد",
  "clause.saved": "ذخیره‌ی بند آماده",
  "clause.deleted": "حذف بند آماده",
  "health.deep_test": "تست عمیق سلامت سیستم",
  "health.test_email": "ایمیل آزمایشی از داشبورد سلامت",
  "health.test_sms": "پیامک آزمایشی از داشبورد سلامت",
  "health.export": "خروجی گزارش سلامت سیستم",
};

export async function logAudit(entry: {
  action: string;
  contractId?: number | null;
  /** اگر داده نشود از روی قرارداد استخراج می‌شود */
  workspaceId?: number | null;
  userId?: number | null;
  detail?: string;
  /** برای رویدادهای سیستمی خارج از چرخه‌ی درخواست (مثل Cron) */
  actor?: string;
}) {
  let ip = entry.actor ?? "unknown";
  let userAgent = entry.actor ?? "unknown";
  try {
    if (entry.actor) throw new Error("system");
    const info = await getRequestInfo();
    ip = info.ip;
    userAgent = info.userAgent;
  } catch {
    /* خارج از چرخه‌ی درخواست */
  }
  const workspaceId = entry.workspaceId ?? (await workspaceOfContract(entry.contractId));
  await db.insert(auditLogs).values({
    workspaceId,
    action: entry.action,
    contractId: entry.contractId ?? null,
    // DB-01: «۰» در کدهای قدیمی یعنی «بدون کاربر» (مثلاً لغو از API)؛ با Foreign Key باید NULL ذخیره شود
    userId: entry.userId || null,
    detail: entry.detail ?? "",
    ip,
    userAgent,
  });
}

export async function getContractAudit(contractId: number) {
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      detail: auditLogs.detail,
      ip: auditLogs.ip,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt,
      userName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(eq(auditLogs.contractId, contractId))
    .orderBy(desc(auditLogs.createdAt));
}

export async function getRecentAudit(workspaceId: number, limit = 200) {
  return db
    .select({
      id: auditLogs.id,
      contractId: auditLogs.contractId,
      action: auditLogs.action,
      detail: auditLogs.detail,
      ip: auditLogs.ip,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt,
      userName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(eq(auditLogs.workspaceId, workspaceId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}
