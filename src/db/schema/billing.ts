import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contracts } from "./contracts";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/* ═════════════ اشتراک و پرداخت (درآمد پلتفرم) ═════════════ */

/**
 * کاتالوگ پویای طرح‌های اشتراک (مدیریت‌شده توسط مدیر کل پلتفرم در «مدیریت پلتفرم ← طرح‌های اشتراک»).
 * این جدول جایگزین طرح‌های هاردکد است؛ `id` شناسه‌ی پایدار (slug) است و در subscriptions.plan / payments.plan ذخیره می‌شود.
 *  - contracts_per_month و members: عدد -1 یعنی نامحدود.
 *  - durations (JSON متنی): «ماه ← درصد تخفیف»، مثلاً {"1":0,"3":10,"12":25}؛ کلیدها مدت‌های قابل خرید این طرح‌اند.
 *  - is_default: طرح پایه‌ی (رایگان) فضاهای بدون اشتراک فعال؛ همیشه دقیقاً یکی (ایندکس یکتای جزئی).
 *  - is_public: نمایش در صفحه‌ی تعرفه/لندینگ و خرید خودخدمت؛ طرح خصوصی را فقط مدیر کل به فضای کاری اختصاص می‌دهد.
 *  - is_active=false یعنی بایگانی: قابل خرید نیست ولی مشترکان فعلی تا پایان دوره‌شان آن را دارند.
 */
export const subscriptionPlans = pgTable(
  "subscription_plans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tagline: text("tagline").notNull().default(""),
    priceToman: integer("price_toman").notNull().default(0),
    contractsPerMonth: integer("contracts_per_month").notNull().default(10),
    members: integer("members").notNull().default(2),
    aiPerDay: integer("ai_per_day").notNull().default(8),
    /** آرایه‌ی JSON از رشته‌ها (متن؛ تا با نوع‌های ستون سازگار و قابل‌حمل بماند) */
    features: text("features").notNull().default("[]"),
    /** شیء JSON «ماه ← درصد تخفیف» */
    durations: text("durations").notNull().default('{"1":0,"3":10,"6":17,"12":25}'),
    highlight: boolean("highlight").notNull().default(false),
    isPublic: boolean("is_public").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    isRewardPlan: boolean("is_reward_plan").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscription_plans_one_default_idx").on(t.isDefault).where(sql`${t.isDefault}`),
    uniqueIndex("subscription_plans_one_reward_idx").on(t.isRewardPlan).where(sql`${t.isRewardPlan}`),
    index("subscription_plans_order_idx").on(t.sortOrder, t.priceToman),
  ],
);
/** اشتراک هر فضای کاری؛ نبود ردیف یعنی طرح رایگان */
export const subscriptions = pgTable("subscriptions", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).primaryKey(),
  plan: text("plan").notNull().default("free"), // شناسه‌ی طرح در subscription_plans (پیش‌فرض نصب: free | pro | business)
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
/* ═════════ فاز ۴: امضا و پرداخت (Sign & Pay)، ارسال انبوه (Mail-Merge) ═════════ */

/**
 * تعهدات مالی قرارداد: بیعانه، اقساط یا پرداخت مرحله‌ای پروژه.
 * مبلغ‌ها تومان و فقط سمت سرور تعیین می‌شوند. `gate = before_sign` یعنی پرداخت‌کننده تا نپردازد نمی‌تواند امضا کند.
 * پرداخت از راه درگاه (جدول payments با kind=contract) یا ثبت دستی مدیر (کارت‌به‌کارت/نقد) انجام می‌شود.
 */
export const contractInstallments = pgTable(
  "contract_installments",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("installment"), // deposit | installment | milestone
    amount: integer("amount").notNull(),
    dueAt: timestamp("due_at"),
    /** جایگاه امضاکننده‌ای که می‌پردازد؛ 0 = آخرین امضاکننده (مشتری) */
    payerPosition: integer("payer_position").notNull().default(0),
    gate: text("gate").notNull().default("none"), // none | before_sign
    status: text("status").notNull().default("pending"), // pending | paid | cancelled
    method: text("method"), // gateway | manual
    paymentId: integer("payment_id").references((): AnyPgColumn => payments.id, { onDelete: "set null" }),
    refId: text("ref_id"),
    paidAt: timestamp("paid_at"),
    note: text("note"),
    /** کد غیرقابل‌حدس لینک پرداخت عمومی (/pay/[code]) */
    payCode: text("pay_code").notNull().unique(),
    /** مسیر بازگشت پس از درگاه (آخرین صفحه‌ای که پرداخت از آن شروع شد) */
    returnPath: text("return_path"),
    reminderCount: integer("reminder_count").notNull().default(0),
    lastReminderAt: timestamp("last_reminder_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("installments_contract_idx").on(t.contractId, t.position), index("installments_ws_status_idx").on(t.workspaceId, t.status, t.dueAt)],
);
