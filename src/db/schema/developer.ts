import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { contracts } from "./contracts";
import { users } from "./identity";
import { workspaces } from "./tenancy";
import { sealedText } from "../sealed-text";

/** مقصدهای وب‌هوک: تلگرام، بله، روبیکا و وب‌هوک عمومی */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(), // telegram | bale | rubika | generic
  /** شناسه‌ی چت / کانال (یا آدرس URL برای وب‌هوک عمومی) */
  target: text("target").notNull(),
  /** توکن ربات یا کلید امضای HMAC — هرگز به کلاینت ارسال نمی‌شود */
  /** D-01: رمزنگاری‌شده در حالت سکون (enc:v1) — توکن ربات/کلید HMAC فقط داخل سرور باز می‌شود */
  secret: sealedText("secret").notNull().default(""),
  baseUrl: text("base_url").notNull().default(""),
  events: text("events").notNull().default("*"), // لیست جداشده با ویرگول یا *
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    endpointId: integer("endpoint_id").references((): AnyPgColumn => webhookEndpoints.id, { onDelete: "cascade" }).notNull(),
    event: text("event").notNull(),
    /** ok | failed (آخرین تلاش ناموفق؛ اگر next_retry_at دارد در صف تلاش مجدد است) | dead (تلاش‌ها تمام شد یا خطای دائمی) */
    status: text("status").notNull(), // ok | failed | dead
    error: text("error"),
    /** تعداد تلاش‌های انجام‌شده */
    attempts: integer("attempts").notNull().default(1),
    /** زمان تلاش بعدی (فقط وقتی در صف تلاش مجدد است) */
    nextRetryAt: timestamp("next_retry_at"),
    /** بدنه‌ی رویداد (JSON) برای تلاش مجدد؛ فقط برای ارسال‌های ناموفق نگه داشته می‌شود و پس از موفقیت پاک می‌شود */
    payload: text("payload"),
    lastAttemptAt: timestamp("last_attempt_at"),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_endpoint_idx").on(t.endpointId),
    index("webhook_deliveries_retry_idx").on(t.status, t.nextRetryAt),
    // P-1x: فهرست تحویل‌های هر مقصد (جدیدترین‌ها) و پاک‌سازی دوره‌ای بر مبنای زمان بدون اسکن کامل
    index("webhook_deliveries_endpoint_created_idx").on(t.endpointId, t.createdAt),
    index("webhook_deliveries_created_idx").on(t.createdAt),
  ],
);
/** کلیدهای API برای اتصال سیستم‌های بیرونی (فقط هش ذخیره می‌شود) */
export const apiKeys = pgTable("api_keys", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  active: boolean("active").notNull().default(true),
  /**
   * M-05 — دامنه‌ی دسترسی (Scope): فهرست جداشده با ویرگول از `modules/api/scopes.ts`.
   * پیش‌فرض ستون = مجموعه‌ی کامل قدیمی (کلیدهای پیش از این ارتقا بدون وقفه کار کنند)؛ کلیدهای جدید همیشه صریح و حداقلی ساخته می‌شوند.
   */
  scopes: text("scopes").notNull().default("contracts:read,contracts:write,templates:read,stats:read,hub,sync,connect"),
  /** M-05 — انقضای کلید (null = بدون انقضا؛ فقط برای کلیدهای قدیمی). کلیدهای جدید حداکثر ۳۶۶ روز اعتبار دارند. */
  expiresAt: timestamp("expires_at"),
  /** M-05 — فهرست مجاز IP/CIDR (جداشده با ویرگول)؛ خالی = بدون محدودیت IP */
  allowedIps: text("allowed_ips").notNull().default(""),
  lastUsedAt: timestamp("last_used_at"),
  lastUsedIp: text("last_used_ip").notNull().default(""),
  createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
