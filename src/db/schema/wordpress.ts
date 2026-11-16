import { type AnyPgColumn, boolean, index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { apiKeys } from "./developer";
import { contracts } from "./contracts";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/* ═════════════ اتصال خودکار افزونه‌ی وردپرس (Zero-Config) ═════════════ */

/** هر نصب وردپرس = یک اتصال؛ کلید API آن به‌صورت خودکار ساخته و فقط روی سرور وردپرس نگه‌داری می‌شود */
export const wpConnections = pgTable(
  "wp_connections",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    /** شناسه‌ی تصادفی نصب (در وردپرس تولید می‌شود) */
    installId: text("install_id").notNull().unique(),
    siteUrl: text("site_url").notNull(),
    siteHost: text("site_host").notNull(),
    siteName: text("site_name").notNull().default(""),
    /** مالکیت دامنه با چالش HTTP یا کد جفت‌سازی تایید شده است */
    verified: boolean("verified").notNull().default(false),
    apiKeyId: integer("api_key_id").references((): AnyPgColumn => apiKeys.id, { onDelete: "set null" }),
    ownerUserId: integer("owner_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    pluginVersion: text("plugin_version").notNull().default(""),
    wpVersion: text("wp_version").notNull().default(""),
    wcActive: boolean("wc_active").notNull().default(false),
    locale: text("locale").notNull().default(""),
    status: text("status").notNull().default("active"), // active | disconnected
    lastSeenAt: timestamp("last_seen_at"),
    /** راز مشترک امضای HMAC رویدادهای همگام‌سازی (رمزنگاری‌شده با enc:v1) */
    syncSecret: text("sync_secret").notNull().default(""),
    /** زمان آخرین ساخت/چرخش راز؛ افزونه با دیدن مقدار جدیدتر راز را دوباره می‌گیرد */
    syncSecretAt: timestamp("sync_secret_at"),
    /** همگام‌سازی دوطرفه برای این سایت فعال است؟ */
    syncEnabled: boolean("sync_enabled").notNull().default(true),
    /** قابلیت‌های اعلام‌شده‌ی افزونه (جداشده با ویرگول): push,pull,orders,customers … */
    capabilities: text("capabilities").notNull().default(""),
    lastSyncInAt: timestamp("last_sync_in_at"),
    lastSyncOutAt: timestamp("last_sync_out_at"),
    lastPullAt: timestamp("last_pull_at"),
    /** آخرین خطای ارسال مستقیم (Push) به سایت؛ خالی = سالم */
    lastPushError: text("last_push_error").notNull().default(""),
    /** JSON: میزان ادغام افزونه با کسب‌وکار (دروازه‌ها، نقش‌ها، اتوماسیون …) که افزونه گزارش می‌دهد → «عمق یکپارچگی» */
    integrationJson: text("integration_json").notNull().default("{}"),
    integrationAt: timestamp("integration_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("wp_conn_workspace_idx").on(t.workspaceId), index("wp_conn_host_idx").on(t.siteHost)],
);
/** سفارش‌های ووکامرس همگام‌شده (آینه‌ی فقط‌خواندنی؛ منبع حقیقت خود ووکامرس است) */
export const wcOrders = pgTable(
  "wc_orders",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    connectionId: integer("connection_id").references((): AnyPgColumn => wpConnections.id, { onDelete: "cascade" }).notNull(),
    wcOrderId: integer("wc_order_id").notNull(),
    number: text("number").notNull().default(""),
    status: text("status").notNull().default(""), // pending | processing | on-hold | completed | cancelled | refunded | failed | trash …
    currency: text("currency").notNull().default(""),
    total: numeric("total", { precision: 18, scale: 2 }).notNull().default("0"),
    refunded: numeric("refunded", { precision: 18, scale: 2 }).notNull().default("0"),
    customerEmail: text("customer_email").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    customerPhone: text("customer_phone").notNull().default(""),
    wcCustomerId: integer("wc_customer_id").notNull().default(0),
    paymentMethod: text("payment_method").notNull().default(""),
    /** JSON: [{ productId, name, qty, total, templateId }] */
    itemsJson: text("items_json").notNull().default("[]"),
    wcCreatedAt: timestamp("wc_created_at"),
    wcUpdatedAt: timestamp("wc_updated_at"),
    syncedAt: timestamp("synced_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wc_orders_conn_order_uq").on(t.connectionId, t.wcOrderId), index("wc_orders_ws_idx").on(t.workspaceId, t.wcCreatedAt), index("wc_orders_email_idx").on(t.workspaceId, t.customerEmail)],
);
/** پیوند قرارداد ↔ سفارش/محصول ووکامرس (و کلید ایدمپوتنت صدور) */
export const wcContractLinks = pgTable(
  "wc_contract_links",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    connectionId: integer("connection_id").references((): AnyPgColumn => wpConnections.id, { onDelete: "cascade" }).notNull(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    wcOrderId: integer("wc_order_id").notNull().default(0),
    wcProductId: integer("wc_product_id").notNull().default(0),
    /** کلید یکتا برای جلوگیری از صدور تکراری در تلاش‌های مجدد (مثل wc:123:45) */
    externalKey: text("external_key").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wc_links_key_uq").on(t.connectionId, t.externalKey), uniqueIndex("wc_links_contract_uq").on(t.contractId), index("wc_links_order_idx").on(t.connectionId, t.wcOrderId)],
);
/** صف خروجی ابر → وردپرس (Push با HMAC و در صورت ناممکن بودن، Pull توسط افزونه) */
export const wpOutbox = pgTable(
  "wp_outbox",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    connectionId: integer("connection_id").references((): AnyPgColumn => wpConnections.id, { onDelete: "cascade" }).notNull(),
    eventId: text("event_id").notNull().unique(),
    event: text("event").notNull(),
    payload: text("payload").notNull().default("{}"),
    status: text("status").notNull().default("pending"), // pending | delivered | dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at"),
    deliveredVia: text("delivered_via"), // push | pull
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("wp_outbox_due_idx").on(t.connectionId, t.status, t.nextAttemptAt), index("wp_outbox_ws_idx").on(t.workspaceId, t.createdAt)],
);
/** رویدادهای ورودی وردپرس → ابر؛ کلید یکتای (اتصال، شناسه‌ی رویداد) ضامن ایدمپوتنت بودن است */
export const wpInbound = pgTable(
  "wp_inbound",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    connectionId: integer("connection_id").references((): AnyPgColumn => wpConnections.id, { onDelete: "cascade" }).notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("ok"), // ok | ignored | error
    detail: text("detail"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wp_inbound_uq").on(t.connectionId, t.eventId), index("wp_inbound_ws_idx").on(t.workspaceId, t.createdAt)],
);
/** توکن‌های یک‌بارمصرف اتصال: handshake | pairing | sso — فقط هش ذخیره می‌شود */
export const connectTokens = pgTable(
  "connect_tokens",
  {
    id: serial("id").primaryKey(),
    purpose: text("purpose").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    workspaceId: integer("workspace_id").notNull().default(0),
    userId: integer("user_id").notNull().default(0),
    /** داده‌ی JSON وابسته به نوع توکن */
    data: text("data").notNull().default("{}"),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("connect_tokens_purpose_idx").on(t.purpose, t.expiresAt)],
);
