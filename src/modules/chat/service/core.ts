import { type ChatMsg, type ChatQueue, QUEUE_LABELS } from "../meta";
import { chatConversations, chatMessages, users } from "@/db/schema";
import crypto from "node:crypto";
import { db } from "@/db";
import { eq, or, sql } from "drizzle-orm";
import { notifyUsers, teamUserIds } from "@/modules/inbox/service";

export type Conv = typeof chatConversations.$inferSelect;
type MsgRow = typeof chatMessages.$inferSelect;
export class ChatError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ChatError";
  }
}
/** مشتری: کاربر واردشده (panel) یا بازدیدکننده‌ی مهمان با کوکی (هش آن) */
export type Requester = { kind: "user"; userId: number; name: string; mobile: string } | { kind: "visitor"; hash: string };
export const SEEN_FRESH_MS = 45_000;
export const newCode = () => crypto.randomBytes(12).toString("base64url");
export const preview = (s: string) => s.replace(/\s+/g, " ").slice(0, 140);
export function toMsg(r: MsgRow): ChatMsg {
  return { id: r.id, kind: r.senderKind as ChatMsg["kind"], name: r.senderName, body: r.body, at: r.createdAt.toISOString(), internal: r.internal, cid: r.clientId };
}
/* ═════════════ پیدا کردن و ساختن گفتگو ═════════════ */

export function actorWhere(who: Requester) {
  return who.kind === "user" ? eq(chatConversations.userId, who.userId) : eq(chatConversations.visitorHash, who.hash);
}
/* ═════════════ اعلان‌ها ═════════════ */

/** مدیران کل پلتفرم (نقش admin + فهرست محیطی) */
export async function platformAdminIds(): Promise<number[]> {
  const env = (process.env.PLATFORM_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const rows = await db.select({ id: users.id, role: users.role, email: users.email }).from(users).where(or(eq(users.role, "admin"), env.length ? sql`lower(${users.email}) in (${sql.join(env.map((e) => sql`${e}`), sql`, `)})` : undefined));
  return rows.map((r) => r.id);
}
/**
 * اگر هیچ پشتیبانی آنلاین نباشد، تیم پاسخ‌گو از راه زنگوله خبردار می‌شود.
 * اعلان پیام‌رسان (بله/تلگرام/ایتا) را موتور اعلان گفتگو می‌فرستد (`alerts.ts`)، نه این تابع (skipMessenger).
 */
export async function notifyStaff(conv: Conv, msg: ChatMsg, online: boolean, created: boolean) {
  if (online) return; // پشتیبان همین حالا کنسول را باز دارد و زنده می‌بیند
  const queue = conv.queue as ChatQueue;
  const ids = queue === "platform" ? await platformAdminIds() : await teamUserIds(conv.workspaceId, ["owner", "admin", "member"]);
  const base = queue === "platform" ? "/platform/chat" : "/admin/chat";
  const bucket = Math.floor(Date.now() / (10 * 60_000));
  await notifyUsers(ids, {
    kind: "action",
    title: created ? `گفتگوی جدید از ${conv.requesterName || "مشتری"}` : `پیام تازه از ${conv.requesterName || "مشتری"}`,
    body: preview(msg.body).slice(0, 120),
    href: `${base}?c=${conv.code}`,
    dedupeKey: `chat:${conv.id}:${bucket}`,
    skipMessenger: true,
  });
}
export async function notifyRequester(conv: Conv, msg: ChatMsg) {
  if (!conv.userId) return;
  const fresh = conv.requesterSeenAt && Date.now() - conv.requesterSeenAt.getTime() < SEEN_FRESH_MS;
  if (fresh) return;
  const path = safeInternalPath(conv.pagePath);
  const bucket = Math.floor(Date.now() / (15 * 60_000));
  await notifyUsers([conv.userId], {
    kind: "info",
    title: `پاسخ جدید از ${QUEUE_LABELS[conv.queue as ChatQueue]}`,
    body: preview(msg.body).slice(0, 120),
    href: `${path}${path.includes("?") ? "&" : "?"}chat=open`,
    dedupeKey: `chatr:${conv.id}:${bucket}`,
  });
}

/** مسیر امن داخل سایت برای پیوند اعلان (جلوگیری از open-redirect) */
export function safeInternalPath(p: string | null | undefined): string {
  const s = String(p || "");
  return /^\/[A-Za-z0-9\-._~/%]*$/.test(s) && !s.startsWith("//") ? s.slice(0, 200) : "/dashboard";
}
