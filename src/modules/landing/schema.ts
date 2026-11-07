/**
 * مدل داده‌ی صفحه‌ی اصلی (Landing) — مشترک بین سرور و ویرایشگر کلاینت.
 *
 * طراحی: صفحه = فهرستی از «بخش»‌ها (Section). هر نوع بخش با یک «تعریف فیلد» توصیف می‌شود؛
 * همان تعریف سه کار می‌کند: ۱) ساخت خودکار فرم ویرایشگر  ۲) مقدار پیش‌فرض  ۳) پاک‌سازی امن ورودی سرور.
 * بنابراین افزودن یک بخش یا فیلد جدید فقط یک تعریف می‌خواهد.
 *
 * امنیت: محتوا فقط متن ساده است (هرگز HTML)، لینک‌ها فقط با الگوهای مجاز، رنگ‌ها فقط hex و تصاویر فقط
 * از آپلودهای خود سایت یا https.
 */

export type Value = string | boolean | Props[];
export type Props = { [key: string]: Value };

export type FieldDef =
  | { key: string; label: string; kind: "text"; max?: number; placeholder?: string; hint?: string }
  | { key: string; label: string; kind: "textarea"; max?: number; rows?: number; hint?: string }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; hint?: string }
  | { key: string; label: string; kind: "toggle"; hint?: string }
  | { key: string; label: string; kind: "image"; hint?: string }
  | { key: string; label: string; kind: "link"; hint?: string }
  | { key: string; label: string; kind: "icon" }
  | { key: string; label: string; kind: "color"; hint?: string }
  | { key: string; label: string; kind: "list"; itemLabel: string; titleKey: string; max: number; fields: FieldDef[]; hint?: string };

