/** ثابت‌های مشترک سرور/کلاینت برای «حافظه‌ی حقوقی» (بدون import سنگین تا در کامپوننت‌های کلاینت امن باشد) */

export const KINDS = ["sample", "policy", "style", "clauses"] as const;
export type KnowledgeKind = (typeof KINDS)[number];

export const KIND_LABELS: Record<KnowledgeKind, string> = {
  sample: "قرارداد نمونه",
  policy: "قوانین و خط‌قرمزهای شرکت",
  style: "راهنمای لحن و نگارش",
  clauses: "کتابخانه‌ی بندها",
};

export const KIND_HINTS: Record<KnowledgeKind, string> = {
  sample: "قراردادهای قبلی شما؛ هوش مصنوعی لحن، ساختار و بندهای مرتبط را از آن‌ها می‌گیرد.",
  policy: "قواعد الزامی (مثلاً سقف جریمه، مدت تضمین، شرایط پرداخت). همیشه رعایت می‌شوند.",
  style: "دستور نگارش برند: واژگان، نام‌گذاری طرفین، لحن رسمی/صمیمی.",
  clauses: "بندهای آماده‌ی تأییدشده‌ی حقوقی که باید عیناً یا نزدیک به متن، استفاده شوند.",
};

export const isKind = (v: unknown): v is KnowledgeKind => typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** سقف‌ها */
export const MAX_DOCS_PER_WORKSPACE = 40;
export const MAX_TOTAL_CHARS = 600_000;
export const MAX_INSTRUCTIONS = 2000;

/** بودجه‌ی نویسه‌ی بخش‌های پرامپت (کنترل هزینه و جلوگیری از پر شدن context) */
export const BUDGET = { policy: 4500, excerpts: 6500, profile: 3000, instructions: 2000, perDocExcerpts: 2, maxExcerpts: 7 } as const;
