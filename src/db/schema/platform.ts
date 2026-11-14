import { type AnyPgColumn, boolean, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contracts } from "./contracts";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/** لاگ تغییرات و شناسنامه دیجیتال */
export const auditLogs = pgTable(
  "audit_logs",
  {
  workspaceId: integer("workspace_id").notNull().default(0),
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_contract_idx").on(t.contractId), index("audit_workspace_idx").on(t.workspaceId)],
);
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
});
/** لینک کوتاه اختصاصی قرارداد (با امکان رمزگذاری و انقضا) */
export const shortLinks = pgTable(
  "short_links",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    code: text("code").notNull().unique(),
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at"),
    clicks: integer("clicks").notNull().default(0),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until"),
    active: boolean("active").notNull().default(true),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastOpenedAt: timestamp("last_opened_at"),
  },
  (t) => [index("short_links_contract_idx").on(t.contractId)],
);
/** گزارش اجرای کارهای زمان‌بندی‌شده */
export const cronRuns = pgTable("cron_runs", {
  id: serial("id").primaryKey(),
  trigger: text("trigger").notNull(), // scheduler | http | manual
  reminders: integer("reminders").notNull().default(0),
  expired: integer("expired").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
/** نسخه‌های منتشرشده‌ی صفحه‌ی اصلی (تاریخچه و بازگشت به نسخه‌ی قبل) */
export const landingVersions = pgTable("landing_versions", {
  id: serial("id").primaryKey(),
  doc: text("doc").notNull(),
  note: text("note").notNull().default(""),
  createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
/* ═════════════ داده‌های نمونه، راهنمای پنل، لایسنس و به‌روزرسانی ═════════════ */

/**
 * ثبت‌کننده‌ی «داده‌ی نمونه»: هر رکوردی که سازنده‌ی داده‌ی نمایشی می‌سازد اینجا ثبت می‌شود
 * تا پاک‌سازی فقط و فقط همان رکوردها را حذف کند (هرگز داده‌ی واقعی لمس نمی‌شود).
 */
export const demoRecords = pgTable(
  "demo_records",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    entity: text("entity").notNull(), // user | contract | ticket | product | order | audit | notification
    entityId: integer("entity_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("demo_records_uq").on(t.entity, t.entityId), index("demo_records_ws_idx").on(t.workspaceId)],
);
/** ترجیحات هر کاربر (مثل وضعیت راهنمای تعاملی) */
export const userPrefs = pgTable(
  "user_prefs",
  {
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
    key: text("key").notNull(),
    value: text("value").notNull().default(""),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);
