/**
 * مدل و ابزارهای «خالص» طرح‌های اشتراک (بدون وابستگی به سرور/دیتابیس؛ در کلاینت هم قابل استفاده).
 *
 * منبع حقیقت طرح‌ها اکنون جدول `subscription_plans` است و مدیر کل پلتفرم آن را از «مدیریت پلتفرم ← طرح‌های اشتراک»
 * می‌سازد، ویرایش یا حذف می‌کند (خواندن/نوشتن در `catalog.ts`).
 * این فایل فقط شامل موارد زیر است:
 *   - نوع `Plan` و توابع محاسبه (قیمت، مدت، ویژگی‌ها، اعتبارسنجی ورودی مدیر)؛
 *   - `DEFAULT_PLANS`: داده‌ی اولیه‌ای که فقط یک‌بار و فقط وقتی جدول خالی است در دیتابیس کاشته می‌شود؛
 *   - یک «رجیستری» درون‌حافظه‌ای که هر بار کاتالوگ از دیتابیس خوانده می‌شود به‌روز می‌شود تا `priceFor` هم‌زمان (sync)
 *     همیشه با آخرین قیمت‌های دیتابیس هم‌خوان بماند (سازگاری رو به عقب با کدهایی که قیمت را همزمان می‌خواهند).
 *
 * مقدار -1 برای سقف قرارداد/عضو یعنی نامحدود. قیمت‌ها به تومان و ماهانه‌اند.
 */
export type PlanId = string;

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** قیمت یک ماه (تومان) */
  priceToman: number;
  /** سقف قرارداد در ماه؛ -1 = نامحدود */
  contractsPerMonth: number;
  /** سقف اعضای تیم؛ -1 = نامحدود */
  members: number;
  /** سقف درخواست هوش مصنوعی در ۲۴ ساعت */
  aiPerDay: number;
  /** ویژگی‌های نمایشی؛ اگر خالی باشد از روی سقف‌ها خودکار ساخته می‌شود */
  features: string[];
  highlight?: boolean;
  /** مدت‌های قابل خرید: «ماه ← درصد تخفیف» */
  durations: Record<number, number>;
  /** نمایش عمومی و خرید خودخدمت */
  isPublic: boolean;
  /** طرح پایه‌ی فضاهای بدون اشتراک فعال */
  isDefault: boolean;
  /** false = بایگانی‌شده (غیرقابل خرید؛ مشترکان فعلی تا پایان دوره حفظ می‌شوند) */
  isActive: boolean;
  /** طرحی که پاداش دعوت دوستان (روزهای هدیه) روی آن فعال می‌شود */
  isRewardPlan: boolean;
  sortOrder: number;
}

/** مدت‌ها و تخفیف‌های پیش‌فرض (ماه ← درصد) */
export const DEFAULT_DURATIONS: Record<number, number> = { 1: 0, 3: 10, 6: 17, 12: 25 };
/** سازگاری رو به عقب */
export const MONTH_DISCOUNT = DEFAULT_DURATIONS;
export const MONTH_OPTIONS = [1, 3, 6, 12] as const;

/** سقف‌های اعتبارسنجی (جلوگیری از مقدار پوچ یا سرریز) */
export const PLAN_LIMITS = { price: 1_000_000_000, count: 10_000_000, ai: 1_000_000, maxMonths: 60, maxDiscount: 90, maxDurations: 12, maxFeatures: 20 } as const;

