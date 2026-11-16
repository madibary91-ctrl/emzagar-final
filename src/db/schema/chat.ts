import { type AnyPgColumn, boolean, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/* ═════════════ گفتگوی زنده‌ی پشتیبانی (Live Chat) ═════════════ */

/**
 * یک گفتگوی زنده بین «مشتری» و «تیم پاسخ‌گو».
 *  - queue: platform (پشتیبانی پلتفرم) | workspace (تیم صادرکننده‌ی قرارداد)
 *  - contextKind: panel (کاربر واردشده) | sign (امضاکننده‌ی مهمان) | pay (پرداخت‌کننده‌ی مهمان) | site (بازدیدکننده)
 *  - مشتری مهمان فقط با «کوکی بازدیدکننده» (هش آن در visitor_hash) به گفتگوی خودش دسترسی دارد.
 *  - شمارنده‌های unread_* و شناسه‌های read_id برای «خوانده‌نشده» و «دیده‌شد» نگه‌داری می‌شوند.
 */
export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: serial("id").primaryKey(),
    /** شناسه‌ی عمومی غیرقابل‌حدس (در آدرس‌ها و رابط) */
    code: text("code").notNull().unique(),
    queue: text("queue").notNull().default("platform"),
    workspaceId: integer("workspace_id").notNull().default(0),
    contextKind: text("context_kind").notNull().default("panel"),
    /** کلید یکتای زمینه برای پیدا کردن گفتگوی جاری مشتری: kind:contractId:signerId:queue */
    contextKey: text("context_key").notNull().default(""),
    userId: integer("user_id"),
    visitorHash: text("visitor_hash"),
    requesterName: text("requester_name").notNull().default(""),
    requesterMobile: text("requester_mobile").notNull().default(""),
    contractId: integer("contract_id"),
    signerId: integer("signer_id"),
    pagePath: text("page_path").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    status: text("status").notNull().default("open"), // open | closed
    assigneeId: integer("assignee_id"),
    rating: integer("rating"),
    ticketId: integer("ticket_id"),
    lastMessageAt: timestamp("last_message_at").notNull().defaultNow(),
    lastMessageBy: text("last_message_by").notNull().default("system"), // requester | staff | system
    lastPreview: text("last_preview").notNull().default(""),
    unreadStaff: integer("unread_staff").notNull().default(0),
    unreadRequester: integer("unread_requester").notNull().default(0),
    /** آخرین پیام پشتیبان که مشتری دیده / آخرین پیام مشتری که پشتیبان دیده (شناسه‌ی پیام) */
    requesterReadId: integer("requester_read_id").notNull().default(0),
    staffReadId: integer("staff_read_id").notNull().default(0),
    requesterTypingAt: timestamp("requester_typing_at"),
    staffTypingAt: timestamp("staff_typing_at"),
    requesterSeenAt: timestamp("requester_seen_at"),
    /** موتور اعلان پیام‌رسان: آخرین زمان اعلان و آخرین پیام مشتری که درباره‌اش اعلان رفته (جلوگیری از بارش اعلان و گم‌شدن پیام) */
    alertedAt: timestamp("alerted_at"),
    alertedMsgId: integer("alerted_msg_id").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
  },
  (t) => [
    index("chat_conv_queue_idx").on(t.queue, t.workspaceId, t.status, t.lastMessageAt),
    index("chat_conv_user_idx").on(t.userId, t.contextKey),
    index("chat_conv_visitor_idx").on(t.visitorHash, t.contextKey),
  ],
);
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id").references((): AnyPgColumn => chatConversations.id, { onDelete: "cascade" }).notNull(),
    senderKind: text("sender_kind").notNull(), // requester | staff | system
    senderUserId: integer("sender_user_id"),
    senderName: text("sender_name").notNull().default(""),
    body: text("body").notNull(),
    /** یادداشت داخلی: فقط برای پشتیبان‌ها */
    internal: boolean("internal").notNull().default(false),
    /** شناسه‌ی تولیدشده در مرورگر: ارسال تکراری (قطع شبکه/بازتلاش) فقط یک پیام می‌سازد */
    clientId: text("client_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("chat_messages_conv_idx").on(t.conversationId, t.id), uniqueIndex("chat_messages_client_uq").on(t.conversationId, t.clientId)],
);
/** حضور پشتیبان‌ها (آنلاین = دیده‌شده در ۷۰ ثانیه‌ی اخیر). scope: platform | ws:<workspaceId> */
export const chatAgents = pgTable(
  "chat_agents",
  {
    userId: integer("user_id").notNull(),
    scope: text("scope").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope] }), index("chat_agents_scope_idx").on(t.scope, t.lastSeenAt)],
);
