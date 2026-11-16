export type WebhookProvider = "telegram" | "bale" | "rubika" | "eitaa" | "generic";

export const PROVIDERS: { id: WebhookProvider; label: string; hint: string }[] = [
  { id: "telegram", label: "تلگرام", hint: "توکن ربات از BotFather؛ شناسه‌ی چت یا @کانال" },
  { id: "bale", label: "بله", hint: "توکن ربات از «پدر بات‌ها»؛ شناسه‌ی چت (chat_id)" },
  { id: "rubika", label: "روبیکا", hint: "توکن ربات روبیکا؛ شناسه‌ی چت (chat_id)" },
  { id: "eitaa", label: "ایتا (ایتایار)", hint: "توکن ایتایار (eitaayar.ir)؛ شناسه‌ی کانال/گروه — ایتا فقط ارسال یک‌طرفه به کانال/گروه را پشتیبانی می‌کند" },
  { id: "generic", label: "وب‌هوک عمومی (JSON)", hint: "آدرس HTTPS؛ با امضای HMAC-SHA256 در هدر X-Emzagar-Signature" },
];

/** رویدادهایی که فقط با انتخاب صریح مقصد ارسال می‌شوند (مقصد «همه‌ی رویدادها» آن‌ها را نمی‌گیرد؛ چون متن مشتری دارند) */
export const EXPLICIT_ONLY_EVENTS: readonly string[] = ["chat.message", "chat.platform"];

export const EVENTS: { id: string; label: string }[] = [
  { id: "contract.issued", label: "صدور قرارداد" },
  { id: "contract.signed", label: "امضای یکی از طرفین" },
  { id: "contract.completed", label: "تکمیل قرارداد (همه امضا کردند)" },
  { id: "contract.rejected", label: "رد قرارداد" },
  { id: "contract.reminder", label: "ارسال یادآوری" },
  { id: "contract.expired", label: "انقضای قرارداد" },
  { id: "contract.cancelled", label: "لغو قرارداد" },
  { id: "chat.message", label: "گفتگوی آنلاین: پیام تازه/بی‌پاسخ برای تیم شما (فقط با انتخاب صریح)" },
  { id: "chat.platform", label: "گفتگوی آنلاین: پشتیبانی پلتفرم (فقط مالک فضای کاریِ مدیر کل؛ فقط با انتخاب صریح)" },
  { id: "test", label: "پیام آزمایشی" },
];

