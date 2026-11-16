import type { CollectField } from "./schema";

/** نمونه‌های آماده برای کسب‌وکارهای پرتردد (کلینیک، باشگاه، آموزشگاه، رویداد) */
export interface CollectPreset {
  id: string;
  title: string;
  emoji: string;
  description: string;
  body: string;
  fields: CollectField[];
}

export const COLLECT_PRESETS: CollectPreset[] = [
  {
    id: "gym",
    title: "تعهدنامه‌ی باشگاه ورزشی",
    emoji: "🏋️",
    description: "ثبت‌نام و تعهد رعایت مقررات باشگاه",
    body: "اینجانب با آگاهی از وضعیت جسمانی خود و بدون محدودیت پزشکی برای ورزش، در باشگاه ثبت‌نام می‌کنم.\n\nمقررات باشگاه (رعایت نظافت و نظم، استفاده‌ی صحیح از دستگاه‌ها و پیروی از راهنمایی مربیان) را مطالعه کرده و می‌پذیرم.\n\nمسئولیت آسیب‌های ناشی از عدم رعایت توصیه‌های ایمنی بر عهده‌ی خودم است.",
    fields: [
      { key: "national_id", label: "کد ملی", type: "nid", required: true },
      { key: "emergency_phone", label: "شماره‌ی تماس اضطراری", type: "phone", required: true },
      { key: "medical", label: "بیماری یا محدودیت پزشکی (در صورت وجود)", type: "text", required: false },
    ],
  },
  {
    id: "clinic",
    title: "رضایت‌نامه‌ی کلینیک",
    emoji: "🩺",
    description: "رضایت آگاهانه برای ویزیت و خدمات درمانی",
    body: "اینجانب توضیحات لازم درباره‌ی روش درمان، فواید و عوارض احتمالی آن را از پزشک دریافت کرده و با آگاهی کامل رضایت خود را برای انجام خدمات درمانی اعلام می‌کنم.\n\nاطلاعات پزشکی ارائه‌شده توسط اینجانب صحیح است و حق دارم هر زمان از ادامه‌ی درمان انصراف دهم.",
    fields: [
      { key: "national_id", label: "کد ملی", type: "nid", required: true },
      { key: "birth", label: "تاریخ تولد (شمسی)", type: "date", required: true },
      { key: "allergy", label: "حساسیت یا داروی مصرفی", type: "text", required: false },
    ],
  },
  {
    id: "class",
    title: "ثبت‌نام و قوانین آموزشگاه",
    emoji: "🎓",
    description: "پذیرش قوانین دوره و پرداخت",
    body: "با ثبت‌نام در دوره، قوانین آموزشگاه (حضور و غیاب، شهریه، انصراف و جبرانی) را مطالعه کرده و می‌پذیرم.\n\nشهریه‌ی پرداخت‌شده در صورت انصراف پس از شروع دوره، طبق مقررات آموزشگاه مسترد می‌شود.",
    fields: [
      { key: "national_id", label: "کد ملی", type: "nid", required: true },
      { key: "course", label: "دوره‌ی انتخابی", type: "select", required: true, options: ["مقدماتی", "متوسط", "پیشرفته"] },
      { key: "rules", label: "قوانین آموزشگاه را می‌پذیرم", type: "checkbox", required: true },
    ],
  },
  {
    id: "event",
    title: "رضایت حضور و تصویربرداری رویداد",
    emoji: "🎟️",
    description: "حضور در رویداد و انتشار تصاویر",
    body: "با حضور در رویداد، رضایت می‌دهم تصاویر و ویدیوهای ثبت‌شده از من در شبکه‌های اجتماعی و رسانه‌های برگزارکننده منتشر شود.\n\nمقررات رویداد را رعایت می‌کنم و مسئولیت وسایل شخصی خود را می‌پذیرم.",
    fields: [{ key: "email", label: "ایمیل", type: "email", required: false }],
  },
];
