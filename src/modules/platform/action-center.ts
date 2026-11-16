/**
 * «مرکز اقدام» مدیر کل: هر چیزی که منتظر تصمیم یا رفع‌مشکل است در یک فهرست مرتب‌شده (خالص؛ قابل‌آزمون).
 * پیش‌تر مدیر باید ۸ صفحه‌ی مختلف را یکی‌یکی می‌گشت تا بفهمد کدام کار معطل مانده؛ نشان‌های منو هم فقط ۳ مورد را پوشش می‌دادند
 * و مشکلاتی مثل «بک‌آپ ناموفق» یا «هیچ درگاه پرداخت فعالی نیست» هیچ‌جا هشدار نمی‌دادند.
 */
export type ActionSeverity = "critical" | "warn" | "info";
export type ActionItem = { id: string; severity: ActionSeverity; title: string; detail: string; href: string; cta: string; count?: number };

export type ActionCenterInput = {
  ticketsWaiting: number;
  kycPending: number;
  openIncidents: number;
  backup: { enabled: boolean; hasAny: boolean; lastOk: boolean | null; lastError?: string | null; recoveryConfigured: boolean; insideDataVolume: boolean };
  gateways: { enabled: number; configured: number; total: number };
  platformSmtp: boolean;
};

const ORDER: Record<ActionSeverity, number> = { critical: 0, warn: 1, info: 2 };

export function buildActionItems(i: ActionCenterInput): ActionItem[] {
  const out: ActionItem[] = [];
  const b = i.backup;

  if (b.lastOk === false) out.push({ id: "backup-failed", severity: "critical", title: "آخرین بک‌آپ ناموفق بود", detail: b.lastError ? `علت: ${String(b.lastError).slice(0, 140)}` : "بدون بک‌آپ سالم، خرابی دیسک یعنی از دست رفتن اسناد امضاشده.", href: "/platform#backup", cta: "بک‌آپ دوباره" });
  else if (b.enabled && !b.hasAny) out.push({ id: "backup-none", severity: "critical", title: "هنوز هیچ بک‌آپی ساخته نشده", detail: "یک بک‌آپ فوری بگیرید تا دیتابیس و اسناد امضاشده بیمه شوند.", href: "/platform#backup", cta: "بک‌آپ فوری" });
  if (!b.enabled) out.push({ id: "backup-off", severity: "warn", title: "بک‌آپ خودکار خاموش است", detail: "با BACKUP_ENABLED=1 روشنش کنید؛ در غیر این صورت فقط بک‌آپ دستی دارید.", href: "/platform#backup", cta: "مشاهده" });
  if (b.hasAny && !b.recoveryConfigured) out.push({ id: "recovery-key", severity: "warn", title: "کلید بازیابی بک‌آپ ساخته نشده", detail: "بدون آن، رازِ امنیتی در بک‌آپ‌ها ذخیره نمی‌شود و بازیابی روی سرور جدید ممکن نیست.", href: "/platform#backup", cta: "ساخت کلید" });
  else if (b.hasAny && b.insideDataVolume) out.push({ id: "backup-inside", severity: "warn", title: "بک‌آپ‌ها روی همان دیسک داده‌ی اصلی‌اند", detail: "یک مسیر بیرونی در BACKUP_MIRROR_DIRS تنظیم کنید تا با خرابی دیسک همه‌چیز با هم از بین نرود.", href: "/platform#backup", cta: "مشاهده" });

  if (i.gateways.enabled === 0 || i.gateways.configured === 0)
    out.push({ id: "gateways", severity: "critical", title: i.gateways.total && i.gateways.enabled === 0 ? "همه‌ی درگاه‌های پرداخت غیرفعال است" : "هیچ درگاه پرداخت واقعی تنظیم نشده", detail: "کاربران نمی‌توانند اشتراک بخرند یا کیف پول شارژ کنند؛ درآمد صفر می‌ماند.", href: "/platform/commerce", cta: "تنظیم درگاه" });

  if (i.openIncidents > 0) out.push({ id: "health", severity: "critical", title: "سرویس‌های دارای مشکل", detail: "یک یا چند بررسی سلامت (دیتابیس، ایمیل، پیامک، درگاه، AI، …) خطا می‌دهد.", href: "/platform/health", cta: "عیب‌یابی", count: i.openIncidents });
  if (i.ticketsWaiting > 0) out.push({ id: "tickets", severity: "warn", title: "تیکت منتظر پاسخ", detail: "کاربران منتظر پاسخ شما هستند.", href: "/platform/tickets", cta: "پاسخ به تیکت‌ها", count: i.ticketsWaiting });
  if (i.kycPending > 0) out.push({ id: "kyc", severity: "warn", title: "مدرک احراز هویت در صف بررسی", detail: "تا تأیید یا رد نشود، آن فضای کاری نمی‌تواند قرارداد با ارزش بالا بفرستد.", href: "/platform/kyc", cta: "بررسی مدارک", count: i.kycPending });
  if (!i.platformSmtp) out.push({ id: "smtp", severity: "info", title: "ایمیل سطح پلتفرم تنظیم نشده", detail: "پاسخ تیکت‌ها و هشدارهای سلامت به ایمیل کاربران/مدیران نمی‌رسد (فقط در صندوق ارتباطات ثبت می‌شود).", href: "/platform/health", cta: "بررسی" });

  return out.sort((a, c) => ORDER[a.severity] - ORDER[c.severity]);
}