export const ICON_NAMES = [
  "shield", "fingerprint", "pen", "file", "zap", "users", "lock", "clock", "smartphone", "globe",
  "chart", "bell", "plug", "layers", "key", "check", "sparkles", "wand", "heart", "star",
  "message", "mail", "credit", "cloud", "scan", "rocket", "puzzle", "headset",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export const ICON_LABELS: Record<IconName, string> = {
  shield: "سپر", fingerprint: "اثر انگشت", pen: "قلم", file: "سند", zap: "رعد", users: "کاربران", lock: "قفل", clock: "ساعت",
  smartphone: "موبایل", globe: "کره", chart: "نمودار", bell: "زنگ", plug: "اتصال", layers: "لایه‌ها", key: "کلید", check: "تیک",
  sparkles: "درخشش", wand: "جادو", heart: "قلب", star: "ستاره", message: "پیام", mail: "ایمیل", credit: "کارت", cloud: "ابر",
  scan: "اسکن", rocket: "موشک", puzzle: "پازل", headset: "پشتیبانی",
};

const opt = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

/* ───────── تعریف بخش‌ها ───────── */
export type SectionType = "hero" | "logos" | "stats" | "features" | "steps" | "showcase" | "testimonials" | "pricing" | "faq" | "cta" | "text";

export interface SectionDef {
  type: SectionType;
  label: string;
  description: string;
  fields: FieldDef[];
}

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
export type GlobalGroup = keyof typeof GLOBAL_DEFS;

export interface Section {
  id: string;
  type: SectionType;
  enabled: boolean;
  props: Props;
}
export interface LandingDoc {
  v: 1;
  theme: Props;
  seo: Props;
  announcement: Props;
  nav: Props;
  footer: Props;
  sections: Section[];
}

/* ───────── پاک‌سازی (سرور و کلاینت) ───────── */
const HEX = /^#[0-9a-fA-F]{6}$/;
const LINK_OK = [/^\/(?!\/)[^\s<>"']*$/, /^#[A-Za-z0-9_-]*$/, /^https?:\/\/[^\s<>"']+$/i, /^mailto:[^\s<>"']+$/i, /^tel:[+0-9-]+$/];
const IMAGE_OK = [/^\/api\/landing\/image\/[A-Za-z0-9._-]{1,80}$/, /^https:\/\/[^\s<>"']+$/i];
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;

export function cleanText(v: unknown, max: number, multiline = false): string {
  let s = typeof v === "string" ? v : "";
  s = s.replace(/\r\n?/g, "\n").replace(CTRL, "");
  if (!multiline) s = s.replace(/\s*\n+\s*/g, " ");
  return s.trim().slice(0, max);
}
export function cleanLink(v: unknown): string {
  const s = cleanText(v, 300);
  return LINK_OK.some((re) => re.test(s)) ? s : "";
}
export function cleanImage(v: unknown): string {
  const s = cleanText(v, 400);
  return IMAGE_OK.some((re) => re.test(s)) ? s : "";
}

export function emptyValue(f: FieldDef): Value {
  switch (f.kind) {
    case "toggle": return false;
    case "list": return [];
    case "select": return f.options[0]?.value ?? "";
    default: return "";
  }
}

export function sanitizeProps(fields: FieldDef[], input: unknown): Props {
  const src = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: Props = {};
  for (const f of fields) {
    const raw = src[f.key];
    switch (f.kind) {
      case "text": out[f.key] = cleanText(raw, f.max ?? 120); break;
      case "textarea": out[f.key] = cleanText(raw, f.max ?? 400, true); break;
      case "toggle": out[f.key] = raw === true; break;
      case "link": out[f.key] = cleanLink(raw); break;
      case "image": out[f.key] = cleanImage(raw); break;
      case "color": out[f.key] = typeof raw === "string" && HEX.test(raw) ? raw.toLowerCase() : ""; break;
      case "icon": out[f.key] = (ICON_NAMES as readonly string[]).includes(String(raw)) ? String(raw) : "check"; break;
      case "select": out[f.key] = f.options.some((o) => o.value === raw) ? String(raw) : (f.options[0]?.value ?? ""); break;
      case "list": out[f.key] = Array.isArray(raw) ? raw.slice(0, f.max).map((it) => sanitizeProps(f.fields, it)) : []; break;
    }
  }
  return out;
}

const ID_RE = /^[a-z0-9-]{3,24}$/;
export function newId(): string {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export const MAX_SECTIONS = 30;

function withColorFallback(theme: Props): Props {
  const base = defaultDoc().theme;
  return { ...theme, primary: theme.primary || base.primary, accent: theme.accent || base.accent };
}

export function sanitizeDoc(input: unknown): LandingDoc {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawSections = Array.isArray(src.sections) ? src.sections.slice(0, MAX_SECTIONS) : [];
  const seen = new Set<string>();
  const sections: Section[] = [];
  for (const r of rawSections) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const type = s.type as SectionType;
    const def = SECTION_DEFS[type];
    if (!def) continue;
    let id = typeof s.id === "string" && ID_RE.test(s.id) ? s.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    sections.push({ id, type, enabled: s.enabled !== false, props: sanitizeProps(def.fields, s.props) });
  }
  return {
    v: 1,
    theme: withColorFallback(sanitizeProps(GLOBAL_DEFS.theme, src.theme)),
    seo: sanitizeProps(GLOBAL_DEFS.seo, src.seo),
    announcement: sanitizeProps(GLOBAL_DEFS.announcement, src.announcement),
    nav: sanitizeProps(GLOBAL_DEFS.nav, src.nav),
    footer: sanitizeProps(GLOBAL_DEFS.footer, src.footer),
    sections,
  };
}

/** بخش تازه با مقدار پیش‌فرض مناسب (نمونه‌متن‌های راهنما) */
export function newSection(type: SectionType): Section {
  const base = sanitizeProps(SECTION_DEFS[type].fields, {});
  return { id: newId(), type, enabled: true, props: { ...base, ...SECTION_STARTERS[type] } };
}

/* ───────── رنگ ───────── */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export const PALETTES: { id: string; name: string; primary: string; accent: string; mode: string }[] = [
  { id: "teal", name: "فیروزه‌ای شب", primary: "#102c31", accent: "#41e4ad", mode: "light" },
  { id: "ocean", name: "اقیانوس", primary: "#0b2a4a", accent: "#4cc9f0", mode: "light" },
  { id: "violet", name: "بنفش مدرن", primary: "#271a4f", accent: "#b794f6", mode: "light" },
  { id: "coral", name: "مرجان گرم", primary: "#3a1f1d", accent: "#ff8a6b", mode: "light" },
  { id: "forest", name: "جنگل", primary: "#123524", accent: "#86efac", mode: "light" },
  { id: "midnight", name: "نیمه‌شب (تیره)", primary: "#0f172a", accent: "#38bdf8", mode: "dark" },
  { id: "minimal", name: "مینیمال ایندیگو", primary: "#1e1b4b", accent: "#818cf8", mode: "light" },
];

/* ───────── محتوای پیش‌فرض ───────── */
const SECTION_STARTERS: Record<SectionType, Props> = {
  hero: { variant: "split", tone: "brand", badge: "عنوان کوتاه", title: "تیتر جذاب شما", titleAccent: "با ادامه‌ی رنگی", subtitle: "یک یا دو جمله برای توضیح اینکه محصول شما چه مشکلی را حل می‌کند.", primaryLabel: "شروع کنید", primaryHref: "/register", secondaryLabel: "امکانات", secondaryHref: "#features", showMock: true },
  logos: { heading: "مورد اعتماد", items: [{ label: "نام اول", image: "" }, { label: "نام دوم", image: "" }, { label: "نام سوم", image: "" }] },
  stats: { items: [{ value: "۱۰۰٪", label: "توضیح عدد اول" }, { value: "۲۴/۷", label: "توضیح عدد دوم" }, { value: "۵ دقیقه", label: "توضیح عدد سوم" }] },
  features: { eyebrow: "امکانات", heading: "چرا ما؟", subheading: "دلایل اصلی انتخاب محصول شما", columns: "3", style: "cards", items: [{ icon: "check", title: "امکان اول", text: "توضیح کوتاه درباره‌ی این امکان." }, { icon: "zap", title: "امکان دوم", text: "توضیح کوتاه درباره‌ی این امکان." }, { icon: "shield", title: "امکان سوم", text: "توضیح کوتاه درباره‌ی این امکان." }] },
  steps: { eyebrow: "چطور کار می‌کند", heading: "در چند گام ساده", subheading: "", items: [{ title: "گام اول", text: "توضیح" }, { title: "گام دوم", text: "توضیح" }, { title: "گام سوم", text: "توضیح" }] },
  showcase: { eyebrow: "", heading: "", items: [{ icon: "sparkles", title: "عنوان ردیف", text: "توضیح کوتاه درباره‌ی این ردیف.", bullets: "نکته‌ی اول\nنکته‌ی دوم", image: "", ctaLabel: "", ctaHref: "" }] },
  testimonials: { eyebrow: "نظر مشتریان", heading: "مشتریان چه می‌گویند", items: [{ quote: "متن نظر مشتری را اینجا بنویسید.", name: "نام مشتری", role: "سمت یا کسب‌وکار", avatar: "" }] },
  pricing: { eyebrow: "قیمت‌گذاری", heading: "طرح مناسب خودتان را انتخاب کنید", subheading: "طرح‌ها و قیمت‌ها از تنظیمات اشتراک خوانده می‌شوند.", ctaLabel: "مقایسه‌ی کامل طرح‌ها", footnote: "" },
  faq: { eyebrow: "پرسش‌ها", heading: "پرسش‌های متداول", items: [{ q: "پرسش اول؟", a: "پاسخ پرسش اول." }, { q: "پرسش دوم؟", a: "پاسخ پرسش دوم." }] },
  cta: { tone: "brand", heading: "آماده‌اید شروع کنیم؟", text: "همین حالا ثبت‌نام کنید.", primaryLabel: "ثبت‌نام", primaryHref: "/register", secondaryLabel: "", secondaryHref: "" },
  text: { eyebrow: "", heading: "عنوان", body: "متن خود را اینجا بنویسید.", align: "right" },
};

function sec(id: string, type: SectionType, props: Props, enabled = true): Section {
  return { id, type, enabled, props: sanitizeProps(SECTION_DEFS[type].fields, props) };
}

export function defaultDoc(siteName = "امضاگیر"): LandingDoc {
  const sections: Section[] = [
    sec("hero", "hero", {
      variant: "split", tone: "brand", badge: "امضای دیجیتال با تأیید هویت پیامکی",
      title: "قرارداد را آنلاین امضا کنید،", titleAccent: "بدون کاغذ و بدون دردسر.",
      subtitle: `با ${siteName} قرارداد را بسازید، برای مشتری بفرستید و در چند دقیقه امضای معتبر همراه با شناسنامه‌ی دیجیتال دریافت کنید.`,
      primaryLabel: "ساخت حساب رایگان", primaryHref: "/register", secondaryLabel: "دیدن امکانات", secondaryHref: "#features",
      note: "بدون نیاز به کارت بانکی · راه‌اندازی در چند دقیقه", showMock: true,
    }),
    sec("trust", "logos", {
      heading: "مناسب کسب‌وکارهایی که قرارداد زیاد می‌بندند",
      items: [{ label: "آژانس‌های دیجیتال" }, { label: "فروشگاه‌های اینترنتی" }, { label: "املاک و مستغلات" }, { label: "آموزشگاه‌ها" }, { label: "شرکت‌های خدماتی" }],
    }),
    sec("stats", "stats", {
      items: [{ value: "۵ دقیقه", label: "از ثبت‌نام تا اولین قرارداد" }, { value: "OTP", label: "تأیید هویت پیامکی پیش از امضا" }, { value: "SHA-256", label: "اثر انگشت یکتا برای هر سند" }, { value: "۲۴/۷", label: "دسترسی از هر دستگاه" }],
    }),
    sec("features", "features", {
      eyebrow: "امکانات", heading: "همه‌چیز برای امضای مطمئن", subheading: "از ساخت قالب تا بایگانی؛ بدون هیچ دانش فنی.", columns: "3", style: "cards",
      items: [
        { icon: "fingerprint", title: "تأیید هویت با کد پیامکی", text: "هر امضاکننده پیش از امضا با کد یک‌بارمصرف تأیید می‌شود؛ کد منقضی می‌شود و تعداد تلاش محدود است." },
        { icon: "pen", title: "امضای دست‌نویس یا تصویر", text: "امضا با انگشت یا ماوس روی بوم ترسیم می‌شود یا تصویر امضا بارگذاری می‌گردد." },
        { icon: "file", title: "قالب و متغیرهای هوشمند", text: "قالب‌های آماده بسازید و نام، مبلغ و تاریخ را به‌صورت خودکار جایگذاری کنید." },
        { icon: "users", title: "چند امضاکننده با ترتیب", text: "مالی، فروش و مشتری هر کدام نوبت خود را دارند و نفر بعدی خودکار فعال می‌شود." },
        { icon: "shield", title: "شناسنامه‌ی دیجیتال", text: "زمان، IP و اثر انگشت سند ثبت می‌شود تا هر قرارداد قابل راستی‌آزمایی باشد." },
        { icon: "sparkles", title: "هوش مصنوعی و تحلیل ریسک", text: "پیش‌نویس قرارداد را با هوش مصنوعی بنویسید و بندهای پرخطر را پیش از ارسال ببینید." },
      ],
    }),
    sec("how", "steps", {
      eyebrow: "چطور کار می‌کند", heading: "چهار گام تا قرارداد امضاشده", subheading: "",
      items: [
        { title: "قالب را انتخاب کنید", text: "از قالب‌های آماده استفاده کنید یا متن خودتان را بنویسید." },
        { title: "برای طرف مقابل بفرستید", text: "لینک امن قرارداد با پیامک یا ایمیل ارسال می‌شود." },
        { title: "تأیید هویت و امضا", text: "طرف مقابل با کد پیامکی وارد می‌شود و امضا می‌کند." },
        { title: "بایگانی و پیگیری", text: "نسخه‌ی نهایی با شناسنامه‌ی دیجیتال در پنل شما می‌ماند." },
      ],
    }),
    sec("wordpress", "showcase", {
      eyebrow: "اتصال به سایت شما", heading: "کنار ابزارهایی که از قبل دارید",
      items: [
        { icon: "plug", title: "افزونه‌ی وردپرس و ووکامرس", text: "با یک افزونه، امضای قرارداد را به فرایند خرید فروشگاه‌تان اضافه کنید.", bullets: "نصب و اتصال یک‌کلیکی\nسازگار با المنتور\nورود مستقیم به پنل از وردپرس", image: "", ctaLabel: "", ctaHref: "" },
        { icon: "wand", title: "API و وب‌هوک", text: "قرارداد را از هر نرم‌افزاری صادر کنید و وضعیت امضا را لحظه‌ای دریافت کنید.", bullets: "کلید API اختصاصی\nاعلان در تلگرام و بله\nمستندات کامل", image: "", ctaLabel: "", ctaHref: "" },
      ],
    }),
    sec("reviews", "testimonials", {
      eyebrow: "نظر مشتریان", heading: "مشتریان ما چه می‌گویند",
      items: [{ quote: "این نمونه‌متن است؛ نظر واقعی مشتری‌تان را اینجا بنویسید و بخش را روشن کنید.", name: "نام مشتری", role: "مدیر یک کسب‌وکار", avatar: "" }],
    }, false),
    sec("pricing", "pricing", {
      eyebrow: "قیمت‌گذاری", heading: "طرحی متناسب با اندازه‌ی کسب‌وکار شما", subheading: "با طرح رایگان شروع کنید و هر زمان خواستید ارتقا دهید.",
      ctaLabel: "مقایسه‌ی کامل طرح‌ها", footnote: "قیمت‌ها به تومان و ماهانه است.",
    }),
    sec("faq", "faq", {
      eyebrow: "پرسش‌ها", heading: "پرسش‌های متداول",
      items: [
        { q: "امضای آنلاین از نظر قانونی معتبر است؟", a: "هر امضا همراه با تأیید هویت پیامکی، زمان، IP و اثر انگشت سند ثبت می‌شود که ادله‌ی مهمی برای اثبات است. برای قراردادهای خاص با مشاور حقوقی خود هم مشورت کنید." },
        { q: "طرف مقابل باید حساب کاربری بسازد؟", a: "خیر. او فقط لینک قرارداد را باز می‌کند، با کد پیامکی تأیید می‌شود و امضا می‌کند." },
        { q: "می‌توانم قالب قرارداد خودم را بسازم؟", a: "بله. ویرایشگر قالب دارید و با متغیرهایی مثل نام و مبلغ، هر قرارداد را خودکار پر می‌کنید." },
        { q: "آیا با وردپرس و ووکامرس کار می‌کند؟", a: "بله. افزونه‌ی اختصاصی داریم که با چند کلیک نصب و متصل می‌شود." },
        { q: "اطلاعات و امضاها کجا نگهداری می‌شود؟", a: "امضاها خارج از دسترس عمومی نگهداری می‌شوند و فقط افراد مجاز به آن‌ها دسترسی دارند." },
      ],
    }),
    sec("start", "cta", {
      tone: "brand", heading: "اولین قرارداد را همین امروز امضا کنید", text: "ثبت‌نام رایگان است و کمتر از ۵ دقیقه طول می‌کشد.",
      primaryLabel: "ساخت حساب رایگان", primaryHref: "/register", secondaryLabel: "ورود به حساب", secondaryHref: "/login",
    }),
  ];
  return {
    v: 1,
    theme: { brandName: siteName, logo: "", primary: "#102c31", accent: "#41e4ad", mode: "light", radius: "round" },
    seo: { title: `${siteName} — امضای آنلاین قرارداد`, description: "ساخت، ارسال و امضای آنلاین قرارداد با تأیید هویت پیامکی و شناسنامه‌ی دیجیتال. مناسب فروشگاه‌ها، آژانس‌ها و کسب‌وکارهای ایرانی.", image: "" },
    announcement: { enabled: false, text: "🎉 طرح حرفه‌ای را امتحان کنید", link: "/pricing" },
    nav: {
      links: [{ label: "امکانات", href: "#features" }, { label: "مراحل", href: "#how" }, { label: "قیمت‌ها", href: "#pricing" }, { label: "پرسش‌ها", href: "#faq" }],
      ctaLabel: "ورود", ctaHref: "/login",
    },
    footer: {
      about: "پلتفرم امضای آنلاین قرارداد با تأیید هویت پیامکی، شناسنامه‌ی دیجیتال و اتصال به وردپرس.",
      columns: [
        { title: "محصول", links: [{ label: "امکانات", href: "#features" }, { label: "قیمت‌ها", href: "/pricing" }, { label: "استعلام اصالت سند", href: "/verify" }] },
        { title: "حساب کاربری", links: [{ label: "ورود", href: "/login" }, { label: "ثبت‌نام", href: "/register" }, { label: "پشتیبانی", href: "/support" }] },
      ],
      copyright: `© ${siteName} — همه‌ی حقوق محفوظ است.`,
    },
    sections,
  };
}

/** هر بخش چه آدرس‌هایی (لنگر) برای لینک‌دهی داخلی دارد */
export function anchorOptions(doc: LandingDoc): { value: string; label: string }[] {
  return doc.sections.map((s) => ({ value: `#${s.id}`, label: `بخش «${SECTION_DEFS[s.type].label}»` }));
}

export const PAGE_LINKS: { value: string; label: string }[] = [
  { value: "/login", label: "صفحه‌ی ورود" },
  { value: "/register", label: "صفحه‌ی ثبت‌نام" },
  { value: "/pricing", label: "صفحه‌ی قیمت‌ها" },
  { value: "/verify", label: "استعلام اصالت سند" },
  { value: "/support", label: "پشتیبانی" },
];
