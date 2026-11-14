import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/** کمپین جمع‌آوری امضای عمومی (لینک/QR): یک متن یا فایل، ده‌ها امضا */
export const collectCampaigns = pgTable(
  "collect_campaigns",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    /** شناسه‌ی کوتاه عمومی در آدرس /c/<code> */
    code: text("code").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    bodyHtml: text("body_html").notNull().default(""),
    /** JSON: تعریف فیلدهای فرم [{key,label,type,required,options?}] */
    fieldsJson: text("fields_json").notNull().default("[]"),
    status: text("status").notNull().default("open"), // open | paused | closed
    requireOtp: boolean("require_otp").notNull().default(true),
    requireSignature: boolean("require_signature").notNull().default(true),
    allowDuplicates: boolean("allow_duplicates").notNull().default(false),
    maxSubmissions: integer("max_submissions"),
    closesAt: timestamp("closes_at"),
    successMessage: text("success_message").notNull().default(""),
    /** حالت فایل: PDF/Word مبدأ + جانمایی فیلدها (JSON) */
    docFile: text("doc_file").notNull().default(""),
    docSha256: text("doc_sha256").notNull().default(""),
    docName: text("doc_name").notNull().default(""),
    docPagesMeta: text("doc_pages_meta").notNull().default("[]"),
    docPlacementsJson: text("doc_placements_json").notNull().default("[]"),
    views: integer("views").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("collect_campaigns_ws_idx").on(t.workspaceId, t.createdAt.desc())],
);
/** هر امضای جمع‌آوری‌شده */
export const collectSubmissions = pgTable(
  "collect_submissions",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id").references((): AnyPgColumn => collectCampaigns.id, { onDelete: "cascade" }).notNull(),
    workspaceId: integer("workspace_id").notNull(),
    /** کد رسید عمومی برای استعلام */
    receipt: text("receipt").notNull().unique(),
    fullName: text("full_name").notNull(),
    mobile: text("mobile").notNull().default(""),
    mobileVerified: boolean("mobile_verified").notNull().default(false),
    valuesJson: text("values_json").notNull().default("{}"),
    /** نسخه‌ی متن در لحظه‌ی امضا (ویرایش بعدی کمپین روی امضاهای قبلی اثر ندارد) */
    bodySnapshot: text("body_snapshot").notNull().default(""),
    signatureFile: text("signature_file"),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    docHash: text("doc_hash").notNull().default(""),
    /** جلوگیری از امضای تکراری (موبایل یا نام+کد ملی)؛ null = تکرار مجاز */
    dedupeKey: text("dedupe_key"),
    voidedAt: timestamp("voided_at"),
    voidReason: text("void_reason").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("collect_submissions_campaign_idx").on(t.campaignId, t.createdAt.desc()),
    uniqueIndex("collect_submissions_dedupe_uq").on(t.campaignId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);
