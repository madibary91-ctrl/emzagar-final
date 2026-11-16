import { type AnyPgColumn, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./tenancy";

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
