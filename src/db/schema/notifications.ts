import { type AnyPgColumn, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contracts } from "./contracts";
import { users } from "./identity";

/** صندوق ارتباطات: ایمیل و پیامک */
export const notifications = pgTable("notifications", {
  workspaceId: integer("workspace_id").notNull().default(0),
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(), // email | sms
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("logged"), // sent | logged | failed
  error: text("error"),
  contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
/* ═════════════ مرکز اعلان درون‌برنامه‌ای ═════════════ */

/** اعلان‌های درون‌برنامه‌ای کاربر (زنگوله). جدا از «صندوق ارتباطات» که لاگ ایمیل/پیامک است. */
export const userNotifications = pgTable(
  "user_notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind").notNull().default("info"), // info | action | success | warning | security
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    href: text("href"),
    /** کلید یکتا برای جلوگیری از اعلان تکراری (اختیاری) */
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("user_notifications_user_idx").on(t.userId, t.createdAt), uniqueIndex("user_notifications_dedupe_uq").on(t.userId, t.dedupeKey)],
);
