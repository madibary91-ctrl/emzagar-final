import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { orders } from "./shop";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/** قالب‌های قرارداد */
export const templates = pgTable("templates", {
  workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  body: text("body").notNull(),
  /** کلید قالب در کتابخانه‌ی قالب‌های آماده (null = قالب دست‌ساز کاربر) */
  libraryKey: text("library_key"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
},
  // هر قالب کتابخانه در هر فضای کاری «حداکثر یک‌بار» کپی می‌شود (حتی با دو کلیک هم‌زمان)؛ قالب‌های دست‌ساز (library_key = null) آزادند
  (t) => [uniqueIndex("templates_ws_library_key_uq").on(t.workspaceId, t.libraryKey).where(sql`${t.libraryKey} is not null`)],
);
/** قراردادهای صادر شده */
export const contracts = pgTable(
  "contracts",
  {
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull().default(0),
    id: serial("id").primaryKey(),
    number: text("number").notNull().unique(),
    title: text("title").notNull(),
    templateId: integer("template_id").references((): AnyPgColumn => templates.id, { onDelete: "set null" }),
    customerId: integer("customer_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    bodyHtml: text("body_html").notNull(),
    status: text("status").notNull().default("sent"), // draft | sent | signed | rejected | expired | cancelled
    source: text("source").notNull().default("admin"), // admin | shop
    orderId: integer("order_id").references((): AnyPgColumn => orders.id, { onDelete: "set null" }),
    docHash: text("doc_hash"),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    signedAt: timestamp("signed_at"),
    /** زمان انتشار نسخه‌ی نهایی (برای پیش‌نویس‌ها null است) */
    publishedAt: timestamp("published_at"),
    /** مهلت امضا؛ پس از آن قرارداد منقضی می‌شود */
    expiresAt: timestamp("expires_at"),
    lastReminderAt: timestamp("last_reminder_at"),
    reminderCount: integer("reminder_count").notNull().default(0),
    /** مدت اعتبار قرارداد (روز، از لحظه‌ی امضای نهایی)؛ null = تعیین‌نشده */
    termDays: integer("term_days"),
    /** پایان مدت قرارداد (برای زمان‌بندی تمدید) */
    termEndsAt: timestamp("term_ends_at"),
    /** چند روز پیش از پایان مدت، یادآوری تمدید فرستاده شود */
    renewalNoticeDays: integer("renewal_notice_days").notNull().default(30),
    /** زمان ارسال یادآوری «به‌زودی تمام می‌شود» */
    renewalNotifiedAt: timestamp("renewal_notified_at"),
    /** زمان ارسال یادآوری «مدت تمام شد» */
    termEndedNotifiedAt: timestamp("term_ended_notified_at"),
    /** اگر این قرارداد تمدیدِ قرارداد دیگری است، شناسه‌ی قرارداد قبلی */
    renewedFromId: integer("renewed_from_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    /** ارزش مالی قرارداد (تومان)؛ برای گزارش و مرتب‌سازی. null = ثبت‌نشده */
    contractValue: integer("contract_value"),
    /** برچسب‌ها (جداشده با ویرگول) برای دسته‌بندی و بایگانی */
    tags: text("tags").notNull().default(""),
    /** زمان انتقال به بایگانی (فقط قراردادهای پایان‌یافته)؛ null = فعال */
    archivedAt: timestamp("archived_at"),
    /** شیوه‌ی امضا: sequential (ترتیبی) | parallel (هم‌زمان) | staged (مرحله‌ای: گروه‌های موازی به‌ترتیب) */
    signingMode: text("signing_mode").notNull().default("sequential"),
  },
  (t) => [index("contracts_customer_idx").on(t.customerId), index("contracts_status_idx").on(t.status), index("contracts_workspace_idx").on(t.workspaceId),
    // PERF-02: فهرست پیش‌فرض (ws + جدیدترین) و جستجوی زیررشته‌ای ILIKE '%q%' با ایندکس trigram (pg_trgm)
    index("contracts_ws_issued_idx").on(t.workspaceId, t.issuedAt.desc()),
    index("contracts_number_trgm_idx").using("gin", t.number.op("gin_trgm_ops")),
    index("contracts_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("contracts_tags_trgm_idx").using("gin", t.tags.op("gin_trgm_ops")),
  ],
);
/** امضاکنندگان به ترتیب امضا */
export const contractSigners = pgTable(
  "contract_signers",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    position: integer("position").notNull(),
    label: text("label").notNull(),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    status: text("status").notNull().default("pending"), // pending | signed | rejected
    signedAt: timestamp("signed_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    signatureFile: text("signature_file"),
    signatureMethod: text("signature_method"), // draw | upload
    otpVerifiedAt: timestamp("otp_verified_at"),
    mobile: text("mobile"),
    /** سطح امنیت هویت (اختیاری، به انتخاب صادرکننده): none | shahkar | document | both — پیش‌فرض none = مسیر سریع قبلی */
    identityReq: text("identity_req").notNull().default("none"),
    /** سطح هویتی که «در لحظه‌ی امضا» واقعاً احراز شده بود (none | shahkar | document | both)؛ پس از امضا تغییرناپذیر */
    identityAssurance: text("identity_assurance").notNull().default("none"),
    /** نقش در سند: signer (طرف قرارداد) | witness (شاهد؛ فقط گواهی می‌دهد) */
    role: text("role").notNull().default("signer"),
    /** مرحله‌ی امضا: امضاکنندگان هم‌مرحله «هم‌زمان» (موازی) امضا می‌کنند و مرحله‌ها به‌ترتیب‌اند. ۰ = مرحله‌ی مستقل (= position؛ ترتیبیِ قدیمی) */
    stage: integer("stage").notNull().default(0),
    /** natural = حقیقی | legal = حقوقی (شرکت) */
    signerType: text("signer_type").notNull().default("natural"),
    companyName: text("company_name").notNull().default(""),
    /** شناسه‌ی ملی شرکت (۱۱ رقم) */
    companyNationalId: text("company_national_id").notNull().default(""),
    /** سمت امضاکننده در شرکت (مثلاً مدیرعامل) */
    signatoryTitle: text("signatory_title").notNull().default(""),
    /** صادرکننده «مهر شرکتی» را الزامی کرده است */
    sealRequired: boolean("seal_required").notNull().default(false),
    sealFile: text("seal_file"),
    sealSha256: text("seal_sha256"),
    /** صادرکننده «پاراف همه‌ی صفحات» را الزامی کرده است */
    initialsRequired: boolean("initials_required").notNull().default(false),
    initialsFile: text("initials_file"),
    initialsSha256: text("initials_sha256"),
  },
  (t) => [index("signers_contract_idx").on(t.contractId), index("signers_user_idx").on(t.userId)],
);
/**
 * گواهی هویتِ امضاکننده (احراز هویت اختیاری): کد ملی ↔ شماره‌ی موبایل (استعلام شاهکار) و/یا مدارک هویتی با تأیید صادرکننده.
 * یک ردیف برای هر امضاکننده‌ای که صادرکننده سطح امنیت او را بالا برده است. کد ملی رمزنگاری (AES-256-GCM) و تصاویر
 * مدارک رمزنگاری‌شده روی دیسک (storage/identity) نگهداری می‌شوند؛ هرگز در پاسخ عمومی نمی‌آیند.
 */
export const signerIdentities = pgTable(
  "signer_identities",
  {
    id: serial("id").primaryKey(),
    signerId: integer("signer_id").references((): AnyPgColumn => contractSigners.id, { onDelete: "cascade" }).notNull().unique(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    workspaceId: integer("workspace_id").notNull().default(0),
    /** کد ملیِ مورد انتظار که صادرکننده اعلام کرده (اختیاری): امضاکننده باید همین را وارد کند */
    expectedNcEnc: text("expected_nc_enc"),
    expectedNcHash: text("expected_nc_hash"),
    /** کد ملیِ واردشده توسط امضاکننده */
    ncEnc: text("nc_enc"),
    ncHash: text("nc_hash"),
    /** موبایلی که در لحظه‌ی استعلام بررسی شد */
    checkedMobile: text("checked_mobile"),
    /** none | matched | mismatch | error */
    shahkarStatus: text("shahkar_status").notNull().default("none"),
    shahkarProvider: text("shahkar_provider").notNull().default(""),
    shahkarRef: text("shahkar_ref").notNull().default(""),
    shahkarAt: timestamp("shahkar_at"),
    /** تعداد تلاش‌های استعلام (سقف ثابت؛ ضد آزمون‌وخطا و هزینه) */
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at"),
    /** none | pending | approved | rejected */
    docStatus: text("doc_status").notNull().default("none"),
    idFile: text("id_file"),
    idMime: text("id_mime"),
    idSha256: text("id_sha256"),
    selfieFile: text("selfie_file"),
    selfieMime: text("selfie_mime"),
    selfieSha256: text("selfie_sha256"),
    docSubmittedAt: timestamp("doc_submitted_at"),
    docReviewedBy: integer("doc_reviewed_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    docReviewedAt: timestamp("doc_reviewed_at"),
    docRejectReason: text("doc_reject_reason").notNull().default(""),
    /** هنگام برآورده‌شدن همه‌ی الزام‌ها ثبت می‌شود (null = هنوز احراز نشده) */
    verifiedAt: timestamp("verified_at"),
    /** مهر یکپارچگی: هش مجموعه‌ی شواهد در لحظه‌ی امضا (در شناسنامه‌ی PDF درج می‌شود) */
    sealHash: text("seal_hash"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("signer_identities_contract_idx").on(t.contractId), index("signer_identities_ws_idx").on(t.workspaceId, t.docStatus)],
);
/* ═════════════ تحلیل ریسک قرارداد (هوش مصنوعی + موتور قواعد) ═════════════ */

export const contractAnalyses = pgTable(
  "contract_analyses",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "set null" }),
    userId: integer("user_id").references((): AnyPgColumn => users.id, { onDelete: "no action" }).notNull(),
    title: text("title").notNull().default(""),
    /** امتیاز ریسک: ۰ (کم‌ریسک) تا ۱۰۰ (بحرانی) */
    score: integer("score").notNull().default(0),
    level: text("level").notNull().default("low"), // low | medium | high | critical
    engine: text("engine").notNull().default("rules"), // rules | ai+rules
    model: text("model").notNull().default(""),
    /** نتیجه‌ی کامل (JSON): خلاصه، یافته‌ها، بندهای ناقص */
    result: text("result").notNull().default("{}"),
    textHash: text("text_hash").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("analyses_ws_idx").on(t.workspaceId, t.createdAt), index("analyses_contract_idx").on(t.contractId)],
);
/* ═════════════ امضای بدون ثبت‌نام (لینک امن اختصاصی هر امضاکننده) ═════════════ */

/**
 * لینک امضای اختصاصی یک امضاکننده. توکن ۲۵۶ بیتی تصادفی است؛ برای جستجو هش آن و برای ارسال مجدد
 * (یادآوری / کپی توسط مدیر) نسخه‌ی رمزنگاری‌شده‌اش ذخیره می‌شود. پس از امضا/رد/لغو، لینک بی‌اعتبار می‌شود.
 */
export const signingLinks = pgTable(
  "signing_links",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    signerId: integer("signer_id").references((): AnyPgColumn => contractSigners.id, { onDelete: "cascade" }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenEnc: text("token_enc").notNull().default(""),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    usedAt: timestamp("used_at"),
    opens: integer("opens").notNull().default(0),
    lastOpenedAt: timestamp("last_opened_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("signing_links_signer_idx").on(t.signerId), index("signing_links_contract_idx").on(t.contractId)],
);
/* ═════════════ PDF نهایی ساخته‌شده روی سرور ═════════════ */

/** نسخه‌ی PDF قرارداد امضاشده در پوشه‌ی محافظت‌شده؛ sha256 فایل برای کشف دستکاری ذخیره می‌شود */
export const contractDocuments = pgTable(
  "contract_documents",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    file: text("file").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_documents_contract_uq").on(t.contractId)],
);
/* ═════════════ فیلدهای قابل‌پرکردن داخل قرارداد ═════════════ */

/**
 * مقدار فیلدهایی که امضاکننده هنگام امضا پر کرده است (تعریف فیلد از توکن‌های `{{field:...}}` متن قرارداد خوانده می‌شود).
 * مقدارها پس از ثبت تغییر نمی‌کنند و در اثر انگشت (SHA-256) سند لحاظ می‌شوند.
 */
export const contractFieldValues = pgTable(
  "contract_field_values",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    signerId: integer("signer_id").references((): AnyPgColumn => contractSigners.id, { onDelete: "cascade" }).notNull(),
    key: text("key").notNull(),
    label: text("label").notNull().default(""),
    type: text("type").notNull().default("text"),
    value: text("value").notNull().default(""),
    filledAt: timestamp("filled_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contract_field_values_uq").on(t.contractId, t.key)],
);
/* ═════════════ پیوست فایل به قرارداد ═════════════ */

/** پیوست‌ها (کارت ملی، فاکتور …) در پوشه‌ی محافظت‌شده؛ نام فایل تصادفی و SHA-256 محتوا ثبت می‌شود */
export const contractAttachments = pgTable(
  "contract_attachments",
  {
    id: serial("id").primaryKey(),
    contractId: integer("contract_id").references((): AnyPgColumn => contracts.id, { onDelete: "cascade" }).notNull(),
    uploadedBy: integer("uploaded_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    uploaderLabel: text("uploader_label").notNull().default(""),
    title: text("title").notNull().default(""),
    originalName: text("original_name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull().default(0),
    sha256: text("sha256").notNull(),
    file: text("file").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("contract_attachments_contract_idx").on(t.contractId)],
);
/** کتابخانه‌ی بندهای آماده‌ی هر فضای کاری (درج با یک کلیک در ویرایشگر) */
export const clauses = pgTable(
  "clauses",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    title: text("title").notNull(),
    category: text("category").notNull().default("general"),
    body: text("body").notNull(),
    createdBy: integer("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("clauses_ws_idx").on(t.workspaceId)],
);
