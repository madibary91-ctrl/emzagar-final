/** تنظیمات و قواعد سیستم دعوت از دوستان — بدون وابستگی به سرور؛ در کلاینت هم قابل استفاده */
export interface ReferralConfig {
  enabled: boolean;
  /** پاداش دعوت‌کننده به‌ازای هر دعوت موفق */
  referrerWallet: number; // تومان
  referrerCredits: number; // اعتبار قرارداد
  /** هدیه‌ی خوشامد دعوت‌شده */
  referredWallet: number; // تومان
  referredCredits: number;
  /** هر N دعوت موفق: اشتراک رایگان */
  milestoneEvery: number;
  milestoneDays: number;
  /** سقف تعداد دعوت‌های پاداش‌دار برای هر کاربر (ضد سوءاستفاده) */
  maxRewarded: number;
}

export const DEFAULT_REFERRAL: ReferralConfig = {
  enabled: true,
  referrerWallet: 30_000,
  referrerCredits: 3,
  referredWallet: 20_000,
  referredCredits: 3,
  milestoneEvery: 3,
  milestoneDays: 30,
  maxRewarded: 50,
};

const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

export function sanitizeReferralConfig(raw: Partial<Record<keyof ReferralConfig, unknown>>): ReferralConfig {
  const d = DEFAULT_REFERRAL;
  return {
    enabled: raw.enabled === undefined ? d.enabled : raw.enabled === true || raw.enabled === "1" || raw.enabled === "on",
    referrerWallet: clampInt(raw.referrerWallet, 0, 5_000_000, d.referrerWallet),
    referrerCredits: clampInt(raw.referrerCredits, 0, 1000, d.referrerCredits),
    referredWallet: clampInt(raw.referredWallet, 0, 5_000_000, d.referredWallet),
    referredCredits: clampInt(raw.referredCredits, 0, 1000, d.referredCredits),
    milestoneEvery: clampInt(raw.milestoneEvery, 0, 100, d.milestoneEvery),
    milestoneDays: clampInt(raw.milestoneDays, 0, 365, d.milestoneDays),
    maxRewarded: clampInt(raw.maxRewarded, 1, 10_000, d.maxRewarded),
  };
}

export const REFERRAL_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** کد دعوت: «EMZ» + ۶ نویسه‌ی بدون ابهام (بدون 0/O/1/I/L) */
export const REFERRAL_CODE_RE = /^EMZ[23456789A-HJKMNP-Z]{6}$/;
export const normalizeReferralCode = (raw: unknown) => String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

export const REFERRAL_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "ثبت‌نام کرده", cls: "bg-amber-50 text-amber-800" },
  qualified: { label: "پاداش داده شد", cls: "bg-emerald-50 text-emerald-700" },
  rejected: { label: "نامعتبر", cls: "bg-red-50 text-red-700" },
};
