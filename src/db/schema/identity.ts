import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

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
  /**
   * امضاکننده‌ی مهمان (فاز ۱): هویت سبک بدون حساب کاربری. ایمیل ساختگی (‎@guest.emzagar.invalid‎) و رمز تصادفیِ
   * ناشناخته دارد، هرگز نمی‌تواند وارد شود/رمز بازیابی کند، و فقط از راه «لینک اختصاصی + OTP پیامکی» امضا می‌کند.
   */
  isGuest: boolean("is_guest").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
  // PERF-02: جستجوی نام/ایمیل مشتری در فهرست قراردادها
  (t) => [index("users_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")), index("users_email_trgm_idx").using("gin", t.email.op("gin_trgm_ops"))],
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
/** توکن‌های یک‌بارمصرف تعیین/بازیابی رمز عبور (فقط هش ذخیره می‌شود) */
export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
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
    /**
     * H-03: رمزِ «در انتظار» ثبت‌نام مجدد روی حساب تأییدنشده. هرگز مستقیم روی حساب نمی‌نشیند؛ فقط وقتی اعمال می‌شود که
     * کد/لینک توسط «همان مرورگری» تأیید شود که ثبت‌نام کرده (bindingHash = sha256 رازی که فقط در کوکی آن مرورگر است).
     */
    pendingPasswordHash: text("pending_password_hash"),
    bindingHash: text("binding_hash"),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("email_verif_user_idx").on(t.userId, t.createdAt)],
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
/** تأیید مالکیت موبایل با پیامک (ارسال سریع و فرم‌های عمومی) */
export const mobileVerifications = pgTable(
  "mobile_verifications",
  {
    id: serial("id").primaryKey(),
    purpose: text("purpose").notNull(), // quick | collect
    scope: text("scope").notNull().default(""),
    mobile: text("mobile").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    ip: text("ip").notNull().default(""),
    expiresAt: timestamp("expires_at").notNull(),
    verifiedAt: timestamp("verified_at"),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("mobile_verifications_lookup_idx").on(t.purpose, t.scope, t.mobile, t.createdAt)],
);
