import { type AnyPgColumn, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contracts, templates } from "./contracts";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/** دسته‌ی ارسال انبوه از فایل اکسل/CSV: یک قالب × چند صد گیرنده با متغیرهای شخصی */
export const mergeBatches = pgTable(
  "merge_batches",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    fileName: text("file_name").notNull().default(""),
    templateId: integer("template_id").references((): AnyPgColumn => templates.id, { onDelete: "set null" }),
    /** عکس فوری متن قالب در لحظه‌ی بارگذاری (تغییر بعدی قالب، دسته‌ی در حال اجرا را عوض نمی‌کند) */
    bodyHtml: text("body_html").notNull(),
    contractTitle: text("contract_title").notNull(),
    headers: text("headers").notNull().default("[]"), // JSON: string[]
    mapping: text("mapping").notNull().default("{}"), // JSON: نگاشت نقش/متغیر ← ستون
    options: text("options").notNull().default("{}"), // JSON: برچسب امضاکننده، مهلت، برنامه‌ی پرداخت …
    status: text("status").notNull().default("draft"), // draft | running | done | cancelled
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
  },
  (t) => [index("merge_batches_ws_idx").on(t.workspaceId, t.createdAt)],
);
export const mergeRows = pgTable(
  "merge_rows",
  {
    id: serial("id").primaryKey(),
    batchId: integer("batch_id").references((): AnyPgColumn => mergeBatches.id, { onDelete: "cascade" }).notNull(),
    rowNo: integer("row_no").notNull(),
    data: text("data").notNull(), // JSON: ستون ← مقدار
    name: text("name").notNull().default(""),
    mobile: text("mobile").notNull().default(""),
    status: text("status").notNull().default("pending"), // pending | queued | processing | sent | failed | invalid | skipped
    error: text("error"),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("merge_rows_batch_row_uq").on(t.batchId, t.rowNo), index("merge_rows_status_idx").on(t.batchId, t.status)],
);
