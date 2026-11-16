"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messengerBots, messengerChats } from "@/db/schema";
import { logAudit } from "@/modules/audit/service";
import { requireUser } from "@/modules/auth/session";
import { requirePlatformAdmin } from "@/modules/platform/admin";
import { requireTeam } from "@/modules/tenancy/context";
import { applyBotSettings, botInScope, chatTargetsForUser, connectBot, createLinkCode, deleteBot, registerBot, setBotActive, setChatUser } from "./service";
import { diagnoseBot, type Check } from "./diagnose";
import { explainDeliveryError } from "@/modules/webhooks/explain";
import { deliver } from "./send";
import { isProvider } from "./util";

export type MsgState = { ok?: boolean; error?: string; info?: string; url?: string; checks?: Check[]; fixable?: boolean; healthy?: boolean };

/** خطای «آدرس HTTPS نیست» که با رفتن به حالت Polling کاملاً قابل‌دور زدن است */
const NEEDS_HTTPS = /HTTPS/;

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
  // بن‌بست رایج: سایت HTTPS عمومی ندارد ⇒ وب‌هوک هرگز کار نمی‌کند. به‌جای رها کردن ربات در حالت «خطا»، خودکار به Polling می‌رویم.
  if (r.warning && NEEDS_HTTPS.test(r.warning) && String(fd.get("mode") || "webhook") !== "polling") {
    await db.update(messengerBots).set({ mode: "polling" }).where(eq(messengerBots.id, r.id));
    const c = await connectBot(r.id);
    revalidatePath(s.path);
    if (c.ok) return { ok: true, info: "آدرس سایت HTTPS عمومی ندارد، پس ربات خودکار روی حالت «پرسش دوره‌ای (Polling)» راه‌اندازی شد و همین حالا کار می‌کند. هر وقت HTTPS داشتید می‌توانید در تنظیمات ربات به «وب‌هوک» برگردید. حالا از «حساب من ← پیام‌رسان‌ها» خودتان را وصل و تست کنید." };
    return { ok: true, error: `ربات ثبت شد ولی اتصال کامل نشد: ${c.error}` };
  }
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
    case "toggle": {
      // M-07: خاموش‌کردن وب‌هوک را برمی‌دارد و روشن‌کردن دوباره وصل می‌کند (پیش‌تر فقط یک پرچم بود)
      const r = await setBotActive(id, !bot.active);
      if (!r.ok) {
        revalidatePath(s.path);
        return { error: `ربات فعال شد ولی اتصال برقرار نشد: ${r.error}` };
      }
      return done(`#${id}`, bot.active ? "ربات غیرفعال شد" : "ربات فعال شد");
    }
    case "delete":
      await deleteBot(id);
      return done(`#${id}`, "ربات حذف شد");
    case "settings": {
      const otpMode = ["off", "prefer", "both"].includes(String(fd.get("otpMode"))) ? String(fd.get("otpMode")) : "prefer";
      const mode = fd.get("mode") === "polling" ? "polling" : "webhook";
      // M-06: اگر حالت جدید روی پیام‌رسان اعمال نشد، حالت قبلی بازمی‌گردد (ربات کور نمی‌ماند)
      const r = await applyBotSettings(id, { otpMode, sendPdf: fd.get("sendPdf") === "on", mode });
      if (!r.ok) {
        revalidatePath(s.path);
        return { error: `حالت دریافت تغییر نکرد: ${r.error}. ${r.rolledBack ? "ربات روی حالت قبلی سالم ماند." : "اتصال را با «اتصال دوباره» بررسی کنید."}` };
      }
      return done(`#${id}`, "تنظیمات ذخیره شد");
    }
    case "test": {
      const targets = (await chatTargetsForUser(s.userId)).filter((t) => t.bot.id === id);
      if (!targets.length) {
        // بن‌بست: پیام آزمایشی نیاز به اتصال حساب دارد. به‌جای ارجاع به صفحه‌ی دیگر، لینک اتصال یک‌بارمصرف را همین‌جا می‌دهیم.
        const link = await createLinkCode(s.userId, id);
        return link.ok
          ? { error: "حساب شما هنوز به این ربات وصل نیست. روی «اتصال حساب من به این ربات» بزنید، در پیام‌رسان Start را بزنید و دوباره «ارسال پیام آزمایشی» را بزنید.", url: link.url }
          : { error: "حساب شما هنوز به این ربات وصل نیست. از «حساب من ← پیام‌رسان‌ها» وصل شوید و دوباره امتحان کنید." };
      }
      let ok = 0;
      let err = "";
      for (const t of targets) {
        const r = await deliver(t, { text: "✅ پیام آزمایشی امضاگیر — اتصال ربات برقرار است." }, { kind: "test", final: true });
        if (r.ok) ok++;
        else err = r.error;
      }
      revalidatePath(s.path);
      if (ok) return { ok: true, info: `پیام آزمایشی به ${ok} گفتگو ارسال شد` };
      const x = explainDeliveryError(err, bot.provider);
      return { error: err ? `${x.title}. ${x.hint}` : "ارسال ناموفق بود" };
    }
    case "diagnose": {
      const d = await diagnoseBot(id, { fix: fd.get("fix") === "1" });
      revalidatePath(s.path);
      if (!d) return { error: "ربات یافت نشد" };
      return { ok: true, checks: d.checks, fixable: d.fixable, healthy: d.healthy, info: d.healthy ? "همه‌چیز سالم است ✓" : d.fixable ? "مشکل پیدا شد؛ «رفع خودکار» را بزنید." : "مشکل پیدا شد؛ موارد قرمز را ببینید." };
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
