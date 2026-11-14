import type { GLOBAL_DEFS } from "./defs";
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
export const opt = (pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));
/* ───────── تعریف بخش‌ها ───────── */
export type SectionType = "hero" | "logos" | "stats" | "features" | "steps" | "showcase" | "testimonials" | "pricing" | "faq" | "cta" | "text";
export interface SectionDef {
  type: SectionType;
  label: string;
  description: string;
  fields: FieldDef[];
}
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
