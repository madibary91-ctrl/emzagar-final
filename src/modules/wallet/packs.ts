/**
 * بسته‌های اعتبار قرارداد و محدوده‌ی شارژ کیف پول (بدون وابستگی به سرور؛ در کلاینت هم قابل استفاده).
 * قیمت‌ها به تومان‌اند. اعتبار قرارداد منقضی نمی‌شود و فقط وقتی مصرف می‌شود که سقف ماهانه‌ی طرح پر شده باشد.
 */
export interface CreditPack {
  id: string;
  name: string;
  credits: number;
  priceToman: number;
  popular?: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "c10", name: "بسته‌ی ۱۰ قراردادی", credits: 10, priceToman: 120_000 },
  { id: "c50", name: "بسته‌ی ۵۰ قراردادی", credits: 50, priceToman: 450_000, popular: true },
  { id: "c200", name: "بسته‌ی ۲۰۰ قراردادی", credits: 200, priceToman: 1_400_000 },
];

export const TOPUP_MIN = 10_000;
export const TOPUP_MAX = 50_000_000;
export const TOPUP_PRESETS = [100_000, 250_000, 500_000, 1_000_000];

export const packById = (id: string): CreditPack | undefined => CREDIT_PACKS.find((p) => p.id === id);

/** هزینه‌ی هر قرارداد در بسته (تومان) */
export const perContract = (p: CreditPack) => Math.round(p.priceToman / p.credits);

export const TX_KIND_LABELS: Record<string, string> = {
  topup: "شارژ کیف پول",
  pack_purchase: "خرید بسته‌ی اعتباری",
  plan_purchase: "خرید اشتراک با کیف پول",
  credit_use: "مصرف اعتبار قرارداد",
  credit_refund: "بازگشت اعتبار قرارداد",
  referral_reward: "پاداش دعوت از دوستان",
  admin_adjust: "تنظیم توسط مدیر",
  refund: "بازگشت وجه",
};
