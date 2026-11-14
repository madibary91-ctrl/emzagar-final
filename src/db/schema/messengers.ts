import { type AnyPgColumn, bigint, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/* ═════════════ ربات‌های پیام‌رسان (تلگرام / بله): ارسال لینک امضا، وضعیت قرارداد و اعلان‌ها ═════════════ */

/**
 * ربات متصل‌شده. `workspaceId = null` یعنی «ربات پلتفرم» (برای همه‌ی کاربران)؛ در غیر این صورت ربات اختصاصی (برندشده) یک فضای کاری.
 * توکن ربات فقط رمزنگاری‌شده (AES-256-GCM) ذخیره می‌شود و هرگز به مرورگر برنمی‌گردد.
 */
export const messengerBots = pgTable(
  "messenger_bots",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }),
    /** telegram | bale */
    provider: text("provider").notNull(),
    label: text("label").notNull().default(""),
    tokenEnc: text("token_enc").notNull(),
    /** هش توکن: جلوگیری از ثبت دوباره‌ی یک ربات (یک توکن = یک وب‌هوک) */
    tokenHash: text("token_hash").notNull().unique(),
    botUsername: text("bot_username").notNull().default(""),
    botName: text("bot_name").notNull().default(""),
    /** آدرس رله/پروکسی اختیاری (مثلاً Cloudflare Worker) برای سرورهای ایران که api.telegram.org روی آن‌ها فیلتر است */
    apiBase: text("api_base").notNull().default(""),
    /** webhook = تلگرام/بله به سرور ما می‌فرستد؛ polling = سرور ما می‌پرسد (بدون نیاز به HTTPS عمومی) */
    mode: text("mode").notNull().default("webhook"),
    /** راز تصادفی داخل آدرس وب‌هوک */
    webhookSecret: text("webhook_secret").notNull().unique(),
    active: boolean("active").notNull().default(true),
    /** کد تأیید امضا از پیام‌رسان: off | prefer (پیام‌رسان، و فقط در صورت ناموفق بودن پیامک) | both */
    otpMode: text("otp_mode").notNull().default("prefer"),
    /** ارسال فایل PDF نهایی داخل پیام‌رسان (پیش‌فرض خاموش: فایل از سرور خارجی عبور می‌کند) */
    sendPdf: boolean("send_pdf").notNull().default(false),
    /** new | connected | error */
    status: text("status").notNull().default("new"),
    lastError: text("last_error").notNull().default(""),
    lastUpdateId: bigint("last_update_id", { mode: "number" }).notNull().default(0),
    /** اجاره‌ی polling: فقط یک پردازه هم‌زمان از یک ربات می‌پرسد */
    pollLeaseUntil: timestamp("poll_lease_until"),
    lastEventAt: timestamp("last_event_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("messenger_bots_ws_idx").on(t.workspaceId)],
);
/** چت خصوصی یک کاربر با یک ربات */
export const messengerChats = pgTable(
  "messenger_chats",
  {
    id: serial("id").primaryKey(),
    botId: integer("bot_id").references((): AnyPgColumn => messengerBots.id, { onDelete: "cascade" }).notNull(),
    chatId: text("chat_id").notNull(),
    /** حساب کاربری مرتبط (از راه کد یک‌بارمصرف پنل یا لینک اختصاصی امضا) */
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }),
    /** شماره‌ی موبایلی که خودِ پیام‌رسان گواهی کرده است (دکمه‌ی «اشتراک شماره»)؛ مبنای OTP و پیدا کردن قراردادهای امضاکننده */
    verifiedMobile: text("verified_mobile").notNull().default(""),
    username: text("username").notNull().default(""),
    displayName: text("display_name").notNull().default(""),
    /** true = اعلان‌های عمومی بی‌صدا (لینک امضا و کد تأیید همیشه می‌رسد) */
    muted: boolean("muted").notNull().default(false),
    /** کاربر ربات را بسته/مسدود کرده است؛ ارسال متوقف می‌شود تا دوباره پیام بدهد */
    blocked: boolean("blocked").notNull().default(false),
    linkedAt: timestamp("linked_at"),
    /** «پاسخ از همین‌جا»: پیام‌های بعدیِ پشتیبان در این چت به‌عنوان پاسخ به این گفتگوی آنلاین ارسال می‌شود (تا replyUntil) */
    replyConvId: integer("reply_conv_id"),
    replyUntil: timestamp("reply_until"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messenger_chats_bot_chat_uq").on(t.botId, t.chatId),
    index("messenger_chats_user_idx").on(t.userId),
    index("messenger_chats_mobile_idx").on(t.verifiedMobile),
  ],
);
/** کدهای یک‌بارمصرف اتصال حساب (۱۰ دقیقه‌ای)؛ فقط هش ذخیره می‌شود */
export const messengerLinkCodes = pgTable(
  "messenger_link_codes",
  {
    id: serial("id").primaryKey(),
    codeHash: text("code_hash").notNull().unique(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
    botId: integer("bot_id").references((): AnyPgColumn => messengerBots.id, { onDelete: "cascade" }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("messenger_link_codes_exp_idx").on(t.expiresAt)],
);
/** آپدیت‌های دریافتی (ضد پردازش تکراری: تلگرام/بله ممکن است یک آپدیت را دوباره بفرستند) */
export const messengerUpdates = pgTable(
  "messenger_updates",
  {
    id: serial("id").primaryKey(),
    botId: integer("bot_id").references((): AnyPgColumn => messengerBots.id, { onDelete: "cascade" }).notNull(),
    updateId: bigint("update_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("messenger_updates_bot_upd_uq").on(t.botId, t.updateId), index("messenger_updates_created_idx").on(t.createdAt)],
);
/** لاگ ارسال‌ها (بدون متن پیام: لینک و کد هرگز ذخیره نمی‌شوند) */
export const messengerLog = pgTable(
  "messenger_log",
  {
    id: serial("id").primaryKey(),
    botId: integer("bot_id").references((): AnyPgColumn => messengerBots.id, { onDelete: "cascade" }).notNull(),
    chatRowId: integer("chat_row_id"),
    /** notice | signlink | otp | finalcopy | reply | test */
    kind: text("kind").notNull(),
    /** sent | failed */
    status: text("status").notNull(),
    error: text("error").notNull().default(""),
    contractId: integer("contract_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("messenger_log_bot_idx").on(t.botId, t.createdAt)],
);
