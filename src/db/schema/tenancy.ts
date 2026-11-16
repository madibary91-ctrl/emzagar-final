import { type AnyPgColumn, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

/* ═════════════ چندمستاجری (Workspaces) ═════════════ */

/** فضای کاری = یک فروشگاه/کسب‌وکار؛ همه‌ی داده‌های تجاری به یک فضای کاری تعلق دارند */
export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: integer("owner_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
  /**
   * team  = فضای کاری عادی (تیم، پنل /admin، فهرست در تعویض فضا)
   * quick = فضای «ایزوله‌ی» سیستمی ارسال سریع: هیچ‌کس (حتی مدیر کل) پنل، فهرست، اعلان یا ایمیل مدیریتی از آن ندارد
   */
  kind: text("kind").notNull().default("team"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
/**
 * عضویت کاربر در فضای کاری.
 * role: owner | admin | member | viewer  ← اعضای تیم
 *       client                           ← مشتری/امضاکننده‌ی خارجی (به پنل مدیریت دسترسی ندارد)
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ws_members_unique").on(t.workspaceId, t.userId), index("ws_members_user_idx").on(t.userId)],
);
/** دعوت‌نامه‌ی عضو تیم (فقط هش توکن ذخیره می‌شود) */
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: integer("invited_by").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ws_invites_ws_idx").on(t.workspaceId)],
);
/** تنظیمات هر فضای کاری (برندینگ، SMTP، پیامک، یادآوری، …) */
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);
