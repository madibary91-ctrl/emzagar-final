import { runAutomation } from "./service";
import { runScheduledBackupIfDue } from "@/modules/backup/service";
import { reconcilePendingPayments } from "@/modules/billing/service";
import { refreshLicenseIfDue } from "@/modules/license/client";
import { dispatchOutbox } from "@/modules/sync/service";
import { checkUpdatesIfDue } from "@/modules/license/updater";
import { runHealthSweep } from "@/modules/health/service";
import { purgeOutbox } from "@/modules/mail/retention";
import { reapStaleAiReservations } from "@/modules/ai/quota";
import { purgeFinishedJobs } from "@/modules/jobs/queue";
import { runRetentionIfDue } from "@/modules/privacy/retention";

const g = globalThis as typeof globalThis & { __amzScheduler?: NodeJS.Timeout };

/**
 * زمان‌بند داخلی: هر چند دقیقه یک‌بار یادآوری‌ها و انقضاها را بررسی می‌کند.
 * اگر پروژه روی هاست بدون پردازه‌ی دائمی اجرا می‌شود، همین کار را مسیر /api/cron/run با کرون سیستم/هاست انجام می‌دهد.
 */
export function startScheduler() {
  if (g.__amzScheduler) return;
  const minutes = Math.max(1, Number(process.env.CRON_INTERVAL_MINUTES) || 10);
  const tick = () => {
    runAutomation("scheduler").catch(() => undefined);
    // تلاش مجدد برای رویدادهای تحویل‌نشده به سایت‌های ووکامرس
    dispatchOutbox().catch(() => undefined);
    // بک‌آپ خودکار دیتابیس و پوشه‌ی امضاها/PDFها (فقط وقتی از آخرین بک‌آپ بیش از ۲۴ ساعت گذشته)
    runScheduledBackupIfDue().catch(() => undefined);
    // تراکنش‌های پرداخت‌شده‌ای که به‌خاطر قطعی موقت درگاه تایید نشده‌اند دوباره بررسی می‌شوند
    reconcilePendingPayments().catch(() => undefined);
    // پایش سلامت سرویس‌ها: ثبت نمونه برای نمودار/درصد دسترسی و هشدار ایمیلی قطعی پایدار
    runHealthSweep().catch(() => undefined);
    // D-04: پاک‌سازی متن ایمیل/پیامک (کد OTP و لینک‌های توکن‌دار) و فراداده‌ی قدیمی صندوق ارتباطات
    purgeOutbox().catch((e) => console.error("[outbox:purge]", e instanceof Error ? e.message : e));
    // R-02: رزروهای سهمیه‌ی AI که پروسه‌ی صاحبشان وسط تماس مُرده به مشتری برمی‌گردد
    reapStaleAiReservations().catch((e) => console.error("[ai:reap]", e instanceof Error ? e.message : e));
    // R-01: کارهای done/dead قدیمی (حتی وقتی کارگر صف idle است یا تایمر آن راه نیفتاده) از جدول پاک می‌شوند
    purgeFinishedJobs().catch((e) => console.error("[jobs:purge]", e instanceof Error ? e.message : e));
    // D-01/D-02/D-03: سیاست نگهداری داده‌ی شخصی (OTP، توکن‌ها، ممیزی، وب‌هوک، پرامپت AI) و رمزنگاری رازهای قدیمی؛ مستقل از runAutomation
    runRetentionIfDue().catch((e) => console.error("[retention]", e instanceof Error ? e.message : e));
    // بررسی روزانه‌ی لایسنس و نسخه‌ی جدید (قطعی سرور فروشنده هرگز سایت را مختل نمی‌کند)
    refreshLicenseIfDue().then(() => checkUpdatesIfDue()).catch(() => undefined);
  };
  g.__amzScheduler = setInterval(tick, minutes * 60 * 1000);
  g.__amzScheduler.unref?.();
  setTimeout(tick, 45 * 1000).unref?.();
}
