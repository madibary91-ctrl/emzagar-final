"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots, messengerChats } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { requireUser } from "@/modules/auth/session";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { requireTeam } from "@/modules/tenancy/context";
import { botInScope, chatTargetsForUser, connectBot, createLinkCode, deleteBot, registerBot, setChatUser } from "./service";
import { deliver } from "./send";
import { isProvider } from "./util";

export type MsgState = { ok?: boolean; error?: string; info?: string; url?: string };

/** محدوده‌ی مدیریت: «platform» فقط مدیر کل؛ در غیر این صورت مدیر فضای کاری فعال (دسترسی settings) */
async function adminScope(scope: string): Promise<{ userId: number; workspaceId: number | null; path: string }> {
  if (scope === "platform") {
    const u = await requirePlatformAdmin();
    return { userId: u.id, workspaceId: null, path: "/platform/messengers" };
  }
  const a = await requireTeam("settings");
  return { userId: a.id, workspaceId: a.workspaceId, path: "/admin/messengers" };
}

export async function addBotAction(_prev: MsgState, fd: FormData): Promise<MsgState> {
  const s = await adminScope(String(fd.get("scope") || ""));
  const provider = String(fd.get("provider") || "");
  if (!isProvider(provider)) return { error: "نوع پیام‌رسان نامعتبر است" };
  const r = await registerBot({
    workspaceId: s.workspaceId,
    provider,
    token: String(fd.get("token") || ""),
    apiBase: String(fd.get("apiBase") || ""),
    mode: String(fd.get("mode") || "webhook"),
    label: String(fd.get("label") || ""),
  });
  if (!r.ok) return { error: r.error };
  await logAudit({ workspaceId: s.workspaceId ?? undefined, action: "messenger.bot_added", userId: s.userId, detail: `${provider} #${r.id}` });
  revalidatePath(s.path);
  return r.warning ? { ok: true, error: `ربات ثبت شد ولی اتصال کامل نشد: ${r.warning}` } : { ok: true, info: "ربات متصل شد. حالا از «حساب من ← پیام‌رسان‌ها» خودتان را وصل و با «ارسال پیام آزمایشی» تست کنید." };
}

/** عملیات روی یک ربات: connect | toggle | delete | settings | test */
export async function botOpAction(_prev: MsgState, fd: FormData): Promise<MsgState> {
  const s = await adminScope(String(fd.get("scope") || ""));
  const id = Number(fd.get("id"));
  const op = String(fd.get("op") || "");
  if (!Number.isInteger(id)) return { error: "ربات نامعتبر است" };
  const bot = await botInScope(id, s.workspaceId);
  if (!bot) return { error: "ربات یافت نشد" };
  const done = async (detail: string, info: string): Promise<MsgState> => {
    await logAudit({ workspaceId: s.workspaceId ?? undefined, action: `messenger.${op}`, userId: s.userId, detail });
    revalidatePath(s.path);
    return { ok: true, info };
  };
  switch (op) {
    case "connect": {
      const r = await connectBot(id);
      revalidatePath(s.path);
      return r.ok ? { ok: true, info: "اتصال با موفقیت برقرار/تازه شد" } : { error: r.error };
    }
    case "toggle":
      await db.update(messengerBots).set({ active: !bot.active }).where(eq(messengerBots.id, id));
      return done(`#${id}`, bot.active ? "ربات غیرفعال شد" : "ربات فعال شد");
    case "delete":
      await deleteBot(id);
      return done(`#${id}`, "ربات حذف شد");
    case "settings": {
      const otpMode = ["off", "prefer", "both"].includes(String(fd.get("otpMode"))) ? String(fd.get("otpMode")) : "prefer";
      const mode = fd.get("mode") === "polling" ? "polling" : "webhook";
      await db.update(messengerBots).set({ otpMode, sendPdf: fd.get("sendPdf") === "on", mode }).where(eq(messengerBots.id, id));
      // تغییر حالت دریافت (وب‌هوک ⇄ polling) باید در سمت پیام‌رسان هم اعمال شود
      if (mode !== bot.mode) {
        const r = await connectBot(id);
        revalidatePath(s.path);
        if (!r.ok) return { error: `تنظیمات ذخیره شد ولی اتصال با حالت جدید برقرار نشد: ${r.error}` };
      }
      return done(`#${id}`, "تنظیمات ذخیره شد");
    }
    case "test": {
      const targets = (await chatTargetsForUser(s.userId)).filter((t) => t.bot.id === id);
      if (!targets.length) return { error: "حساب شما هنوز به این ربات وصل نیست. از «حساب من ← پیام‌رسان‌ها» وصل شوید و دوباره امتحان کنید." };
      let ok = 0;
      let err = "";
      for (const t of targets) {
        const r = await deliver(t, { text: "✅ پیام آزمایشی امضاگیر — اتصال ربات برقرار است." }, { kind: "test", final: true });
        if (r.ok) ok++;
        else err = r.error;
      }
      revalidatePath(s.path);
      return ok ? { ok: true, info: `پیام آزمایشی به ${ok} گفتگو ارسال شد` } : { error: err || "ارسال ناموفق بود" };
    }
    default:
      return { error: "عملیات نامعتبر است" };
  }
}

/* ───────── کاربر: اتصال حساب من ───────── */

/** ساخت لینک عمیق یک‌بارمصرف (۱۰ دقیقه) برای اتصال حساب فعلی به ربات */
export async function createLinkAction(botId: number): Promise<MsgState> {
  const user = await requireUser();
  if (!Number.isInteger(botId)) return { error: "ربات نامعتبر است" };
  const r = await createLinkCode(user.id, botId);
  return r.ok ? { ok: true, url: r.url } : { error: r.error };
}

export async function unlinkChatAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id)) return;
  const [chat] = await db.select({ id: messengerChats.id }).from(messengerChats).where(and(eq(messengerChats.id, id), eq(messengerChats.userId, user.id)));
  if (chat) await setChatUser(chat.id, null);
  revalidatePath("/account");
}

export async function muteChatAction(fd: FormData): Promise<void> {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  if (!Number.isInteger(id)) return;
  const muted = fd.get("muted") === "1";
  await db.update(messengerChats).set({ muted }).where(and(eq(messengerChats.id, id), eq(messengerChats.userId, user.id)));
  revalidatePath("/account");
}
