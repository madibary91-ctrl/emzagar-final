import { asc, eq } from "drizzle-orm";
import { chatConversations } from "@/db/schema";
import { db } from "@/db";
import { listMessages } from "./conversations";

/* ═════════════ حریم خصوصی ═════════════ */

/** خروجی داده‌های گفتگوی یک کاربر (برای «دریافت داده‌های من») */
export async function exportUserChats(userId: number) {
  const convs = await db.select().from(chatConversations).where(eq(chatConversations.userId, userId)).orderBy(asc(chatConversations.id));
  const out = [];
  for (const c of convs) {
    const msgs = await listMessages(c.id, { staff: false });
    out.push({ code: c.code, queue: c.queue, status: c.status, startedAt: c.createdAt, messages: msgs.map((m) => ({ from: m.kind, body: m.body, at: m.at })) });
  }
  return out;
}
/** حذف حساب: گفتگوهای کاربر (و پیام‌های آن با CASCADE) پاک می‌شود */
export async function deleteUserChats(userId: number): Promise<void> {
  await db.delete(chatConversations).where(eq(chatConversations.userId, userId));
}
