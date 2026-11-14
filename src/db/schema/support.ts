import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/* ═════════════ سیستم تیکت پشتیبانی ═════════════ */

/**
 * تیکت پشتیبانی. مشتری = هر کاربر واردشده؛ پاسخ‌دهنده = مدیر کل پلتفرم.
 * status: open (باز) | in_progress (در حال بررسی) | closed (بسته)
 */
export const tickets = pgTable(
  "tickets",
  {
    id: serial("id").primaryKey(),
    number: text("number").notNull().unique(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    /** فضای کاری فعال کاربر هنگام ثبت تیکت (برای زمینه‌ی پشتیبانی؛ ۰ یعنی بدون فضای کاری) */
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
    subject: text("subject").notNull(),
    category: text("category").notNull().default("general"), // general | technical | billing | ai | wordpress | feature
    priority: text("priority").notNull().default("normal"), // low | normal | high | urgent
    status: text("status").notNull().default("open"),
    /** آخرین پاسخ‌دهنده: customer | staff */
    lastReplyBy: text("last_reply_by").notNull().default("customer"),
    rating: integer("rating"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
  },
  (t) => [index("tickets_user_idx").on(t.userId), index("tickets_status_idx").on(t.status, t.updatedAt)],
);
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id").references((): AnyPgColumn => tickets.id, { onDelete: "cascade" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    isStaff: boolean("is_staff").notNull().default(false),
    /** یادداشت داخلی: فقط برای پشتیبان‌ها قابل مشاهده است */
    internal: boolean("internal").notNull().default(false),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.ticketId)],
);
