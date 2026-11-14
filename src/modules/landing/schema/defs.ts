import { type FieldDef, type SectionDef, type SectionType, opt } from "./model";

const T = (key: string, label: string, max = 120, extra: Partial<Extract<FieldDef, { kind: "text" }>> = {}): FieldDef => ({ key, label, kind: "text", max, ...extra });
const TA = (key: string, label: string, max = 400, rows = 3, hint?: string): FieldDef => ({ key, label, kind: "textarea", max, rows, hint });
const L = (key: string, label: string): FieldDef => ({ key, label, kind: "link" });
const IMG = (key: string, label: string, hint?: string): FieldDef => ({ key, label, kind: "image", hint });
const ICON = (key = "icon", label = "آیکون"): FieldDef => ({ key, label, kind: "icon" });
export const SECTION_DEFS: Record<SectionType, SectionDef> = {
  hero: {
    type: "hero",
    label: "هیرو (بالای صفحه)",
    description: "تیتر اصلی، توضیح کوتاه و دکمه‌های اقدام",
    fields: [
      { key: "variant", label: "چیدمان", kind: "select", options: opt([["split", "متن کنار تصویر"], ["center", "وسط‌چین"]]) },
      { key: "tone", label: "پس‌زمینه", kind: "select", options: opt([["brand", "رنگ اصلی برند (تیره)"], ["surface", "هم‌رنگ صفحه"]]) },
      T("badge", "نشان کوچک بالای تیتر", 60),
      T("title", "تیتر", 90),
      T("titleAccent", "ادامه‌ی تیتر (با رنگ تأکیدی)", 90),
      TA("subtitle", "توضیح زیر تیتر", 300, 3),
      T("primaryLabel", "متن دکمه‌ی اصلی", 40),
      L("primaryHref", "لینک دکمه‌ی اصلی"),
      T("secondaryLabel", "متن دکمه‌ی دوم", 40),
      L("secondaryHref", "لینک دکمه‌ی دوم"),
      T("note", "جمله‌ی اطمینان‌بخش زیر دکمه‌ها", 100),
      { key: "showMock", label: "نمایش تصویر متحرک قرارداد", kind: "toggle", hint: "اگر تصویر خودتان را بارگذاری کنید جای آن نمایش داده می‌شود." },
      IMG("image", "تصویر دلخواه (اختیاری)", "PNG، JPG یا WebP تا ۱٫۵ مگابایت"),
    ],
  },
  logos: {
    type: "logos",
    label: "نوار اعتماد / مشتریان",
    description: "نام یا لوگوی مشتریان و مجموعه‌هایی که از شما استفاده می‌کنند",
    fields: [
      T("heading", "عنوان", 80),
      { key: "items", label: "موارد", kind: "list", itemLabel: "مورد", titleKey: "label", max: 10, fields: [T("label", "نام", 40), IMG("image", "لوگو (اختیاری)")] },
    ],
  },
  stats: {
    type: "stats",
    label: "آمار و اعداد",
    description: "چند عدد برجسته برای جلب اعتماد",
    fields: [
      { key: "items", label: "اعداد", kind: "list", itemLabel: "عدد", titleKey: "value", max: 6, fields: [T("value", "عدد یا مقدار", 16, { placeholder: "مثلاً ۵ دقیقه" }), T("label", "توضیح", 60)] },
    ],
  },
  features: {
    type: "features",
    label: "امکانات",
    description: "کارت‌های ویژگی‌ها با آیکون",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      TA("subheading", "توضیح", 240, 2),
      { key: "columns", label: "تعداد ستون", kind: "select", options: opt([["2", "۲ ستون"], ["3", "۳ ستون"], ["4", "۴ ستون"]]) },
      { key: "style", label: "ظاهر کارت", kind: "select", options: opt([["cards", "کارت"], ["minimal", "ساده"]]) },
      { key: "items", label: "امکانات", kind: "list", itemLabel: "امکان", titleKey: "title", max: 12, fields: [ICON(), T("title", "عنوان", 60), TA("text", "توضیح", 220, 3)] },
    ],
  },
  steps: {
    type: "steps",
    label: "مراحل کار",
    description: "نحوه‌ی کار در چند گام شماره‌دار",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      TA("subheading", "توضیح", 240, 2),
      { key: "items", label: "مراحل", kind: "list", itemLabel: "مرحله", titleKey: "title", max: 6, fields: [T("title", "عنوان", 60), TA("text", "توضیح", 220, 3)] },
    ],
  },
  showcase: {
    type: "showcase",
    label: "معرفی با تصویر",
    description: "ردیف‌های متن + تصویر که یکی در میان چپ و راست می‌شوند",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      { key: "items", label: "ردیف‌ها", kind: "list", itemLabel: "ردیف", titleKey: "title", max: 5, fields: [
        ICON(), T("title", "عنوان", 80), TA("text", "توضیح", 320, 3), TA("bullets", "نکته‌ها", 400, 4, "هر خط یک نکته"),
        IMG("image", "تصویر (اختیاری)"), T("ctaLabel", "متن دکمه", 40), L("ctaHref", "لینک دکمه"),
      ] },
    ],
  },
  testimonials: {
    type: "testimonials",
    label: "نظرات مشتریان",
    description: "نقل‌قول مشتریان واقعی",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      { key: "items", label: "نظرها", kind: "list", itemLabel: "نظر", titleKey: "name", max: 6, fields: [TA("quote", "متن نظر", 300, 3), T("name", "نام", 50), T("role", "سمت یا کسب‌وکار", 60), IMG("avatar", "عکس (اختیاری)")] },
    ],
  },
  pricing: {
    type: "pricing",
    label: "طرح‌ها و قیمت",
    description: "طرح‌های اشتراک به‌صورت خودکار از تنظیمات پلتفرم خوانده می‌شود",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      TA("subheading", "توضیح", 240, 2),
      T("ctaLabel", "متن دکمه‌ی طرح‌ها", 40),
      T("footnote", "یادداشت زیر طرح‌ها", 140),
    ],
  },
  faq: {
    type: "faq",
    label: "پرسش‌های متداول",
    description: "پرسش و پاسخ‌های بازشونده",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      { key: "items", label: "پرسش‌ها", kind: "list", itemLabel: "پرسش", titleKey: "q", max: 15, fields: [T("q", "پرسش", 140), TA("a", "پاسخ", 600, 4)] },
    ],
  },
  cta: {
    type: "cta",
    label: "دعوت به اقدام",
    description: "بنر پایانی با دکمه",
    fields: [
      { key: "tone", label: "رنگ بنر", kind: "select", options: opt([["brand", "رنگ اصلی برند"], ["accent", "رنگ تأکیدی"]]) },
      T("heading", "عنوان", 100),
      TA("text", "توضیح", 240, 2),
      T("primaryLabel", "متن دکمه‌ی اصلی", 40),
      L("primaryHref", "لینک دکمه‌ی اصلی"),
      T("secondaryLabel", "متن دکمه‌ی دوم", 40),
      L("secondaryHref", "لینک دکمه‌ی دوم"),
    ],
  },
  text: {
    type: "text",
    label: "متن آزاد",
    description: "عنوان و چند پاراگراف",
    fields: [
      T("eyebrow", "برچسب کوچک", 40),
      T("heading", "عنوان", 100),
      TA("body", "متن", 2000, 6, "برای پاراگراف جدید یک خط خالی بگذارید"),
      { key: "align", label: "چیدمان", kind: "select", options: opt([["right", "راست‌چین"], ["center", "وسط‌چین"]]) },
    ],
  },
};
export const SECTION_ORDER: SectionType[] = ["hero", "logos", "stats", "features", "steps", "showcase", "testimonials", "pricing", "faq", "cta", "text"];
export const GLOBAL_DEFS = {
  theme: [
    T("brandName", "نام برند در منو و پایین صفحه", 40),
    IMG("logo", "لوگو (اختیاری)", "PNG یا WebP شفاف؛ ارتفاع پیشنهادی ۸۰ پیکسل"),
    { key: "primary", label: "رنگ اصلی برند", kind: "color", hint: "رنگ تیره: پس‌زمینه‌ی هیرو و دکمه‌ها" },
    { key: "accent", label: "رنگ تأکیدی", kind: "color", hint: "رنگ روشن‌تر برای دکمه‌ی اصلی و جزئیات" },
    { key: "mode", label: "حالت نمایش صفحه", kind: "select", options: opt([["light", "روشن"], ["dark", "تیره"], ["auto", "خودکار (طبق دستگاه بازدیدکننده)"]]) },
    { key: "radius", label: "گردی گوشه‌ها", kind: "select", options: opt([["sharp", "کم"], ["soft", "متوسط"], ["round", "زیاد"]]) },
  ] as FieldDef[],
  seo: [
    T("title", "عنوان صفحه در گوگل", 70, { hint: "ترجیحاً زیر ۶۰ نویسه" }),
    TA("description", "توضیح صفحه در گوگل", 180, 3, "ترجیحاً ۱۲۰ تا ۱۶۰ نویسه"),
    IMG("image", "تصویر پیش‌نمایش در شبکه‌های اجتماعی", "اندازه‌ی پیشنهادی ۱۲۰۰×۶۳۰"),
  ] as FieldDef[],
  announcement: [
    { key: "enabled", label: "نمایش نوار اطلاع‌رسانی بالای سایت", kind: "toggle" },
    T("text", "متن", 120),
    L("link", "لینک (اختیاری)"),
  ] as FieldDef[],
  nav: [
    { key: "links", label: "لینک‌های منو", kind: "list", itemLabel: "لینک", titleKey: "label", max: 7, fields: [T("label", "عنوان", 30), L("href", "مقصد")] },
    T("ctaLabel", "متن دکمه‌ی منو", 30),
    L("ctaHref", "لینک دکمه‌ی منو"),
  ] as FieldDef[],
  footer: [
    TA("about", "متن معرفی کوتاه", 240, 3),
    { key: "columns", label: "ستون‌های لینک", kind: "list", itemLabel: "ستون", titleKey: "title", max: 4, fields: [
      T("title", "عنوان ستون", 30),
      { key: "links", label: "لینک‌ها", kind: "list", itemLabel: "لینک", titleKey: "label", max: 6, fields: [T("label", "عنوان", 30), L("href", "مقصد")] },
    ] },
    T("copyright", "متن کپی‌رایت", 120),
  ] as FieldDef[],
};