/** داده‌ی اولیه‌ی کاتالوگ (فقط برای کاشت یک‌باره‌ی دیتابیس خالی و به‌عنوان پشتیبان رجیستری) */
export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "رایگان",
    tagline: "برای شروع و آزمایش",
    priceToman: 0,
    contractsPerMonth: 10,
    members: 2,
    aiPerDay: 8,
    features: ["۱۰ قرارداد در ماه", "۲ عضو تیم", "۸ درخواست هوش مصنوعی در روز", "تحلیل ریسک با موتور قواعد", "امضای پیامکی و شناسنامه دیجیتال"],
    durations: { ...DEFAULT_DURATIONS },
    isPublic: true,
    isDefault: true,
    isActive: true,
    isRewardPlan: false,
    sortOrder: 10,
  },
  {
    id: "pro",
    name: "حرفه‌ای",
    tagline: "برای کسب‌وکارهای در حال رشد",
    priceToman: 490_000,
    contractsPerMonth: 300,
    members: 10,
    aiPerDay: 80,
    highlight: true,
    features: ["۳۰۰ قرارداد در ماه", "۱۰ عضو تیم", "۸۰ درخواست هوش مصنوعی در روز", "تحلیل ریسک هوشمند (AI)", "افزونه‌ی وردپرس و ووکامرس", "وب‌هوک و API"],
    durations: { ...DEFAULT_DURATIONS },
    isPublic: true,
    isDefault: false,
    isActive: true,
    isRewardPlan: true,
    sortOrder: 20,
  },
  {
    id: "business",
    name: "سازمانی",
    tagline: "برای تیم‌های بزرگ و حجم بالا",
    priceToman: 1_490_000,
    contractsPerMonth: -1,
    members: 50,
    aiPerDay: 400,
    features: ["قرارداد نامحدود", "۵۰ عضو تیم", "۴۰۰ درخواست هوش مصنوعی در روز", "تحلیل ریسک هوشمند (AI)", "پشتیبانی اولویت‌دار", "همه‌ی امکانات طرح حرفه‌ای"],
    durations: { ...DEFAULT_DURATIONS },
    isPublic: true,
    isDefault: false,
    isActive: true,
    isRewardPlan: false,
    sortOrder: 30,
  },
];

/* ═════════ رجیستری درون‌حافظه‌ای (فقط برای priceFor/isPlanId همزمان) ═════════ */

/** @deprecated فقط داده‌ی اولیه است؛ برای خواندن طرح‌ها از `@/modules/billing/catalog` (دیتابیس) استفاده کنید */
export const PLANS: Record<PlanId, Plan> = Object.fromEntries(DEFAULT_PLANS.map((p) => [p.id, p]));
/** @deprecated ترتیب را از catalog.listPlans بگیرید */
export const PLAN_ORDER: PlanId[] = DEFAULT_PLANS.map((p) => p.id);

let registry: Record<PlanId, Plan> = PLANS;

/** کاتالوگ آخرین خوانده‌شده از دیتابیس را در رجیستری می‌نشاند (توسط catalog.ts صدا زده می‌شود) */
export function setPlanRegistry(plans: Plan[]): void {
  if (plans.length > 0) registry = Object.fromEntries(plans.map((p) => [p.id, p]));
}

/** آیا شناسه به طرحی در کاتالوگ اشاره می‌کند؟ (همزمان؛ مرجع قطعی همیشه دیتابیس است) */
export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(registry, v);
}

/* ═════════ محاسبه ═════════ */

/** مدت‌های مجاز طرح به‌صورت آرایه‌ی مرتب‌شده‌ی [ماه، تخفیف] */
export function planDurations(plan: Pick<Plan, "durations">): [number, number][] {
  return Object.entries(plan.durations)
    .map(([m, d]) => [Number(m), Number(d)] as [number, number])
    .filter(([m]) => Number.isInteger(m) && m >= 1)
    .sort((a, b) => a[0] - b[0]);
}

export const planOffersMonths = (plan: Pick<Plan, "durations">, months: number): boolean => Object.prototype.hasOwnProperty.call(plan.durations, months);

/** بیشترین تخفیف طرح‌ها (برای متن تبلیغاتی)؛ ۰ یعنی تخفیفی نیست */
export function maxDiscount(plans: Pick<Plan, "durations" | "priceToman">[]): number {
  let best = 0;
  for (const p of plans) if (p.priceToman > 0) for (const [, d] of planDurations(p)) best = Math.max(best, d);
  return best;
}

/** مبلغ نهایی (تومان) یک طرح برای تعداد ماه؛ همیشه سمت سرور از روی طرح دیتابیس محاسبه می‌شود */
export function planPrice(plan: Pick<Plan, "priceToman" | "durations">, months: number): number {
  const base = plan.priceToman * months;
  const off = plan.durations[months] ?? 0;
  return Math.round((base * (100 - off)) / 100 / 1000) * 1000;
}

