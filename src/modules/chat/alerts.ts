import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { messengerChats } from "@/db/schema";
import { enqueueJob } from "@/modules/jobs/queue";

/**
 * موتور اعلان گفتگوی زنده به پیام‌رسان‌ها (بله، تلگرام، ایتا/روبیکا/وب‌هوک عمومی) — بخش «زمان‌بندی».
 *
 * اصول طراحی:
 *  ۱. هیچ پیامی گم نمی‌شود: اگر کسی آنلاین نیست، فوری اعلان می‌رود؛ اگر پشتیبانی «آنلاین» است اما پیام را ندیده،
 *     پس از ALERT_ESCALATE_MS بالا می‌رود (Escalation)، و اگر باز هم بی‌پاسخ ماند یادآوری (۱۰ و ۳۰ دقیقه) می‌رسد.
 *  ۲. بارش اعلان نداریم: هر گفتگو حداکثر هر ALERT_THROTTLE_MS یک اعلان می‌گیرد و پیام‌های میانی در همان اعلان بعدی جمع (Digest) می‌شوند؛
 *     پیام آخرِ پشت‌محدودیت هرگز فراموش نمی‌شود (job «tail»).
 *  ۳. هوشمند و هدفمند: گفتگوی دارای مسئول فقط به مسئول می‌رود (یادآوری به همه)؛ بی‌مسئول به همه‌ی تیم پاسخ‌گو.
 *  ۴. پاسخ از همان‌جا: دکمه‌ی «پاسخ از همین‌جا» پیام‌رسان را به پل دوطرفه با گفتگو تبدیل می‌کند؛ پیام‌های مشتری فوری (Relay) می‌رسد.
 *  ۵. متن پیام در جدول صف ذخیره نمی‌شود؛ فقط شناسه‌ها. متن هنگام ارسال از دیتابیس ساخته می‌شود.
 */

const secs = (name: string, def: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n >= min && n <= max ? n : def) * 1000;
};

/** پشتیبانِ آنلاین، اگر تا این مدت پیام مشتری را ندیده باشد، به پیام‌رسان خبر داده می‌شود */
export const ALERT_ESCALATE_MS = secs("CHAT_ALERT_ESCALATE_SECONDS", 90, 5, 3600);
/** حداقل فاصله‌ی دو اعلان برای یک گفتگو (پیام‌های میانی در اعلان بعدی خلاصه می‌شوند) */
export const ALERT_THROTTLE_MS = secs("CHAT_ALERT_THROTTLE_SECONDS", 120, 0, 3600);
/** یادآوری اول و دوم برای گفتگوی همچنان بی‌پاسخ */
export const ALERT_REMIND_MS = [10 * 60_000, 20 * 60_000] as const;
/** مدت اعتبار «حالت پاسخ‌گویی» در پیام‌رسان (با هر پیام تمدید می‌شود) */
export const REPLY_SESSION_MS = 15 * 60_000;

export type AlertPhase = "now" | "escalate" | "tail" | "remind";

export interface AlertJob {
  convId: number;
  msgId: number;
  phase: AlertPhase;
  /** شماره‌ی یادآوری (فقط phase=remind) */
  n?: number;
}

/** پس از ثبت پیام مشتری صدا زده می‌شود. خطا پرتاب نمی‌کند؛ جریان اصلی چت هرگز نباید بشکند. */
export async function scheduleStaffAlert(p: { convId: number; msgId: number; staffOnline: boolean }): Promise<void> {
  try {
    const phase: AlertPhase = p.staffOnline ? "escalate" : "now";
    await enqueueJob("chat.alert", { convId: p.convId, msgId: p.msgId, phase } satisfies AlertJob, {
      delayMs: p.staffOnline ? ALERT_ESCALATE_MS : 0,
      dedupeKey: `ca:${p.convId}:${phase}:${p.msgId}`,
    });
  } catch (e) {
    console.error("[chat:alert-schedule]", e instanceof Error ? e.message : e);
  }
}

/**
 * پل زنده: پشتیبانی که در پیام‌رسان «پاسخ از همین‌جا» را زده، هر پیام تازه‌ی مشتری را بی‌درنگ (بدون محدودیت) می‌گیرد.
 * شناسه‌ی چت‌های دارای نشست فعال را برمی‌گرداند.
 */
export async function relayToLiveSessions(convId: number, msgId: number): Promise<number[]> {
  try {
    const rows = await db
      .select({ id: messengerChats.id })
      .from(messengerChats)
      .where(and(eq(messengerChats.replyConvId, convId), gt(messengerChats.replyUntil, new Date()), eq(messengerChats.blocked, false), eq(messengerChats.muted, false)));
    for (const r of rows) {
      await enqueueJob("messenger.chatalert", { chatRowId: r.id, convId, upTo: msgId, since: msgId - 1, phase: "relay" }, { dedupeKey: `mca:relay:${msgId}:${r.id}` });
    }
    return rows.map((r) => r.id);
  } catch (e) {
    console.error("[chat:relay]", e instanceof Error ? e.message : e);
    return [];
  }
}
