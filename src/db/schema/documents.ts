import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contracts } from "./contracts";

/* ═════════════ فاز ۲: امضای فایل دلخواه (PDF/Word)، ارسال سریع و جمع‌آوری امضای عمومی ═════════════ */

/**
 * فایل بارگذاری‌شده‌ی کاربر که هنوز به قراردادی تبدیل نشده است (مرحله‌ی «جانمایی»).
 * `code` یک شناسه‌ی تصادفی ۱۲۸ بیتی است و خودش مجوز دسترسی است؛ فایل‌های مصرف‌نشده خودکار پاک می‌شوند.
 */
export const documentDrafts = pgTable(
  "document_drafts",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull().unique(),
    /** فضای کاری مالک (null = ارسال سریع بدون حساب) */
    workspaceId: integer("workspace_id"),
    userId: integer("user_id"),
    ip: text("ip").notNull().default(""),
    kind: text("kind").notNull().default("pdf"), // pdf | docx
    originalName: text("original_name").notNull().default(""),
    originalFile: text("original_file").notNull(),
    originalSha256: text("original_sha256").notNull(),
    /** PDF کاری: برای PDF همان فایل اصلی، برای Word نسخه‌ی تبدیل‌شده */
    pdfFile: text("pdf_file").notNull(),
    pdfSha256: text("pdf_sha256").notNull(),
    size: integer("size").notNull().default(0),
    pageCount: integer("page_count").notNull().default(1),
    /** JSON: [{w,h,rot}] ابعاد «نمایشی» هر صفحه به point */
    pagesMeta: text("pages_meta").notNull().default("[]"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    consumedAt: timestamp("consumed_at"),
  },
  (t) => [index("document_drafts_created_idx").on(t.createdAt)],
);
/** فایل مبدأ یک قرارداد (امضای «روی خودِ فایل») */
export const contractSources = pgTable(
  "contract_sources",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind").notNull().default("pdf"),
    originalName: text("original_name").notNull().default(""),
    originalFile: text("original_file").notNull(),
    originalSha256: text("original_sha256").notNull(),
    pdfFile: text("pdf_file").notNull(),
    pdfSha256: text("pdf_sha256").notNull(),
    size: integer("size").notNull().default(0),
    pageCount: integer("page_count").notNull().default(1),
    pagesMeta: text("pages_meta").notNull().default("[]"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_sources_contract_uq").on(t.contractId)],
);
/** جایگاه بصری فیلدها روی صفحه‌ی فایل؛ مختصات از گوشه‌ی بالا-چپِ صفحه‌ی نمایشی */
export const documentFields = pgTable(
  "document_fields",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    /** شماره‌ی (position) امضاکننده‌ای که این فیلد را پر می‌کند */
    signerPosition: integer("signer_position").notNull(),
    kind: text("kind").notNull(), // signature | name | date | text | checkbox
    label: text("label").notNull().default(""),
    page: integer("page").notNull(),
    /** مختصات به «ده‌هزارم» صفحه (۰ تا ۱۰۰۰۰)؛ تبدیل به کسر در سرویس docs انجام می‌شود */
    x: integer("x").notNull(),
    y: integer("y").notNull(),
    w: integer("w").notNull(),
    h: integer("h").notNull(),
    required: boolean("required").notNull().default(true),
  },
  (t) => [index("document_fields_contract_idx").on(t.contractId)],
);
/** ارسال سریع: پیوند مدیریتی بدون حساب کاربری برای فرستنده */
export const quickSends = pgTable(
  "quick_sends",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    senderUserId: integer("sender_user_id").notNull(),
    senderName: text("sender_name").notNull(),
    senderMobile: text("sender_mobile").notNull(),
    recipientName: text("recipient_name").notNull(),
    recipientMobile: text("recipient_mobile").notNull(),
    ip: text("ip").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("quick_sends_contract_uq").on(t.contractId), index("quick_sends_sender_idx").on(t.senderMobile, t.createdAt)],
);