/**
 * سازگاری رو به عقب: قیمت با شناسه‌ی طرح (همزمان، از رجیستری که با هر خواندن دیتابیس تازه می‌شود).
 * کد جدید باید `planPrice(plan, months)` را روی طرح خوانده‌شده از دیتابیس به‌کار ببرد.
 */
export function priceFor(plan: PlanId | Pick<Plan, "priceToman" | "durations">, months: number): number {
  const p = typeof plan === "string" ? registry[plan] : plan;
  if (!p) throw new Error("طرح نامعتبر است");
  return planPrice(p, months);
}

export const limitLabel = (n: number) => (n < 0 ? "نامحدود" : new Intl.NumberFormat("fa-IR").format(n));

/** ویژگی‌های نمایشی؛ اگر مدیر چیزی ننوشته باشد از روی سقف‌های طرح ساخته می‌شود */
export function planFeatures(plan: Pick<Plan, "features" | "contractsPerMonth" | "members" | "aiPerDay">): string[] {
  const custom = plan.features.map((f) => f.trim()).filter(Boolean);
  if (custom.length) return custom;
  return [
    plan.contractsPerMonth < 0 ? "قرارداد نامحدود" : `${limitLabel(plan.contractsPerMonth)} قرارداد در ماه`,
    plan.members < 0 ? "اعضای نامحدود تیم" : `${limitLabel(plan.members)} عضو تیم`,
    `${limitLabel(plan.aiPerDay)} درخواست هوش مصنوعی در روز`,
  ];
}

/** ترتیب نمایش: sortOrder سپس قیمت */
export const comparePlans = (a: Plan, b: Plan): number => a.sortOrder - b.sortOrder || a.priceToman - b.priceToman || a.id.localeCompare(b.id);

/* ═════════ اعتبارسنجی ورودی مدیر ═════════ */

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
/** ارقام فارسی/عربی و جداکننده‌ی هزار را به عدد لاتین ساده تبدیل می‌کند */
export function normalizeNumber(v: unknown): string {
  return String(v ?? "")
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[,٬،\s]/g, "")
    .trim();
}

