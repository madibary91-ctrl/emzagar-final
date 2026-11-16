import { type AnyPgColumn, bigint, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./tenancy";

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
