/**
 * سیاست نگهداری «متن» ایمیل/پیامک در صندوق ارتباطات (جدول notifications) — D-04.
 *
 * ایمیل‌ها و پیامک‌های ما حاوی «رازهای کوتاه‌عمر» هستند: کد OTP امضا، لینک توکن‌دار امضا، بازیابی رمز، تأیید ایمیل، دعوت و …
 * نگه‌داشتن دائمی متن کامل آن‌ها = هر کسی که نسخه‌ی پشتیبان/دیتابیس را ببیند (یا یک SQL-injection ساده)
 * می‌تواند بی‌صدا به نام دیگران امضا کند یا حساب بگیرد. پنل «لاگ‌ها» هیچ‌وقت متن را نشان نمی‌دهد (فقط گیرنده/موضوع/وضعیت)،
 * پس متن کامل در production هیچ مصرف‌کننده‌ای ندارد.
 *
 * سیاست:
 *  - production (پیش‌فرض): متن «هرگز» ذخیره نمی‌شود؛ فقط ردیف فراداده (گیرنده، موضوع، وضعیت، خطا) برای عیب‌یابی.
 *  - توسعه/آزمون (NODE_ENV≠production): متن ذخیره می‌شود (آزمون‌ها و توسعه‌دهنده کد را از همین‌جا می‌خوانند) و پس از
 *    `OUTBOX_BODY_TTL_MINUTES` (پیش‌فرض ۶۰) خودکار پاک می‌شود.
 *  - `OUTBOX_STORE_BODY=1|0` رفتار را صریحاً تغییر می‌دهد (مثلاً دیباگ موقت در production؛ همچنان با TTL پاک می‌شود).
 *  - فراداده پس از `OUTBOX_RETENTION_DAYS` (پیش‌فرض ۱۸۰) حذف می‌شود (کمینه‌سازی داده‌ی شخصی: ایمیل/موبایل گیرنده).
 */
export const REDACTED_BODY = "[متن برای حفاظت از کدها و لینک‌های امنیتی ذخیره نمی‌شود]";

type Env = Record<string, string | undefined>;

export function storeOutboxBodies(env: Env = process.env): boolean {
  if (env.OUTBOX_STORE_BODY === "1") return true;
  if (env.OUTBOX_STORE_BODY === "0") return false;
  return env.NODE_ENV !== "production";
}

/** متنی که باید در دیتابیس نوشته شود */
export function outboxBody(raw: string, env: Env = process.env): string {
  return storeOutboxBodies(env) ? raw : REDACTED_BODY;
}

function num(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : def;
}

/** حداکثر عمر متنِ ذخیره‌شده (دقیقه). وقتی ذخیره‌ی متن خاموش است، هر متنِ باقی‌مانده (داده‌ی قدیمی) فوراً پاک می‌شود (۰). */
export function bodyTtlMinutes(env: Env = process.env): number {
  if (!storeOutboxBodies(env)) return 0;
  return num(env.OUTBOX_BODY_TTL_MINUTES, 60, 1, 10_080);
}

export function retentionDays(env: Env = process.env): number {
  return num(env.OUTBOX_RETENTION_DAYS, 180, 7, 3_650);
}
