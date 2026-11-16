/** دسته‌بندی‌های کتابخانه‌ی قالب‌ها */
export const CATEGORIES = [
  { id: "housing", label: "مسکن و ملک", hint: "اجاره، خرید و فروش، ساخت‌وساز", icon: "home", tone: "emerald" },
  { id: "vehicle", label: "خودرو", hint: "خرید، فروش، اجاره و اقساط", icon: "car", tone: "sky" },
  { id: "finance", label: "مالی و اعتباری", hint: "قرض، ضمانت، چک و سفته، مشارکت", icon: "wallet", tone: "amber" },
  { id: "work", label: "کار و استخدام", hint: "استخدام، فریلنسری، NDA، پیمانکاری", icon: "briefcase", tone: "violet" },
  { id: "business", label: "تجاری و خدماتی", hint: "فروش کالا، نمایندگی، نرم‌افزار، بازاریابی", icon: "store", tone: "rose" },
  { id: "personal", label: "شخصی و عمومی", hint: "وکالت، تعهدنامه، امانت، تدریس", icon: "user", tone: "slate" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

/** مشخصات خام یک قالب؛ متن HTML نهایی توسط build.ts ساخته می‌شود */
export interface TemplateSpec {
  key: string;
  category: CategoryId;
  title: string;
  /** توضیح یک‌خطی برای کارت */
  summary: string;
  /** برچسب‌های فرهنگ معاملات ایرانی: چک، سفته، ضامن، بیعانه … */
  tags: string[];
  /** نقش طرف اول (صادرکننده) و طرف دوم (امضاکننده‌ی نهایی) */
  roles: [string, string];
  /** امضاکنندگان میانی (مثلاً «ضامن»)؛ پیش از طرف دوم امضا می‌کنند */
  extraSigners?: string[];
  /** مبنای قانونی خلاصه (برای نمایش به کاربر) */
  legalBasis: string;
  /** عبارت آغازین پس از معرفی طرفین */
  preamble: string;
  /** مواد قرارداد: [عنوان، ...بندها]. بند با «- » شروع شود به‌صورت فهرست نمایش داده می‌شود */
  articles: Array<[string, ...string[]]>;
  /** حذف ماده‌ی «قوه‌ی قاهره» (برای قالب‌هایی که معنا ندارد) */
  noForceMajeure?: boolean;
  /** فیلدهای اضافه‌ی طرف دوم (کلید، عنوان، نوع) */
  p2Fields?: Array<[string, string, "text" | "nid" | "date" | "address" | "phone" | "number"]>;
}

export interface LibraryTemplate {
  key: string;
  category: CategoryId;
  title: string;
  summary: string;
  tags: string[];
  roles: [string, string];
  extraSigners: string[];
  legalBasis: string;
  /** متن HTML آماده‌ی ویرایشگر (شامل جاهای خالی ((کلید|عنوان)) برای پر کردن توسط صادرکننده) */
  body: string;
  articleCount: number;
  wordCount: number;
}
