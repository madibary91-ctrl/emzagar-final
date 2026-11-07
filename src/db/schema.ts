import { pgTable, serial, text, integer, bigint, timestamp, index, boolean, uniqueIndex, primaryKey, numeric, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** کاربران (مدیر / کاربر عادی) */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  mobile: text("mobile").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"), // admin | user
  /** زمان تأیید مالکیت ایمیل (null = تأییدنشده؛ ورود و ثبت‌نام تا تأیید ایمیل ممکن نیست) */
  emailVerifiedAt: timestamp("email_verified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
  // PERF-02: جستجوی نام/ایمیل مشتری در فهرست قراردادها
  (t) => [index("users_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")), index("users_email_trgm_idx").using("gin", t.email.op("gin_trgm_ops"))],
);

/** قالب‌های قرارداد */
export const templates = pgTable("templates", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** قراردادهای صادر شده */
export const contracts = pgTable(
  "contracts",
  {
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
    id: serial("id").primaryKey(),
    number: text("number").notNull().unique(),
    title: text("title").notNull(),
    templateId: integer("template_id").references((): AnyPgColumn => templates.id, { onDelete: "set null" }),
    customerId: integer("customer_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    bodyHtml: text("body_html").notNull(),
    status: text("status").notNull().default("sent"), // draft | sent | signed | rejected | expired | cancelled
    source: text("source").notNull().default("admin"), // admin | shop
    orderId: integer("order_id").references((): AnyPgColumn => orders.id, { onDelete: "set null" }),
    docHash: text("doc_hash"),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    signedAt: timestamp("signed_at"),
    /** زمان انتشار نسخه‌ی نهایی (برای پیش‌نویس‌ها null است) */
    publishedAt: timestamp("published_at"),
    /** مهلت امضا؛ پس از آن قرارداد منقضی می‌شود */
    expiresAt: timestamp("expires_at"),
    lastReminderAt: timestamp("last_reminder_at"),
    reminderCount: integer("reminder_count").notNull().default(0),
    /** مدت اعتبار قرارداد (روز، از لحظه‌ی امضای نهایی)؛ null = تعیین‌نشده */
    termDays: integer("term_days"),
    /** پایان مدت قرارداد (برای زمان‌بندی تمدید) */
    termEndsAt: timestamp("term_ends_at"),
    /** چند روز پیش از پایان مدت، یادآوری تمدید فرستاده شود */
    renewalNoticeDays: integer("renewal_notice_days").notNull().default(30),
    /** زمان ارسال یادآوری «به‌زودی تمام می‌شود» */
    renewalNotifiedAt: timestamp("renewal_notified_at"),
    /** زمان ارسال یادآوری «مدت تمام شد» */
    termEndedNotifiedAt: timestamp("term_ended_notified_at"),
    /** اگر این قرارداد تمدیدِ قرارداد دیگری است، شناسه‌ی قرارداد قبلی */
    renewedFromId: integer("renewed_from_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    /** ارزش مالی قرارداد (تومان)؛ برای گزارش و مرتب‌سازی. null = ثبت‌نشده */
    contractValue: integer("contract_value"),
    /** برچسب‌ها (جداشده با ویرگول) برای دسته‌بندی و بایگانی */
    tags: text("tags").notNull().default(""),
    /** زمان انتقال به بایگانی (فقط قراردادهای پایان‌یافته)؛ null = فعال */
    archivedAt: timestamp("archived_at"),
  },
  (t) => [index("contracts_customer_idx").on(t.customerId), index("contracts_status_idx").on(t.status), index("contracts_workspace_idx").on(t.workspaceId),
    // PERF-02: فهرست پیش‌فرض (ws + جدیدترین) و جستجوی زیررشته‌ای ILIKE '%q%' با ایندکس trigram (pg_trgm)
    index("contracts_ws_issued_idx").on(t.workspaceId, t.issuedAt.desc()),
    index("contracts_number_trgm_idx").using("gin", t.number.op("gin_trgm_ops")),
    index("contracts_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("contracts_tags_trgm_idx").using("gin", t.tags.op("gin_trgm_ops")),
  ],
);

/** امضاکنندگان به ترتیب امضا */
export const contractSigners = pgTable(
  "contract_signers",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    status: text("status").notNull().default("pending"), // pending | signed | rejected
    signedAt: timestamp("signed_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    signatureFile: text("signature_file"),
    signatureMethod: text("signature_method"), // draw | upload
    otpVerifiedAt: timestamp("otp_verified_at"),
    mobile: text("mobile"),
  },
  (t) => [index("signers_contract_idx").on(t.contractId), index("signers_user_idx").on(t.userId)],
);

/** کدهای یک‌بارمصرف */
/**
 * کدهای OTP امضا — عمداً بدون Foreign Key: جدول موقتِ چندده‌دقیقه‌ای (انقضا + پاکسازی زمان‌بند) است،
 * رویه‌ی ایجاد کد خودش هویت امضاکننده را پیش‌تر راستی‌آزمایی کرده و آزمون‌های موجود با شناسه‌ی مصنوعی کار می‌کنند.
 */
export const otpCodes = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  contractId: integer("contract_id").notNull(),
  signerId: integer("signer_id").notNull(),
  userId: integer("user_id").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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

/** محصولات / خدمات متصل به قرارداد (شبیه ووکامرس) */
export const products = pgTable("products", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  price: integer("price").notNull().default(0),
  templateId: integer("template_id").references((): AnyPgColumn => templates.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const orders = pgTable("orders", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "no action" }).notNull().default(0),
  id: serial("id").primaryKey(),
  userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
  productId: integer("product_id").references((): AnyPgColumn => products.id, { onDelete: "no action" }).notNull(),
  amount: integer("amount").notNull().default(0),
  status: text("status").notNull().default("awaiting_signature"), // awaiting_signature | completed
  contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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

/** مقصدهای وب‌هوک: تلگرام، بله، روبیکا و وب‌هوک عمومی */
export const webhookEndpoints = pgTable("webhook_endpoints", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(), // telegram | bale | rubika | generic
  /** شناسه‌ی چت / کانال (یا آدرس URL برای وب‌هوک عمومی) */
  target: text("target").notNull(),
  /** توکن ربات یا کلید امضای HMAC — هرگز به کلاینت ارسال نمی‌شود */
  secret: text("secret").notNull().default(""),
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
    status: text("status").notNull(), // ok | failed
    error: text("error"),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_endpoint_idx").on(t.endpointId)],
);

/** کلیدهای API برای اتصال سیستم‌های بیرونی (فقط هش ذخیره می‌شود) */
export const apiKeys = pgTable("api_keys", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  active: boolean("active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at"),
  createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** گزارش اجرای کارهای زمان‌بندی‌شده */
export const cronRuns = pgTable("cron_runs", {
  id: serial("id").primaryKey(),
  trigger: text("trigger").notNull(), // scheduler | http | manual
  reminders: integer("reminders").notNull().default(0),
  expired: integer("expired").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ═════════════ چندمستاجری (Workspaces) ═════════════ */

/** فضای کاری = یک فروشگاه/کسب‌وکار؛ همه‌ی داده‌های تجاری به یک فضای کاری تعلق دارند */
export const workspaces = pgTable("workspaces", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: integer("owner_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
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

/** توکن‌های یک‌بارمصرف تعیین/بازیابی رمز عبور (فقط هش ذخیره می‌شود) */
export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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

/* ═════════════ تحلیل ریسک قرارداد (هوش مصنوعی + موتور قواعد) ═════════════ */

export const contractAnalyses = pgTable(
  "contract_analyses",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    title: text("title").notNull().default(""),
    /** امتیاز ریسک: ۰ (کم‌ریسک) تا ۱۰۰ (بحرانی) */
    score: integer("score").notNull().default(0),
    level: text("level").notNull().default("low"), // low | medium | high | critical
    engine: text("engine").notNull().default("rules"), // rules | ai+rules
    model: text("model").notNull().default(""),
    /** نتیجه‌ی کامل (JSON): خلاصه، یافته‌ها، بندهای ناقص */
    result: text("result").notNull().default("{}"),
    textHash: text("text_hash").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("analyses_ws_idx").on(t.workspaceId, t.createdAt), index("analyses_contract_idx").on(t.contractId)],
);

/* ═════════════ اشتراک و پرداخت (درآمد پلتفرم) ═════════════ */

/** اشتراک هر فضای کاری؛ نبود ردیف یعنی طرح رایگان */
export const subscriptions = pgTable("subscriptions", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).primaryKey(),
  plan: text("plan").notNull().default("free"), // free | pro | business
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "no action" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    plan: text("plan").notNull(),
    months: integer("months").notNull().default(1),
    /** مبلغ به تومان (سمت سرور محاسبه می‌شود؛ هرگز از کلاینت خوانده نمی‌شود) */
    amount: integer("amount").notNull(),
    gateway: text("gateway").notNull().default("zarinpal"), // zarinpal | zibal | idpay | payir | sandbox | wallet
    /** نوع تراکنش: خرید اشتراک یا شارژ کیف پول */
    kind: text("kind").notNull().default("subscription"), // subscription | topup
    /** تراکنش آزمایشی/سندباکس (در درآمد پلتفرم حساب نمی‌شود) */
    test: boolean("test").notNull().default(false),
    authority: text("authority").notNull().unique(),
    refId: text("ref_id"),
    status: text("status").notNull().default("pending"), // pending | paid | failed
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    paidAt: timestamp("paid_at"),
    /**
     * لحظه‌ی «اعمال اثر پرداخت» (فعال‌سازی اشتراک / شارژ کیف پول). فقط داخل همان تراکنش دیتابیسی پر می‌شود که اثر را اعمال می‌کند،
     * پس «paid بدون اثر» فقط به‌شکل status='paid' و fulfilled_at IS NULL (داده‌ی قدیمی) ممکن است و زمان‌بند آن را ترمیم می‌کند.
     * این ستون ضامن اجرای دقیقاً یک‌بارِ اثر است (حتی با فراخوانی دوباره یا درخواست‌های موازی).
     */
    fulfilledAt: timestamp("fulfilled_at"),
  },
  (t) => [index("payments_ws_idx").on(t.workspaceId, t.createdAt)],
);

/** نسخه‌های منتشرشده‌ی صفحه‌ی اصلی (تاریخچه و بازگشت به نسخه‌ی قبل) */
export const landingVersions = pgTable("landing_versions", {
  id: serial("id").primaryKey(),
  doc: text("doc").notNull(),
  note: text("note").notNull().default(""),
  createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ═════════════ ورود دومرحله‌ای (TOTP) ═════════════ */

/**
 * تنظیمات ورود دومرحله‌ای هر کاربر (در جدول جدا تا هیچ‌گاه همراه رکورد کاربر سریالایز نشود).
 * enabledAt = null یعنی راه‌اندازی شروع شده ولی هنوز با یک کد معتبر تأیید نشده است.
 */
export const userTotp = pgTable("user_totp", {
  userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).primaryKey(),
  /** راز Base32 با AES‑256‑GCM رمزنگاری می‌شود */
  secret: text("secret").notNull(),
  enabledAt: timestamp("enabled_at"),
  /** آخرین بازه‌ی ۳۰ثانیه‌ای پذیرفته‌شده (جلوگیری از استفاده‌ی دوباره‌ی همان کد) */
  lastStep: integer("last_step").notNull().default(0),
  /** آرایه‌ی JSON از هش کدهای بازیابی مصرف‌نشده */
  recoveryHashes: text("recovery_hashes").notNull().default("[]"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ═════════════ تأیید ایمیل هنگام ثبت‌نام ═════════════ */

/** کد ۶ رقمی + لینک یک‌بارمصرف تأیید ایمیل (فقط هش هر دو ذخیره می‌شود) */
export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
    /** ایمیلی که این کد برای آن صادر شده (با تغییر ایمیل حساب، کدهای قدیمی بی‌اثر می‌شوند) */
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("email_verif_user_idx").on(t.userId, t.createdAt)],
);

/* ═════════════ امضای بدون ثبت‌نام (لینک امن اختصاصی هر امضاکننده) ═════════════ */

/**
 * لینک امضای اختصاصی یک امضاکننده. توکن ۲۵۶ بیتی تصادفی است؛ برای جستجو هش آن و برای ارسال مجدد
 * (یادآوری / کپی توسط مدیر) نسخه‌ی رمزنگاری‌شده‌اش ذخیره می‌شود. پس از امضا/رد/لغو، لینک بی‌اعتبار می‌شود.
 */
export const signingLinks = pgTable(
  "signing_links",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    signerId: integer("signer_id").references((): AnyPgColumn => contractSigners.id, { onDelete: "cascade" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenEnc: text("token_enc").notNull().default(""),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    usedAt: timestamp("used_at"),
    opens: integer("opens").notNull().default(0),
    lastOpenedAt: timestamp("last_opened_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("signing_links_signer_idx").on(t.signerId), index("signing_links_contract_idx").on(t.contractId)],
);

/* ═════════════ PDF نهایی ساخته‌شده روی سرور ═════════════ */

/** نسخه‌ی PDF قرارداد امضاشده در پوشه‌ی محافظت‌شده؛ sha256 فایل برای کشف دستکاری ذخیره می‌شود */
export const contractDocuments = pgTable(
  "contract_documents",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    file: text("file").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_documents_contract_uq").on(t.contractId)],
);

/* ═════════════ فیلدهای قابل‌پرکردن داخل قرارداد ═════════════ */

/**
 * مقدار فیلدهایی که امضاکننده هنگام امضا پر کرده است (تعریف فیلد از توکن‌های `{{field:...}}` متن قرارداد خوانده می‌شود).
 * مقدارها پس از ثبت تغییر نمی‌کنند و در اثر انگشت (SHA-256) سند لحاظ می‌شوند.
 */
export const contractFieldValues = pgTable(
  "contract_field_values",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    signerId: integer("signer_id").references((): AnyPgColumn => contractSigners.id, { onDelete: "cascade" }).notNull(),
    key: text("key").notNull(),
    label: text("label").notNull().default(""),
    type: text("type").notNull().default("text"),
    value: text("value").notNull().default(""),
    filledAt: timestamp("filled_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_field_values_uq").on(t.contractId, t.key)],
);

/* ═════════════ الحاقیه و نسخه‌بندی ═════════════ */

/** الحاقیه‌ی رسمی به قرارداد امضاشده؛ پس از تأیید (OTP) همه‌ی امضاکنندگان اصلی «نسخه‌ی» قرارداد بالا می‌رود */
export const contractAmendments = pgTable(
  "contract_amendments",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    /** شماره‌ی ترتیبی الحاقیه در همان قرارداد (۱، ۲، …) */
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull(),
    status: text("status").notNull().default("sent"), // sent | signed | rejected | cancelled
    docHash: text("doc_hash"),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    signedAt: timestamp("signed_at"),
  },
  (t) => [uniqueIndex("contract_amendments_seq_uq").on(t.contractId, t.seq)],
);

/** تأیید هر امضاکننده‌ی اصلی روی یک الحاقیه (لینک اختصاصی + OTP) */
export const amendmentSigners = pgTable(
  "amendment_signers",
  {
    id: serial("id").primaryKey(),
    amendmentId: integer("amendment_id").references((): AnyPgColumn => contractAmendments.id, { onDelete: "cascade" }).notNull(),
    signerId: integer("signer_id").references((): AnyPgColumn => contractSigners.id, { onDelete: "cascade" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"), // pending | accepted | rejected
    decidedAt: timestamp("decided_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("amendment_signers_amendment_idx").on(t.amendmentId), index("amendment_signers_user_idx").on(t.userId)],
);

/* ═════════════ پیوست فایل به قرارداد ═════════════ */

/** پیوست‌ها (کارت ملی، فاکتور …) در پوشه‌ی محافظت‌شده؛ نام فایل تصادفی و SHA-256 محتوا ثبت می‌شود */
export const contractAttachments = pgTable(
  "contract_attachments",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    uploadedBy: integer("uploaded_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    uploaderLabel: text("uploader_label").notNull().default(""),
    title: text("title").notNull().default(""),
    originalName: text("original_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull().default(0),
    sha256: text("sha256").notNull(),
    file: text("file").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("contract_attachments_contract_idx").on(t.contractId)],
);

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

/* ═════════════ نشست‌ها و دستگاه‌ها ═════════════ */

/** هر ورود یک ردیف؛ باطل‌کردن ردیف همان دستگاه را فوراً بیرون می‌اندازد */
export const userSessions = pgTable(
  "user_sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
    userAgent: text("user_agent").notNull().default(""),
    ip: text("ip").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId)],
);

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

/* ═════════════ نسخه‌های متن، مذاکره، تأیید داخلی و کتابخانه‌ی بندها ═════════════ */

/** تاریخچه‌ی نسخه‌های متن قرارداد (هر ذخیره/انتشار/بازگردانی یک عکس فوری)؛ برای مقایسه و بازگشت */
export const contractRevisions = pgTable(
  "contract_revisions",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    /** شماره‌ی ترتیبی نسخه در همین قرارداد (۱، ۲، …) */
    version: integer("version").notNull(),
    title: text("title").notNull(),
    bodyHtml: text("body_html").notNull(),
    kind: text("kind").notNull().default("draft"), // initial | draft | publish | restore
    note: text("note").notNull().default(""),
    wordCount: integer("word_count").notNull().default(0),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_revisions_uq").on(t.contractId, t.version)],
);

/** گفتگوی مذاکره‌ی هر قرارداد: یادداشت داخلی تیم، پیام مشترک با طرف مقابل و درخواست اصلاح */
export const contractComments = pgTable(
  "contract_comments",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    parentId: integer("parent_id").references((): AnyPgColumn => contractComments.id, { onDelete: "set null" }),
    authorUserId: integer("author_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    authorName: text("author_name").notNull().default(""),
    authorSide: text("author_side").notNull().default("team"), // team | signer
    visibility: text("visibility").notNull().default("shared"), // internal | shared
    kind: text("kind").notNull().default("comment"), // comment | change_request
    /** بخشی از متن قرارداد که نظر به آن اشاره دارد (اختیاری) */
    quote: text("quote").notNull().default(""),
    body: text("body").notNull(),
    status: text("status").notNull().default("open"), // open | resolved
    resolvedBy: integer("resolved_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("contract_comments_contract_idx").on(t.contractId, t.createdAt),
    // PERF-02: شمارش «درخواست اصلاح باز» (فهرست قراردادها) فقط از روی همین ایندکس جزئیِ کوچک
    index("contract_comments_open_requests_idx").on(t.contractId).where(sql`${t.kind} = 'change_request' and ${t.status} = 'open' and ${t.parentId} is null`),
  ],
);

/** تأیید داخلی پیش از انتشار: هر تأییدکننده باید نسخه‌ی فعلی متن را تأیید کند */
export const contractApprovals = pgTable(
  "contract_approvals",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    approverId: integer("approver_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
    requestedBy: integer("requested_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"), // pending | approved | changes_requested
    note: text("note").notNull().default(""),
    decidedAt: timestamp("decided_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_approvals_uq").on(t.contractId, t.approverId)],
);

/** کتابخانه‌ی بندهای آماده‌ی هر فضای کاری (درج با یک کلیک در ویرایشگر) */
export const clauses = pgTable(
  "clauses",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    category: text("category").notNull().default("general"),
    body: text("body").notNull(),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("clauses_ws_idx").on(t.workspaceId)],
);


/* ═════════════ کیف پول و اعتبار قرارداد ═════════════ */

/** کیف پول هر فضای کاری: موجودی ریالی (تومان) + اعتبار قرارداد (بسته‌های خریداری‌شده) */
export const wallets = pgTable("wallets", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).primaryKey(),
  /** موجودی به تومان؛ هرگز منفی نمی‌شود (شرط در همان UPDATE اتمی بررسی می‌شود) */
  balance: bigint("balance", { mode: "number" }).notNull().default(0),
  /** تعداد قرارداد اضافه‌ای که می‌توان بالاتر از سقف ماهانه‌ی طرح صادر کرد */
  credits: integer("credits").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** دفتر کل تغییرناپذیر: هر تغییر موجودی یا اعتبار یک ردیف با کلید یکتای ref (جلوگیری از ثبت دوباره) */
export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "no action" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    asset: text("asset").notNull().default("toman"), // toman | credits
    kind: text("kind").notNull(), // topup | pack_purchase | plan_purchase | credit_use | credit_refund | referral_reward | admin_adjust | refund
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),
    ref: text("ref"),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("wallet_tx_ws_idx").on(t.workspaceId, t.createdAt), uniqueIndex("wallet_tx_ref_uq").on(t.ref)],
);

/* ═════════════ دعوت از دوستان (Referral) ═════════════ */

/** کد دعوت اختصاصی هر کاربر */
export const referralCodes = pgTable("referral_codes", {
  userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).primaryKey(),
  code: text("code").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** هر کاربر فقط یک‌بار می‌تواند دعوت شود. status: pending (ثبت‌نام کرده) | qualified (اولین قرارداد واقعی صادر شد و پاداش داده شد) | rejected */
export const referrals = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    referrerUserId: integer("referrer_user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    referredUserId: integer("referred_user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull().unique(),
    referredWorkspaceId: integer("referred_workspace_id").notNull().default(0),
    code: text("code").notNull(),
    status: text("status").notNull().default("pending"),
    signupIp: text("signup_ip").notNull().default(""),
    /** پاداش‌های پرداخت‌شده (برای شفافیت و گزارش) */
    referrerCredits: integer("referrer_credits").notNull().default(0),
    referrerWallet: integer("referrer_wallet").notNull().default(0),
    referredCredits: integer("referred_credits").notNull().default(0),
    referredWallet: integer("referred_wallet").notNull().default(0),
    bonusDays: integer("bonus_days").notNull().default(0),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    qualifiedAt: timestamp("qualified_at"),
  },
  (t) => [index("referrals_referrer_idx").on(t.referrerUserId, t.createdAt)],
);

/* ═════════════ احراز هویت مدارک (KYC) ═════════════ */

/** درخواست احراز هویت یک فضای کاری؛ status: pending | approved | rejected */
export const kycSubmissions = pgTable(
  "kyc_submissions",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    fullName: text("full_name").notNull(),
    /** کد ملی رمزنگاری‌شده (AES-256-GCM) */
    nationalCodeEnc: text("national_code_enc").notNull(),
    /** HMAC کد ملی برای تشخیص استفاده‌ی تکراری در چند فضای کاری (بدون ذخیره‌ی متن ساده) */
    nationalCodeHash: text("national_code_hash").notNull(),
    birthDate: text("birth_date").notNull().default(""),
    status: text("status").notNull().default("pending"),
    rejectReason: text("reject_reason").notNull().default(""),
    reviewedBy: integer("reviewed_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("kyc_sub_ws_idx").on(t.workspaceId, t.createdAt), index("kyc_sub_status_idx").on(t.status), index("kyc_sub_hash_idx").on(t.nationalCodeHash)],
);

/** مدارک آپلودشده؛ فایل‌ها رمزنگاری‌شده روی دیسک (storage/kyc) ذخیره می‌شوند */
export const kycDocuments = pgTable(
  "kyc_documents",
  {
    id: serial("id").primaryKey(),
    submissionId: integer("submission_id").references((): AnyPgColumn => kycSubmissions.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind").notNull(), // national_front | national_back | selfie | other
    originalName: text("original_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull().default(0),
    /** SHA-256 محتوای اصلی (پیش از رمزنگاری) */
    sha256: text("sha256").notNull(),
    file: text("file").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("kyc_doc_sub_idx").on(t.submissionId)],
);

/* ═════════════ داشبورد سلامت سیستم ═════════════ */

/** نمونه‌های بررسی سلامت (برای نمودار تأخیر، درصد دسترسی و تاریخچه) — نگهداری ۱۴ روزه */
export const healthChecks = pgTable(
  "health_checks",
  {
    id: serial("id").primaryKey(),
    checkId: text("check_id").notNull(),
    status: text("status").notNull(), // ok | warn | fail | unconfigured
    latencyMs: integer("latency_ms"),
    message: text("message").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("health_checks_id_time_idx").on(t.checkId, t.createdAt)],
);

/** رخدادهای قطعی/افت کیفیت سرویس‌ها (باز تا لحظه‌ی بازیابی) */
export const healthIncidents = pgTable(
  "health_incidents",
  {
    id: serial("id").primaryKey(),
    checkId: text("check_id").notNull(),
    label: text("label").notNull().default(""),
    severity: text("severity").notNull().default("fail"), // warn | fail
    message: text("message").notNull().default(""),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    alertedAt: timestamp("alerted_at"),
    recoveryAlertedAt: timestamp("recovery_alerted_at"),
  },
  (t) => [index("health_incidents_open_idx").on(t.checkId, t.resolvedAt), index("health_incidents_started_idx").on(t.startedAt)],
);

/**
 * صف کارهای پس‌زمینه‌ی ماندگار (Outbox) — PERF-03 / DB-04.
 * کار (تولید PDF، ایمیل، اعلان، پاک‌سازی فایل) در همان تراکنشِ کسب‌وکار درج می‌شود و پس از commit، بیرون از مسیر پاسخ
 * اجرا می‌گردد؛ با شکست، با backoff نمایی تکرار می‌شود و با ری‌استارت سرور از بین نمی‌رود.
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    /** pending | running | done | dead */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    runAt: timestamp("run_at").notNull().defaultNow(),
    /** اجاره‌ی اجرا: اگر پردازه وسط کار بمیرد، پس از این زمان کار دوباره برداشته می‌شود */
    lockedUntil: timestamp("locked_until"),
    lastError: text("last_error"),
    /** کلید یکتا برای درج ایدمپوتنت (درج تکراری نادیده گرفته می‌شود) */
    dedupeKey: text("dedupe_key").unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("background_jobs_due_idx").on(t.status, t.runAt)],
);
