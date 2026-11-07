/** ثابت‌های سیستم تیکت (بدون وابستگی به سرور؛ قابل استفاده در کلاینت) */
export const TICKET_STATUSES = ["open", "in_progress", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const STATUS_META: Record<TicketStatus, { label: string; badge: string }> = {
  open: { label: "باز", badge: "bg-sky-50 text-sky-700" },
  in_progress: { label: "در حال بررسی", badge: "bg-amber-50 text-amber-700" },
  closed: { label: "بسته", badge: "bg-stone-100 text-stone-600" },
};

export const CATEGORIES: Record<string, string> = {
  general: "عمومی",
  technical: "مشکل فنی",
  billing: "مالی و اشتراک",
  ai: "هوش مصنوعی",
  wordpress: "افزونه‌ی وردپرس",
  feature: "پیشنهاد قابلیت",
};

export const PRIORITIES: Record<string, { label: string; badge: string }> = {
  low: { label: "کم", badge: "bg-stone-100 text-stone-600" },
  normal: { label: "عادی", badge: "bg-sky-50 text-sky-700" },
  high: { label: "زیاد", badge: "bg-orange-50 text-orange-700" },
  urgent: { label: "فوری", badge: "bg-rose-50 text-rose-700" },
};

export const isStatus = (s: string): s is TicketStatus => (TICKET_STATUSES as readonly string[]).includes(s);
export const statusMeta = (s: string) => STATUS_META[isStatus(s) ? s : "open"];
export const SUBJECT_MAX = 150;
export const BODY_MAX = 5000;
