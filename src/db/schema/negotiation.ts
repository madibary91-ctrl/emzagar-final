import { type AnyPgColumn, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { contractSigners, contracts } from "./contracts";
import { sql } from "drizzle-orm";
import { users } from "./identity";

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
