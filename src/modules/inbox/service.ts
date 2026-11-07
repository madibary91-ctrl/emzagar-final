import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { userNotifications, workspaceMembers } from "@/db/schema";

/**
 * مرکز اعلان درون‌برنامه‌ای (زنگوله). هیچ‌یک از توابع ثبت اعلان خطا پرتاب نمی‌کنند:
 * خطا در اعلان هرگز نباید جریان اصلی (امضا، صدور …) را بشکند.
 */
export type NoticeKind = "info" | "action" | "success" | "warning" | "security";
export interface Notice {
  kind?: NoticeKind;
  title: string;
  body?: string;
  href?: string | null;
  /** اعلان تکراری با همین کلید (برای همین کاربر) ثبت نمی‌شود */
  dedupeKey?: string;
}

export async function notifyUser(userId: number | null | undefined, n: Notice): Promise<boolean> {
  if (!userId) return false;
  try {
    const rows = await db
      .insert(userNotifications)
      .values({ userId, kind: n.kind ?? "info", title: n.title.slice(0, 160), body: (n.body ?? "").slice(0, 500), href: n.href ?? null, dedupeKey: n.dedupeKey ?? null })
      .onConflictDoNothing()
      .returning({ id: userNotifications.id });
    return rows.length > 0;
  } catch (e) {
    console.error("[inbox:notify]", e);
    return false;
  }
}

export async function notifyUsers(userIds: (number | null | undefined)[], n: Notice): Promise<number> {
  const unique = [...new Set(userIds.filter((x): x is number => !!x))];
  let count = 0;
  for (const id of unique) if (await notifyUser(id, n)) count++;
  return count;
}

/** اعضای تیم یک فضای کاری (مالک، مدیر، عضو) */
export async function teamUserIds(workspaceId: number, roles: string[] = ["owner", "admin", "member"]): Promise<number[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.role, roles)));
  return rows.map((r) => r.userId);
}

export async function notifyTeam(workspaceId: number, n: Notice, extraUserIds: (number | null | undefined)[] = [], roles?: string[]): Promise<number> {
  try {
    return await notifyUsers([...(await teamUserIds(workspaceId, roles)), ...extraUserIds], n);
  } catch (e) {
    console.error("[inbox:team]", e);
    return 0;
  }
}

export type InboxItem = typeof userNotifications.$inferSelect;

export async function listNotifications(userId: number, opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<InboxItem[]> {
  return db
    .select()
    .from(userNotifications)
    .where(and(eq(userNotifications.userId, userId), opts.unreadOnly ? isNull(userNotifications.readAt) : undefined))
    .orderBy(desc(userNotifications.createdAt), desc(userNotifications.id))
    .limit(Math.max(1, Math.min(200, opts.limit ?? 30)));
}

export async function unreadCount(userId: number): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userNotifications)
    .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt)));
  return r?.n ?? 0;
}

/** ids خالی = همه */
export async function markRead(userId: number, ids?: number[]): Promise<number> {
  const rows = await db
    .update(userNotifications)
    .set({ readAt: new Date() })
    .where(and(eq(userNotifications.userId, userId), isNull(userNotifications.readAt), ids && ids.length ? inArray(userNotifications.id, ids) : undefined))
    .returning({ id: userNotifications.id });
  return rows.length;
}

export async function deleteNotification(userId: number, id: number): Promise<boolean> {
  const rows = await db.delete(userNotifications).where(and(eq(userNotifications.userId, userId), eq(userNotifications.id, id))).returning({ id: userNotifications.id });
  return rows.length > 0;
}

/** پاک‌سازی اعلان‌های خوانده‌شده‌ی قدیمی‌تر از ۹۰ روز و همه‌ی اعلان‌های قدیمی‌تر از ۳۶۵ روز */
export async function purgeOldNotifications(): Promise<number> {
  const d90 = new Date(Date.now() - 90 * 86400000);
  const d365 = new Date(Date.now() - 365 * 86400000);
  const a = await db.delete(userNotifications).where(and(lt(userNotifications.createdAt, d90), sql`${userNotifications.readAt} is not null`)).returning({ id: userNotifications.id });
  const b = await db.delete(userNotifications).where(lt(userNotifications.createdAt, d365)).returning({ id: userNotifications.id });
  return a.length + b.length;
}
