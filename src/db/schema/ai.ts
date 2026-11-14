import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/** گزارش مصرف دستیار هوش مصنوعی (برای سهمیه‌ی روزانه و پایش هزینه) */
export const aiGenerations = pgTable(
  "ai_generations",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    kind: text("kind").notNull().default("contract"), // contract | improve
    prompt: text("prompt").notNull().default(""),
    model: text("model").notNull().default(""),
    status: text("status").notNull().default("ok"), // ok | failed
    error: text("error"),
    tokens: integer("tokens").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_gen_ws_idx").on(t.workspaceId, t.createdAt)],
);
/* ═════════════ حافظه‌ی حقوقی: شخصی‌سازی هوش مصنوعی با اسناد خود کاربر ═════════════ */

/**
 * سند دانشی یک فضای کاری (قرارداد نمونه، قوانین شرکت، راهنمای لحن، کتابخانه‌ی بندها).
 * فقط «متن پاک‌سازی‌شده» نگه داشته می‌شود (فایل اصلی ذخیره نمی‌شود)؛ اطلاعات هویتی/مالی پیش از ذخیره حذف می‌شوند.
 */
export const aiKnowledgeDocs = pgTable(
  "ai_knowledge_docs",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    title: text("title").notNull(),
    /** sample = قرارداد نمونه | policy = قوانین و خط‌قرمزهای شرکت | style = راهنمای لحن | clauses = کتابخانه‌ی بندها */
    kind: text("kind").notNull().default("sample"),
    /** upload | paste | contract | template */
    source: text("source").notNull().default("upload"),
    sourceRef: integer("source_ref"),
    fileName: text("file_name").notNull().default(""),
    content: text("content").notNull(),
    charCount: integer("char_count").notNull().default(0),
    /** تعداد اطلاعات هویتی/مالی که هنگام ذخیره حذف شد */
    redactions: integer("redactions").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_kdocs_ws_idx").on(t.workspaceId, t.createdAt)],
);
/** تنظیمات شخصی‌سازی هر فضای کاری: روشن/خاموش، دستورالعمل دستی و پروفایل سبک یادگرفته‌شده */
export const aiPersonalization = pgTable("ai_personalization", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  /** دستورالعمل دائمی نوشته‌ی کاربر (مثلاً «همیشه طرف اول را کارفرما بنامید») */
  instructions: text("instructions").notNull().default(""),
  /** خلاصه‌ی سبک و قواعد که هوش مصنوعی از اسناد استخراج کرده است */
  styleProfile: text("style_profile").notNull().default(""),
  profileDocCount: integer("profile_doc_count").notNull().default(0),
  profileUpdatedAt: timestamp("profile_updated_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
