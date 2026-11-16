/**
 * احراز هویت اختیاریِ امضاکننده — قواعد خالص (بدون وابستگی به سرور؛ در کلاینت هم قابل استفاده).
 *
 * فلسفه: «هر قرارداد، سطح امنیت خودش را دارد». پیش‌فرض همیشه `none` است (لینک اختصاصی + OTP پیامکی)
 * و هیچ مرحله‌ی اضافه‌ای به اسناد روزمره تحمیل نمی‌شود. صادرکننده فقط برای معاملات حساس سطح را بالا می‌برد:
 *
 *   none     عادی            لینک ۲۵۶ بیتی + OTP روی موبایل (مسیر سریع قبلی)
 *   shahkar  مالکیت شماره     + کد ملی امضاکننده ↔ مالکیت سیم‌کارت (استعلام شاهکار؛ خودکار و فوری)
 *   document مدارک هویتی      + عکس کارت ملی و سلفی با کارت، با تأیید صادرکننده (بدون هزینه، بدون سرویس بیرونی)
 *   both     حداکثر امنیت     هر دو
 */
import { isValidNationalCode, normalizeNationalCode, toLatinDigits } from "@/modules/kyc/rules";

export { isValidNationalCode, normalizeNationalCode, toLatinDigits };

export type IdentityReq = "none" | "shahkar" | "document" | "both";
export const IDENTITY_REQS: IdentityReq[] = ["none", "shahkar", "document", "both"];
export const isIdentityReq = (v: unknown): v is IdentityReq => typeof v === "string" && (IDENTITY_REQS as string[]).includes(v);
export const parseIdentityReq = (v: unknown): IdentityReq => (isIdentityReq(v) ? v : "none");

export const needsShahkar = (r: IdentityReq | string) => r === "shahkar" || r === "both";
export const needsDocs = (r: IdentityReq | string) => r === "document" || r === "both";

/** سقف تلاش برای استعلام شاهکار به‌ازای هر امضاکننده (ضد آزمون‌وخطا و هزینه) */
export const MAX_SHAHKAR_ATTEMPTS = 5;
export const IDENTITY_FILE_MAX_BYTES = 5 * 1024 * 1024;

export const IDENTITY_LEVELS: { req: IdentityReq; title: string; badge: string; blurb: string; tone: string }[] = [
  { req: "none", title: "عادی", badge: "عادی", blurb: "لینک اختصاصی + کد پیامکی. سریع‌ترین مسیر؛ مناسب اسناد روزمره.", tone: "bg-stone-100 text-ink/75" },
  { req: "shahkar", title: "تأیید مالکیت شماره", badge: "شماره = کد ملی", blurb: "کد ملی امضاکننده گرفته و با استعلام شاهکار تأیید می‌شود که این شماره واقعاً به نام خودش است. فوری و خودکار.", tone: "bg-sky-50 text-sky-800" },
  { req: "document", title: "تأیید مدارک هویتی", badge: "مدارک تأییدشده", blurb: "امضاکننده عکس کارت ملی و سلفی با کارت می‌فرستد و شما تأیید می‌کنید. رایگان و بدون سرویس بیرونی.", tone: "bg-violet-50 text-violet-800" },
  { req: "both", title: "حداکثر امنیت", badge: "هویت تضمین‌شده", blurb: "هم تطبیق شاهکار و هم مدارک هویتی؛ برای معاملات سنگین (خودرو، ملک، وام، ضمانت).", tone: "bg-emerald-50 text-emerald-800" },
];
export const IDENTITY_LABEL: Record<string, string> = Object.fromEntries(IDENTITY_LEVELS.map((l) => [l.req, l.title]));
export const identityLevel = (r: string) => IDENTITY_LEVELS.find((l) => l.req === r) ?? IDENTITY_LEVELS[0];

