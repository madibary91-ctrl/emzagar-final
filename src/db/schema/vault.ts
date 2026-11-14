import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contracts } from "./contracts";
import { users } from "./identity";

/**
 * ── کیف اسناد امضاکننده (Signer Vault) ───────────────────────────────────────
 * هویت کیف = «شماره‌ی موبایل تأییدشده با OTP» (نه یک ردیف users)؛ پس امضاکننده‌ای که در چند فضای کاری
 * به‌عنوان مهمان امضا کرده، همه‌ی اسنادش را یک‌جا می‌بیند. این جدول، پروفایل سبک و قیف رشد هر موبایل است.
 */
export const vaultProfiles = pgTable(
  "vault_profiles",
  {
    id: serial("id").primaryKey(),
    mobile: text("mobile").notNull(),
    /** نقطه‌ی ورود اول: sign (بعد از امضا) | direct (ورود مستقیم) | quick (بعد از ارسال سریع) */
    source: text("source").notNull().default("direct"),
    visits: integer("visits").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    /** حساب کاربری واقعی که از همین کیف ساخته شد (قیف رشد) */
    upgradedUserId: integer("upgraded_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    upgradedAt: timestamp("upgraded_at"),
    /** فرستنده‌ای که اولین بار این امضاکننده را آورد (انتساب «اولین لمس»؛ گیرنده‌ی پاداش دعوت) */
    referrerUserId: integer("referrer_user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    attributedContractId: integer("attributed_contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("vault_profiles_mobile_uq").on(t.mobile), index("vault_profiles_upgraded_idx").on(t.upgradedUserId)],
);
/** مدیریت شخصی اسناد در کیف: سنجاق، بایگانی و یادداشت خصوصی (به‌ازای موبایل + قرارداد) */
export const vaultPrefs = pgTable(
  "vault_prefs",
  {
    id: serial("id").primaryKey(),
    mobile: text("mobile").notNull(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    note: text("note").notNull().default(""),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vault_prefs_mobile_contract_uq").on(t.mobile, t.contractId)],
);
