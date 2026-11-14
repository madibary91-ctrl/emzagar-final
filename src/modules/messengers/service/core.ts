import { type BotRef, type TgUser } from "../client";
import { decryptSecret } from "@/lib/crypto";
import { getAllSettings } from "@/modules/settings/service";
import { getOrigin } from "@/lib/request";
import { isProvider } from "../util";
import { messengerBots, messengerChats } from "@/db/schema";
import { trustedAppOrigin } from "@/lib/config";

export type Bot = typeof messengerBots.$inferSelect;
export type Chat = typeof messengerChats.$inferSelect;
export const LINK_CODE_TTL_MS = 10 * 60_000;
export const BOT_COMMANDS = [
  { command: "pending", description: "قراردادهای منتظر امضای من" },
  { command: "contracts", description: "فهرست و وضعیت قراردادها" },
  { command: "status", description: "وضعیت یک قرارداد (با شماره‌ی قرارداد)" },
  { command: "summary", description: "خلاصه‌ی کسب‌وکار (اعضای تیم)" },
  { command: "chats", description: "گفتگوهای آنلاین منتظر پاسخ (پشتیبانی)" },
  { command: "done", description: "پایان پاسخ‌گویی به گفتگوی آنلاین" },
  { command: "verify", description: "تأیید شماره‌ی موبایل برای کد امضا" },
  { command: "mute", description: "بی‌صدا کردن اعلان‌ها" },
  { command: "unmute", description: "فعال کردن اعلان‌ها" },
  { command: "stop", description: "قطع اتصال این گفتگو" },
  { command: "help", description: "راهنما" },
];
export const botRef = (bot: Pick<Bot, "provider" | "tokenEnc" | "apiBase">): BotRef => ({
  provider: isProvider(bot.provider) ? bot.provider : "telegram",
  token: decryptSecret(bot.tokenEnc),
  apiBase: bot.apiBase || undefined,
});
/** آدرس پایه‌ی سایت برای لینک‌های داخل پیام‌رسان (در پس‌زمینه هدر درخواست وجود ندارد) */
export async function appBase(workspaceId?: number | null): Promise<string> {
  let base = "";
  try {
    if (workspaceId) base = ((await getAllSettings(workspaceId)).app_url || "").trim();
  } catch {
    /* تنظیمات در دسترس نبود */
  }
  if (!base) base = trustedAppOrigin();
  if (!base) {
    try {
      base = await getOrigin();
    } catch {
      base = "";
    }
  }
  return base.replace(/\/+$/, "");
}
export async function webhookUrlFor(bot: Pick<Bot, "webhookSecret">): Promise<string> {
  const base = trustedAppOrigin() || (await getOrigin().catch(() => ""));
  return base ? `${base.replace(/\/+$/, "")}/api/messengers/webhook/${bot.webhookSecret}` : "";
}
export const fullName = (u: TgUser) => [u.first_name, u.last_name].filter(Boolean).join(" ").slice(0, 80);
/* ───────── ثبت و اتصال ربات ───────── */

export type RegisterResult = { ok: true; id: number; warning?: string } | { ok: false; error: string };