function toInt(v: unknown): number | null {
  const s = normalizeNumber(v);
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

export const PLAN_ID_RE = /^[a-z][a-z0-9_-]{1,29}$/;

/** تبدیل متن «۱:۰ ، ۳:۱۰ ، ۱۲:۲۵» (جداکننده: ویرگول یا خط جدید) به جدول مدت ← تخفیف */
export function parseDurations(text: string): { ok: true; value: Record<number, number> } | { ok: false; error: string } {
  const out: Record<number, number> = {};
  const parts = String(text || "")
    .split(/[\n;؛,،]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [mRaw, offRaw, ...rest] = part.split(/[:=]/);
    const months = toInt(mRaw);
    const off = offRaw === undefined || normalizeNumber(offRaw) === "" ? 0 : toInt(offRaw);
    if (rest.length || months === null || months < 1 || months > PLAN_LIMITS.maxMonths) return { ok: false, error: `مدت «${part}» نامعتبر است (۱ تا ${PLAN_LIMITS.maxMonths} ماه).` };
    if (off === null || off < 0 || off > PLAN_LIMITS.maxDiscount) return { ok: false, error: `تخفیف «${part}» نامعتبر است (۰ تا ${PLAN_LIMITS.maxDiscount} درصد).` };
    out[months] = off;
  }
  const n = Object.keys(out).length;
  if (n === 0) return { ok: false, error: "دست‌کم یک مدت اشتراک لازم است (مثال: ۱:۰ ، ۳:۱۰ ، ۱۲:۲۵)." };
  if (n > PLAN_LIMITS.maxDurations) return { ok: false, error: `حداکثر ${PLAN_LIMITS.maxDurations} مدت مجاز است.` };
  return { ok: true, value: out };
}

export const durationsToText = (d: Record<number, number>): string => planDurations({ durations: d }).map(([m, off]) => `${m}:${off}`).join(", ");

export interface PlanInput {
  id: string;
  name: string;
  tagline: string;
  priceToman: number;
  contractsPerMonth: number;
  members: number;
  aiPerDay: number;
  features: string[];
  durations: Record<number, number>;
  highlight: boolean;
  isPublic: boolean;
  isActive: boolean;
  isRewardPlan: boolean;
  sortOrder: number;
}

/**
 * ورودی خام فرم/API مدیر را اعتبارسنجی و پاک‌سازی می‌کند.
 * چک‌باکس «نامحدود» (`contractsUnlimited`, `membersUnlimited`) مقدار -1 می‌دهد.
 */
export function parsePlanInput(raw: Record<string, unknown>, opts: { requireId: boolean }): { ok: true; value: PlanInput } | { ok: false; error: string } {
  const flag = (k: string) => raw[k] === true || raw[k] === "on" || raw[k] === "true" || raw[k] === "1";
  const str = (k: string, max: number) => String(raw[k] ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

  const id = str("id", 30).toLowerCase();
  if (opts.requireId && !PLAN_ID_RE.test(id)) return { ok: false, error: "شناسه‌ی طرح باید ۲ تا ۳۰ نویسه‌ی لاتین کوچک، عدد، خط تیره یا زیرخط باشد و با حرف شروع شود (مثال: starter)." };

  const name = str("name", 40);
  if (!name) return { ok: false, error: "نام طرح الزامی است." };

  const price = toInt(raw.priceToman);
  if (price === null || price < 0 || price > PLAN_LIMITS.price) return { ok: false, error: "قیمت ماهانه باید عددی از ۰ تا یک میلیارد تومان باشد." };

  const limit = (k: string, unlimitedKey: string, label: string, min: number): number | string => {
    if (flag(unlimitedKey)) return -1;
    const n = toInt(raw[k]);
    if (n === null || n < min || n > PLAN_LIMITS.count) return `${label} باید عددی از ${min} تا ${PLAN_LIMITS.count.toLocaleString("en-US")} باشد (یا «نامحدود» را تیک بزنید).`;
    return n;
  };
  const contracts = limit("contractsPerMonth", "contractsUnlimited", "سقف قرارداد ماهانه", 0);
  if (typeof contracts === "string") return { ok: false, error: contracts };
  const members = limit("members", "membersUnlimited", "سقف اعضای تیم", 1);
  if (typeof members === "string") return { ok: false, error: members };
  const ai = toInt(raw.aiPerDay);
  if (ai === null || ai < 0 || ai > PLAN_LIMITS.ai) return { ok: false, error: `سقف هوش مصنوعی روزانه باید عددی از ۰ تا ${PLAN_LIMITS.ai.toLocaleString("en-US")} باشد.` };

  const dur = parseDurations(String(raw.durations ?? ""));
  if (!dur.ok) return dur;

  const features = String(raw.features ?? "")
    .split(/\r?\n/)
    .map((f) => f.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120))
    .filter(Boolean);
  if (features.length > PLAN_LIMITS.maxFeatures) return { ok: false, error: `حداکثر ${PLAN_LIMITS.maxFeatures} ویژگی مجاز است.` };

  const sortRaw = normalizeNumber(raw.sortOrder);
  const sortOrder = sortRaw === "" ? 100 : toInt(sortRaw);
  if (sortOrder === null || sortOrder < 0 || sortOrder > 100_000) return { ok: false, error: "ترتیب نمایش باید عددی بین ۰ تا ۱۰۰٬۰۰۰ باشد." };

  return {
    ok: true,
    value: {
      id,
      name,
      tagline: str("tagline", 120),
      priceToman: price,
      contractsPerMonth: contracts,
      members,
      aiPerDay: ai,
      features,
      durations: dur.value,
      highlight: flag("highlight"),
      isPublic: flag("isPublic"),
      isActive: flag("isActive"),
      isRewardPlan: flag("isRewardPlan"),
      sortOrder,
    },
  };
}
