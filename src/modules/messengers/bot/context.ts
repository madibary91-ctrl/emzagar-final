import { ASK_CONTACT } from "./texts";
import { type Bot, type Chat, type ChatTarget, touchChat } from "../service";
import { type BridgeReply } from "@/modules/chat/bridge";
import { type Btn } from "../util";
import { type TgMessage } from "../client";
import { deliver } from "../send";
import { getAllSettings } from "@/modules/settings/service";

export interface Ctx extends ChatTarget {
  site: string;
}
export const say = (c: Ctx, text: string, buttons?: Btn[][], replyMarkup?: Record<string, unknown>) =>
  deliver(c, { text, buttons, replyMarkup }, { kind: "reply", final: false, silentLog: true }).catch(() => undefined);
export const linked = (chat: Chat) => !!chat.userId || !!chat.verifiedMobile;
export async function needLink(c: Ctx) {
  await say(
    c,
    `برای استفاده از ربات، ابتدا هویت شما باید به این گفتگو وصل شود:\n\n📱 با دکمه‌ی «اشتراک شماره‌ی من» شماره‌ی موبایل خود را تأیید کنید (مناسب امضاکننده‌ها)\nیا\n🔗 اگر در ${c.site} حساب کاربری دارید، از «حساب من ← پیام‌رسان‌ها» لینک اتصال بگیرید.`,
    undefined,
    ASK_CONTACT,
  );
}
export async function buildCtx(bot: Bot, chatId: string, from?: TgMessage["from"]): Promise<Ctx> {
  const chat = await touchChat(bot, chatId, from);
  const cfg = await getAllSettings(bot.workspaceId ?? 0).catch(() => null);
  return { bot, chat, site: cfg?.site_name || "امضاگیر" };
}
/* ───────── گفتگوی زنده (پل پشتیبانی) ───────── */

export const sayBridge = (c: Ctx, r: BridgeReply) => say(c, r.text, r.buttons);
