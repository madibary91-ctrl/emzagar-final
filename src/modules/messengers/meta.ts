/** ثابت‌های ایمن برای کلاینت (بدون هیچ وابستگی به Node/سرور) */
export type MessengerProvider = "telegram" | "bale";

export const MESSENGER_PROVIDERS: { id: MessengerProvider; label: string; apiBase: string; hint: string; creator: string }[] = [
  { id: "bale", label: "بله", apiBase: "https://tapi.bale.ai", hint: "داخل ایران بدون فیلتر؛ توکن را از «پدر بات‌ها» (@botfather در بله) بگیرید", creator: "@botfather در بله" },
  { id: "telegram", label: "تلگرام", apiBase: "https://api.telegram.org", hint: "توکن را از @BotFather بگیرید. سرور ایرانی برای دسترسی به تلگرام به «آدرس رله» نیاز دارد", creator: "@BotFather در تلگرام" },
];

export const providerLabel = (p: string): string => MESSENGER_PROVIDERS.find((x) => x.id === p)?.label ?? p;
export const isProvider = (p: unknown): p is MessengerProvider => p === "telegram" || p === "bale";

