export type WebhookProvider = "telegram" | "bale" | "rubika" | "generic";

export const PROVIDERS: { id: WebhookProvider; label: string; hint: string }[] = [
  { id: "telegram", label: "تلگرام", hint: "توکن ربات از BotFather؛ شناسه‌ی چت یا @کانال" },
  { id: "bale", label: "بله", hint: "توکن ربات از «پدر بات‌ها»؛ شناسه‌ی چت (chat_id)" },
  { id: "rubika", label: "روبیکا", hint: "توکن ربات روبیکا؛ شناسه‌ی چت (chat_id)" },
  { id: "generic", label: "وب‌هوک عمومی (JSON)", hint: "آدرس HTTPS؛ با امضای HMAC-SHA256 در هدر X-Emzagar-Signature" },
];

export const EVENTS: { id: string; label: string }[] = [
  { id: "contract.issued", label: "صدور قرارداد" },
  { id: "contract.signed", label: "امضای یکی از طرفین" },
  { id: "contract.completed", label: "تکمیل قرارداد (همه امضا کردند)" },
  { id: "contract.rejected", label: "رد قرارداد" },
  { id: "contract.reminder", label: "ارسال یادآوری" },
  { id: "contract.expired", label: "انقضای قرارداد" },
  { id: "contract.cancelled", label: "لغو قرارداد" },
  { id: "test", label: "پیام آزمایشی" },
];

