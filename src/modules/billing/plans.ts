/**
 * طرح‌های اشتراک (بدون وابستگی به سرور؛ در کلاینت هم قابل استفاده).
 * مقدار -1 یعنی نامحدود. قیمت‌ها به تومان و ماهانه‌اند.
 */
export type PlanId = "free" | "pro" | "business";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  priceToman: number;
  contractsPerMonth: number;
  members: number;
  aiPerDay: number;
  features: string[];
  highlight?: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "رایگان",
    tagline: "برای شروع و آزمایش",
    priceToman: 0,
    contractsPerMonth: 10,
    members: 2,
    aiPerDay: 8,
    features: ["۱۰ قرارداد در ماه", "۲ عضو تیم", "۸ درخواست هوش مصنوعی در روز", "تحلیل ریسک با موتور قواعد", "امضای پیامکی و شناسنامه دیجیتال"],
  },
  pro: {
    id: "pro",
    name: "حرفه‌ای",
    tagline: "برای کسب‌وکارهای در حال رشد",
    priceToman: 490_000,
    contractsPerMonth: 300,
    members: 10,
    aiPerDay: 80,
    highlight: true,
    features: ["۳۰۰ قرارداد در ماه", "۱۰ عضو تیم", "۸۰ درخواست هوش مصنوعی در روز", "تحلیل ریسک هوشمند (AI)", "افزونه‌ی وردپرس و ووکامرس", "وب‌هوک و API"],
  },
  business: {
    id: "business",
    name: "سازمانی",
    tagline: "برای تیم‌های بزرگ و حجم بالا",
    priceToman: 1_490_000,
    contractsPerMonth: -1,
    members: 50,
    aiPerDay: 400,
    features: ["قرارداد نامحدود", "۵۰ عضو تیم", "۴۰۰ درخواست هوش مصنوعی در روز", "تحلیل ریسک هوشمند (AI)", "پشتیبانی اولویت‌دار", "همه‌ی امکانات طرح حرفه‌ای"],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "pro", "business"];

/** تخفیف پرداخت چندماهه (درصد) */
export const MONTH_DISCOUNT: Record<number, number> = { 1: 0, 3: 10, 6: 17, 12: 25 };
export const MONTH_OPTIONS = [1, 3, 6, 12] as const;

export function isPlanId(v: unknown): v is PlanId {
  return v === "free" || v === "pro" || v === "business";
}

export function priceFor(plan: PlanId, months: number): number {
  const base = PLANS[plan].priceToman * months;
  const off = MONTH_DISCOUNT[months] ?? 0;
  return Math.round((base * (100 - off)) / 100 / 1000) * 1000;
}

export const limitLabel = (n: number) => (n < 0 ? "نامحدود" : new Intl.NumberFormat("fa-IR").format(n));