/** نمایش ماسک‌شده‌ی کد ملی: فقط ۳ رقم آخر */
export const maskNc = (code: string | null | undefined) => (code && code.length >= 10 ? `${"•".repeat(7)}${code.slice(-3)}` : "—");

/** متن کوتاه سطح تضمین برای شناسنامه‌ی PDF و صفحه‌ی استعلام عمومی */
export function assuranceText(a: string, opts: { sandbox?: boolean } = {}): string {
  const t = opts.sandbox ? " (حالت آزمایشی)" : "";
  if (a === "both") return `تطبیق موبایل با کد ملی (شاهکار)${t} + مدارک هویتی تأییدشده`;
  if (a === "shahkar") return `تطبیق موبایل با کد ملی (شاهکار)${t}`;
  if (a === "document") return "مدارک هویتی (کارت ملی + سلفی) تأییدشده توسط صادرکننده";
  return "";
}

/* ───────── پیشنهاد هوشمند سطح امنیت ───────── */

/** عبارت‌های معاملات حساس: جعل هویت در آن‌ها پرهزینه‌ترین است */
const SENSITIVE: { re: RegExp; why: string }[] = [
  { re: /خودرو|اتومبیل|ماشین|پلاک/, why: "خرید/فروش خودرو" },
  { re: /ملک|آپارتمان|زمین|مبایعه|قولنامه|صلح\s*نامه|سند\s*رسمی|سند\s*مالکیت/, why: "انتقال ملک" },
  { re: /اجاره|رهن|مستاجر|موجر|ودیعه/, why: "اجاره/رهن" },
  { re: /وام|قرض|تسهیلات|سفته|ضمانت|ضامن|بدهی/, why: "تعهد مالی و ضمانت" },
  { re: /وکالت|وکیل|موکل/, why: "وکالت" },
  { re: /سرمایه\s*گذاری|مشارکت|سهام|شراکت/, why: "سرمایه‌گذاری و مشارکت" },
];

/** سقف‌های ارزش (تومان) برای پیشنهاد */
export const SUGGEST_SHAHKAR_VALUE = 50_000_000;
export const SUGGEST_BOTH_VALUE = 1_000_000_000;

const norm = (s: string) => toLatinDigits(s).replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[\u200c\u200f]/g, " ");

/**
 * پیشنهاد هوشمند: از روی ارزش قرارداد و واژگان متن، سطح امنیت مناسب را پیشنهاد می‌دهد (فقط پیشنهاد؛ تصمیم با صادرکننده است).
 * خروجی null یعنی «همان مسیر سریع کافی است».
 */
export function suggestIdentity(input: { title?: string; bodyHtml?: string; value?: number | null }): { req: IdentityReq; reasons: string[] } | null {
  const text = norm(`${input.title ?? ""} ${(input.bodyHtml ?? "").replace(/<[^>]*>/g, " ")}`);
  const hits = SENSITIVE.filter((s) => s.re.test(text)).map((s) => s.why);
  const value = Number(input.value) || 0;
  const reasons: string[] = [];
  if (value >= SUGGEST_BOTH_VALUE) reasons.push(`ارزش قرارداد بسیار بالاست (${value.toLocaleString("fa-IR")} تومان)`);
  else if (value >= SUGGEST_SHAHKAR_VALUE) reasons.push(`ارزش قرارداد قابل‌توجه است (${value.toLocaleString("fa-IR")} تومان)`);
  if (hits.length) reasons.push(`موضوع حساس: ${hits.slice(0, 2).join("، ")}`);
  if (reasons.length === 0) return null;
  if (value >= SUGGEST_BOTH_VALUE || (hits.length > 0 && value >= SUGGEST_SHAHKAR_VALUE * 4)) return { req: "both", reasons };
  return { req: "shahkar", reasons };
}

export const SHAHKAR_MISMATCH_TEXT = "شماره‌ی موبایل به نام این کد ملی ثبت نشده است. امضا فقط با سیم‌کارتی ممکن است که به نام خودِ صاحب کد ملی باشد.";
