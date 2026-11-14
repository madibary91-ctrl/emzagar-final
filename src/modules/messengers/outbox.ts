import { enqueueJob } from "@/modules/jobs/queue";
import { chatTargetsForUser } from "./service";

/**
 * صف‌کردن پیام‌های خروجی پیام‌رسان (الگوی Outbox: داخل تراکنش جاری درج و پس از commit ارسال می‌شود).
 * هیچ‌کدام خطا پرتاب نمی‌کنند: خطای پیام‌رسان هرگز نباید امضا/صدور قرارداد را بشکند.
 * متن و لینک در payload صف ذخیره نمی‌شود؛ فقط شناسه‌ها، و متن هنگام ارسال ساخته می‌شود (لینک امضا در جدول jobs ماندگار نشود).
 */

/** اعلان درون‌برنامه‌ای ← همه‌ی پیام‌رسان‌های متصل کاربر (به‌جز چت‌های بی‌صدا) */
export async function queueNotice(userId: number, notificationId: number): Promise<number> {
  try {
    const targets = await chatTargetsForUser(userId);
    let n = 0;
    for (const t of targets) {
      if (t.chat.muted) continue;
      await enqueueJob("messenger.notice", { chatRowId: t.chat.id, notificationId }, { dedupeKey: `mn:${notificationId}:${t.chat.id}` });
      n++;
    }
    return n;
  } catch (e) {
    console.error("[messenger:queueNotice]", e instanceof Error ? e.message : e);
    return 0;
  }
}

export type SignLinkKind = "issue" | "turn" | "reminder";

/** لینک امضا ← پیام‌رسان‌های امضاکننده؛ تعداد چت‌های صف‌شده را برمی‌گرداند */
export async function queueSignLink(p: { contractId: number; signerId: number; userId: number; workspaceId: number; kind: SignLinkKind }): Promise<number> {
  try {
    const targets = await chatTargetsForUser(p.userId, { workspaceId: p.workspaceId });
    const hour = Math.floor(Date.now() / 3_600_000);
    for (const t of targets) {
      await enqueueJob("messenger.signlink", { chatRowId: t.chat.id, signerId: p.signerId, contractId: p.contractId, kind: p.kind }, { dedupeKey: `ms:${p.kind}:${p.signerId}:${t.chat.id}:${hour}` });
    }
    return targets.length;
  } catch (e) {
    console.error("[messenger:queueSignLink]", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** نسخه‌ی نهایی PDF ← چت‌های طرفین قرارداد (فقط رباتی که «ارسال PDF» در آن روشن است) */
export async function queueFinalCopies(contractId: number, userIds: number[]): Promise<number> {
  let n = 0;
  try {
    for (const userId of [...new Set(userIds)]) {
      for (const t of await chatTargetsForUser(userId)) {
        if (!t.bot.sendPdf) continue;
        await enqueueJob("messenger.finalcopy", { chatRowId: t.chat.id, contractId }, { dedupeKey: `mf:${contractId}:${t.chat.id}` });
        n++;
      }
    }
  } catch (e) {
    console.error("[messenger:queueFinalCopies]", e instanceof Error ? e.message : e);
  }
  return n;
}
