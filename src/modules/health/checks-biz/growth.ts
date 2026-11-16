import { type CheckDef, type Metric, type Step } from "../types";
import { ageText, effectiveSmtp, fa, isProd } from "../checks-core";
import { db } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getKycThreshold, kycCounts } from "@/modules/kyc/service";
import { getReferralConfig } from "@/modules/referral/service";
import { sql } from "drizzle-orm";
import { trustedAppOrigin } from "@/lib/config";

/* ───────────────────────── احراز هویت، دعوت و همگام‌سازی ───────────────────────── */

export const kyc: CheckDef = {
  id: "kyc",
  group: "business",
  label: "احراز هویت (KYC)",
  weight: 1,
  fixHref: "/platform/kyc",
  fixLabel: "صف احراز هویت",
  async run() {
    const [threshold, counts] = await Promise.all([getKycThreshold(), kycCounts()]);
    const oldest = ((await db.execute(sql`select min(created_at) as t from kyc_submissions where status = 'pending'`)).rows[0] as { t: Date | null }).t;
    const steps: Step[] = [];
    // آزمون رمزنگاری واقعی: همان مسیری که کد ملی و فایل‌ها با آن ذخیره می‌شوند
    let cryptoOk = false;
    try {
      const probe = `kyc-health-${Date.now()}`;
      cryptoOk = decryptSecret(encryptSecret(probe)) === probe;
    } catch {
      cryptoOk = false;
    }
    steps.push({ name: "رمزنگاری AES-256-GCM", ok: cryptoOk, detail: cryptoOk ? "رفت‌وبرگشت موفق" : "کلید امنیتی در دسترس نیست" });
    const age = oldest ? Date.now() - new Date(oldest).getTime() : 0;
    const metrics: Metric[] = [
      { label: "آستانه‌ی الزام KYC", value: threshold > 0 ? `${fa(threshold)} تومان` : "غیرفعال", tone: threshold > 0 ? "ok" : "warn" },
      { label: "در انتظار / تأییدشده / ردشده", value: `${fa(counts.pending)} / ${fa(counts.approved)} / ${fa(counts.rejected)}` },
    ];
    if (oldest) metrics.push({ label: "قدیمی‌ترین درخواست در صف", value: ageText(age), tone: age > 7 * 86400_000 ? "fail" : age > 48 * 3600_000 ? "warn" : "ok" });
    if (!cryptoOk) return { status: "fail", summary: "رمزنگاری مدارک هویتی کار نمی‌کند", steps, metrics, hints: ["SESSION_SECRET را بررسی کنید."] };
    if (age > 7 * 86400_000) return { status: "fail", summary: `درخواست KYC بیش از ${ageText(age)} در صف مانده`, steps, metrics };
    if (age > 48 * 3600_000) return { status: "warn", summary: `${fa(counts.pending)} درخواست در صف؛ قدیمی‌ترین ${ageText(age)}`, steps, metrics };
    return { status: "ok", summary: counts.pending ? `${fa(counts.pending)} درخواست در صف بررسی` : "صف بررسی خالی است · رمزنگاری سالم", steps, metrics };
  },
};
export const referral: CheckDef = {
  id: "referral",
  group: "business",
  label: "سیستم دعوت دوستان",
  weight: 1,
  fixHref: "/platform/commerce",
  fixLabel: "تنظیمات دعوت",
  async run(ctx) {
    const cfg = await getReferralConfig();
    const stats = ((await db.execute(sql`select count(*)::int as total, count(*) filter (where status = 'qualified')::int as qualified, count(*) filter (where created_at > now() - interval '24 hours')::int as recent from referrals`)).rows[0]) as { total: number; qualified: number; recent: number };
    const ips = (await db.execute(sql`select signup_ip, count(*)::int as n from referrals where signup_ip <> '' and created_at > now() - interval '7 days' group by signup_ip having count(*) >= 5 order by n desc limit 3`)).rows as { signup_ip: string; n: number }[];
    const smtp = await effectiveSmtp(ctx.workspaceId);
    const app = trustedAppOrigin();
    const metrics: Metric[] = [
      { label: "وضعیت سیستم دعوت", value: cfg.enabled ? "فعال" : "خاموش" },
      { label: "دعوت‌ها: کل / موفق / ۲۴ ساعت", value: `${fa(stats.total)} / ${fa(stats.qualified)} / ${fa(stats.recent)}` },
      { label: "پاداش هر دعوت موفق", value: `${fa(cfg.referrerWallet)} تومان + ${fa(cfg.referrerCredits)} اعتبار`, tone: "ok" },
      { label: "آدرس لینک‌های دعوت (APP_URL)", value: app || "از هدر Host ساخته می‌شود", tone: app ? "ok" : "warn" },
      { label: "ایمیل دعوت‌نامه", value: smtp ? "SMTP آماده" : "SMTP تنظیم نیست (ایمیل ارسال نمی‌شود)", tone: smtp ? "ok" : "warn" },
    ];
    if (ips.length) metrics.push({ label: "IP مشکوک (≥۵ ثبت‌نام در ۷ روز)", value: ips.map((i) => `${i.signup_ip} (${fa(i.n)})`).join("، "), tone: "warn" });
    if (!cfg.enabled) return { status: "unconfigured", summary: "سیستم دعوت خاموش است", metrics };
    if (ips.length) return { status: "warn", summary: `${fa(ips.length)} IP با ثبت‌نام‌های پیاپی (احتمال سوءاستفاده از پاداش)`, metrics, hints: ["مکانیزم ضد‌تقلب پاداش را محدود می‌کند؛ ثبت‌نام‌های این IPها را بررسی کنید."] };
    if (!smtp || (!app && isProd())) return { status: "warn", summary: !smtp ? "دعوت‌نامه‌های ایمیلی بدون SMTP ارسال نمی‌شوند" : "APP_URL تنظیم نیست؛ لینک دعوت ممکن است نادرست ساخته شود", metrics };
    return { status: "ok", summary: `فعال · ${fa(stats.qualified)} دعوت موفق از ${fa(stats.total)}`, metrics };
  },
};
export const outbox: CheckDef = {
  id: "sync-outbox",
  group: "business",
  label: "صف همگام‌سازی ووکامرس/وردپرس",
  weight: 1,
  fixHref: "/admin/woocommerce",
  fixLabel: "همگام‌سازی ووکامرس",
  async run() {
    const conns = ((await db.execute(sql`select count(*)::int as n from wp_connections`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0] as { n: number }).n;
    const rows = (await db.execute(sql`select status, count(*)::int as n, min(created_at) as oldest from wp_outbox where created_at > now() - interval '7 days' group by status`)).rows as { status: string; n: number; oldest: Date }[];
    const get = (s: string) => rows.find((r) => r.status === s);
    const pending = get("pending")?.n ?? 0, dead = get("dead")?.n ?? 0, delivered = get("delivered")?.n ?? 0;
    const age = get("pending")?.oldest ? Date.now() - new Date(get("pending")!.oldest).getTime() : 0;
    const metrics: Metric[] = [
      { label: "اتصال‌های وردپرس", value: fa(conns) },
      { label: "۷ روز: تحویل‌شده / منتظر / ناموفق نهایی", value: `${fa(delivered)} / ${fa(pending)} / ${fa(dead)}`, tone: dead ? "warn" : "ok" },
    ];
    if (pending) metrics.push({ label: "قدیمی‌ترین رویداد منتظر", value: ageText(age), tone: age > 3600_000 ? "warn" : "ok" });
    if (conns === 0 && rows.length === 0) return { status: "unconfigured", summary: "سایت وردپرسی متصل نیست", metrics };
    if (dead > 0) return { status: "warn", summary: `${fa(dead)} رویداد پس از تلاش‌های مکرر ناموفق ماند`, metrics, hints: ["صفحه‌ی همگام‌سازی ووکامرس امکان «تلاش مجدد» دارد؛ اتصال سایت وردپرس را هم بررسی کنید."] };
    if (pending > 0 && age > 3600_000) return { status: "warn", summary: `${fa(pending)} رویداد بیش از ${ageText(age)} منتظر ارسال است`, metrics };
    return { status: "ok", summary: `${fa(conns)} اتصال · صف سالم`, metrics };
  },
};
