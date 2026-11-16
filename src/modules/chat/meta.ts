/**
 * گفتگوی زنده — ثابت‌ها و نوع‌های مشترک (بدون وابستگی به سرور؛ قابل استفاده در کلاینت).
 */
export const CHAT_BODY_MAX = 2000;
export const CHAT_NAME_MAX = 60;
/** پیام‌های یک گفتگو که در هر بار بارگذاری برمی‌گردد */
export const CHAT_HISTORY_LIMIT = 200;
/** پشتیبان تا این مدت پس از آخرین ضربان «آنلاین» حساب می‌شود */
export const AGENT_ONLINE_MS = 70_000;
/** نشانگر «در حال نوشتن…» تا این مدت پس از آخرین ضربان نمایش داده می‌شود */
export const TYPING_MS = 5_000;
/** گفتگوی بسته‌شده تا این مدت هنوز در ویجت مشتری نمایش داده می‌شود (برای امتیازدهی) */
export const CLOSED_VISIBLE_MS = 12 * 3600_000;
/** گفتگوی بی‌فعالیت باز، پس از این مدت خودکار بسته می‌شود */
export const IDLE_CLOSE_MS = 7 * 86400_000;

export type ChatQueue = "platform" | "workspace";
export type ChatContextKind = "panel" | "sign" | "pay" | "site";
export type ChatTarget = "issuer" | "platform";

export const QUEUE_LABELS: Record<ChatQueue, string> = { platform: "پشتیبانی پلتفرم", workspace: "تیم صادرکننده" };
export const CONTEXT_LABELS: Record<ChatContextKind, string> = { panel: "پنل", sign: "صفحه‌ی امضا", pay: "صفحه‌ی پرداخت", site: "سایت" };

export type ChatMsg = {
  id: number;
  kind: "requester" | "staff" | "system";
  name: string;
  body: string;
  at: string;
  internal: boolean;
  cid: string | null;
};

/** وضعیت زنده‌ی گفتگو از دید مشتری */
export type ChatState = {
  status: "open" | "closed";
  /** پشتیبان در حال نوشتن است */
  typing: boolean;
  /** آخرین پیام مشتری که پشتیبان دیده است */
  staffReadId: number;
  unread: number;
  /** آیا پشتیبانی آنلاین است */
  online: boolean;
  assignee: string | null;
  rating: number | null;
  ticketNumber: string | null;
};

export type ChatWidgetContext = {
  kind: ChatContextKind;
  /** sign: توکن امضا | pay: کد پرداخت */
  ref?: string;
  /** panel: شناسه‌ی قرارداد جاری (اختیاری) */
  contractId?: number;
  /** sign/pay/panel(قرارداد): با چه کسی گفتگو شود */
  target?: ChatTarget;
};

export type ChatConversationView = {
  code: string;
  queue: ChatQueue;
  state: ChatState;
  messages: ChatMsg[];
};

export type ChatBootstrap = {
  /** برچسب مقصد: «تیم X» یا «پشتیبانی پلتفرم» */
  title: string;
  queue: ChatQueue;
  /** در صورت وجود دو مقصد (صادرکننده/پلتفرم)، گزینه‌ها */
  targets: { id: ChatTarget; label: string }[];
  target: ChatTarget;
  online: boolean;
  /** نام نمایشی از پیش‌پر برای مهمان */
  name: string;
  /** برای site: نام لازم است */
  needsName: boolean;
  /** خلاصه‌ی زمینه برای نمایش به مشتری، مثلاً «قرارداد ۱۴۰۳-…» */
  contextLabel: string | null;
  conversation: ChatConversationView | null;
};

/* ───── نمای کنسول پشتیبان ───── */

export type StaffListItem = {
  code: string;
  name: string;
  mobile: string;
  contextKind: ChatContextKind;
  contractNumber: string | null;
  status: "open" | "closed";
  unread: number;
  preview: string;
  lastBy: "requester" | "staff" | "system";
  at: string;
  assigneeId: number | null;
  assigneeName: string | null;
  mine: boolean;
  requesterOnline: boolean;
  hasTicket: boolean;
};

export type StaffCounts = { open: number; unassigned: number; mine: number; unread: number; closed: number };

export type StaffContext = {
  requester: { name: string; mobile: string; email: string | null; isGuest: boolean; userId: number | null };
  contextKind: ChatContextKind;
  queue: ChatQueue;
  workspaceName: string | null;
  pagePath: string;
  device: string;
  startedAt: string;
  previousChats: number;
  contract: null | {
    id: number;
    number: string;
    title: string;
    status: string;
    issuedAt: string;
    expiresAt: string | null;
    signers: { label: string; name: string; status: string }[];
    pendingInstallments: number;
    /** پیوند صفحه‌ی قرارداد (فقط برای تیم صادرکننده) */
    href: string | null;
  };
};

export type StaffThread = {
  code: string;
  queue: ChatQueue;
  status: "open" | "closed";
  assigneeId: number | null;
  assigneeName: string | null;
  requesterTyping: boolean;
  requesterOnline: boolean;
  requesterReadId: number;
  rating: number | null;
  ticketNumber: string | null;
  canTicket: boolean;
  messages: ChatMsg[];
  context: StaffContext;
};

/** پاسخ‌های آماده‌ی پشتیبان. {name} با نام مشتری جایگزین می‌شود */
export const QUICK_REPLIES: { title: string; text: string }[] = [
  { title: "خوش‌آمدگویی", text: "سلام {name} عزیز، خوش آمدید 🌱 چطور می‌توانم کمکتان کنم؟" },
  { title: "در حال بررسی", text: "ممنون از صبرتان؛ موضوع را همین الان بررسی می‌کنم و نتیجه را همین‌جا اطلاع می‌دهم." },
  { title: "کد پیامکی نرسید", text: "لطفاً چند دقیقه صبر کنید و دوباره «ارسال کد» را بزنید. اگر باز هم نرسید، مطمئن شوید شماره‌ی همراه شما درست است و پیامک‌های تبلیغاتی مسدود نشده‌اند." },
  { title: "مشکل پرداخت", text: "اگر مبلغ از حساب شما کسر شده ولی پرداخت تأیید نشده، نگران نباشید؛ معمولاً تا ۷۲ ساعت برگشت می‌خورد. شماره‌ی پیگیری بانکی را برایم بفرستید تا بررسی کنم." },
  { title: "درخواست اطلاعات", text: "برای بررسی دقیق‌تر، لطفاً شماره‌ی قرارداد و توضیح کوتاهی از اتفاقی که افتاد بفرستید." },
  { title: "پایان گفتگو", text: "اگر سوال دیگری ندارید، گفتگو را می‌بندم. از اینکه با ما بودید سپاسگزارم 🙏" },
];

export function renderQuickReply(text: string, name: string): string {
  return text.replace(/\{name\}/g, name.trim() || "کاربر");
}

/** پاک‌سازی متن پیام: یکسان‌سازی خط جدید، حذف نویسه‌های کنترلی و بریدن به سقف */
export function cleanChatText(raw: unknown, max = CHAT_BODY_MAX): string {
  return String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}
