import { type AnyPgColumn, boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** «سرور لایسنس» (فقط روی سرور فروشنده فعال است): کلیدهای صادرشده برای خریداران */
export const licenseKeys = pgTable("license_keys", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  customerName: text("customer_name").notNull().default(""),
  customerEmail: text("customer_email").notNull().default(""),
  plan: text("plan").notNull().default("standard"), // standard | extended | enterprise
  maxDomains: integer("max_domains").notNull().default(1),
  status: text("status").notNull().default("active"), // active | suspended | revoked
  notes: text("notes").notNull().default(""),
  expiresAt: timestamp("expires_at"),
  /** پشتیبانی/به‌روزرسانی تا این تاریخ (null = نامحدود) */
  updatesUntil: timestamp("updates_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastCheckAt: timestamp("last_check_at"),
});
/** دامنه‌هایی که هر لایسنس روی آن‌ها فعال شده است */
export const licenseActivations = pgTable(
  "license_activations",
  {
    id: serial("id").primaryKey(),
    licenseId: integer("license_id").references((): AnyPgColumn => licenseKeys.id, { onDelete: "cascade" }).notNull(),
    domain: text("domain").notNull(),
    instanceId: text("instance_id").notNull().default(""),
    version: text("version").notNull().default(""),
    ip: text("ip").notNull().default(""),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("license_act_uq").on(t.licenseId, t.domain)],
);
/** نسخه‌های منتشرشده‌ی محصول روی سرور فروشنده (برای به‌روزرسانی یک‌کلیکی خریداران) */
export const appReleases = pgTable("app_releases", {
  id: serial("id").primaryKey(),
  version: text("version").notNull().unique(),
  channel: text("channel").notNull().default("stable"), // stable | beta
  changelog: text("changelog").notNull().default(""),
  fileName: text("file_name"),
  sha256: text("sha256").notNull().default(""),
  size: integer("size").notNull().default(0),
  security: boolean("security").notNull().default(false),
  yanked: boolean("yanked").notNull().default(false),
  publishedAt: timestamp("published_at").notNull().defaultNow(),
});
