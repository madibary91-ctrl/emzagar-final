import { sql } from "drizzle-orm";

/**
 * وضعیت‌های ردیف `ai_generations` که در سهمیه‌ی روزانه شمرده می‌شوند.
 *  - ok       : تولید موفق
 *  - reserved : رزرو «در جریان» (پیش از تماس با سرویس بیرونی ثبت می‌شود؛ بدون آن درخواست‌های هم‌زمان همگی از سقف می‌گذشتند)
 * `failed` شمرده نمی‌شود (خطای سرویس سهمیه‌ی کاربر را نمی‌خورد).
 * فایل جدا و بدون وابستگی است تا billing و ai به‌صورت دایره‌ای به هم import نشوند.
 */
export const AI_STATUS_RESERVED = "reserved";
export const AI_COUNTED_STATUSES = ["ok", AI_STATUS_RESERVED] as const;

/**
 * R-02: عمر مجاز یک رزرو «در جریان». طولانی‌ترین تماس AI مجاز ۱۱۰ ثانیه است؛ ردیف reserved قدیمی‌تر از این مدت
 * متعلق به پروسه‌ای است که وسط تماس مُرده (دیپلوی/SIGKILL/OOM) و پاسخی هرگز به کاربر نرسیده است ⇒ سهمیه نمی‌خورد.
 * (قبلاً تا ۲۴ ساعت شمرده می‌شد و هر دیپلوی در ساعت شلوغ چند سهمیه‌ی مشتری را می‌سوزاند.)
 */
export const AI_RESERVATION_TTL_MS = 10 * 60_000;

/**
 * شرط SQL یکتا برای «ردیف‌هایی که در سهمیه شمرده می‌شوند»؛ هر سه محل شمارش (رزرو، نمایش، مصرف طرح) از همین استفاده می‌کنند
 * تا هیچ‌وقت ناهماهنگ نشوند. فقط در پرس‌وجوهایی به‌کار می‌رود که از جدول `ai_generations` می‌خوانند.
 */
export const aiCountedCondition = (now = Date.now()) =>
  sql`(ai_generations.status = 'ok' or (ai_generations.status = ${AI_STATUS_RESERVED} and ai_generations.created_at > ${new Date(now - AI_RESERVATION_TTL_MS)}))`;

/**
 * پیام «سهمیه تمام شد» با زمان آزادشدن اولین سهمیه (پنجره‌ی لغزان ۲۴ ساعته) و راه‌حل.
 * پیش‌تر کاربر فقط «تمام شده» می‌دید و نمی‌دانست کِی دوباره می‌تواند یا چه کند (بن‌بست).
 */
export function quotaExhaustedMessage(limit: number, resetAt?: Date | null, now = Date.now()): string {
  const base = `سهمیه‌ی ${limit.toLocaleString("fa-IR")} تولید در ۲۴ ساعت برای این فضای کاری تمام شده است.`;
  const upgrade = " برای سقف بیشتر، طرح اشتراک را ارتقا دهید.";
  if (!resetAt) return base + upgrade;
  const mins = Math.max(1, Math.ceil((resetAt.getTime() - now) / 60_000));
  const when = mins >= 120 ? `حدود ${Math.ceil(mins / 60).toLocaleString("fa-IR")} ساعت دیگر` : mins >= 60 ? "حدود ۱ ساعت دیگر" : `حدود ${mins.toLocaleString("fa-IR")} دقیقه‌ی دیگر`;
  return `${base} ${when} اولین سهمیه آزاد می‌شود؛ یا طرح اشتراک را ارتقا دهید.`;
}
