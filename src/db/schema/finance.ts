import { type AnyPgColumn, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { payments } from "./billing";
import { users } from "./identity";
import { workspaces } from "./tenancy";

/* ═════════════ چرخه‌ی مالی بالغ: فاکتور رسمی، بازپرداخت، اعلان انقضای اشتراک ═════════════ */

/**
 * فاکتور رسمی پرداخت‌های اشتراک پلتفرم (و اعلامیه‌ی بستانکاری هنگام بازپرداخت).
 *  - شماره‌ی فاکتور «پیوسته و بدون جا افتادگی» است (جدول invoice_counters، داخل همان تراکنش صدور): INV-1405-000012 / CN-1405-000003.
 *  - مبالغ تومان‌اند. مالیات «شامل‌شده در قیمت» است (قیمت‌های طرح همان مبلغ پرداختی مشتری‌اند): tax = total × r / (100 + r).
 *  - اعلامیه‌ی بستانکاری (credit_note) مبالغ منفی دارد و با related_invoice_id به فاکتور اصلی وصل است.
 *  - خریدار/فروشنده «عکس لحظه‌ی صدور» (snapshot) ذخیره می‌شود؛ تغییر بعدی نام فضای کاری یا مشخصات فروشنده فاکتور صادرشده را عوض نمی‌کند.
 *  - هر پرداخت حداکثر یک فاکتور اصلی دارد (ایندکس یکتای جزئی) ⇒ صدور ایدمپوتنت است.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    number: text("number").notNull().unique(),
    /** invoice | credit_note */
    kind: text("kind").notNull().default("invoice"),
    seq: integer("seq").notNull(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "no action" }).notNull(),
    paymentId: integer("payment_id").references((): AnyPgColumn => payments.id, { onDelete: "set null" }),
    relatedInvoiceId: integer("related_invoice_id").references((): AnyPgColumn => invoices.id, { onDelete: "set null" }),
    /** issued | partially_refunded | refunded (روی فاکتور اصلی) */
    status: text("status").notNull().default("issued"),
    /** شماره‌ی پیگیری یکتای فاکتور (برای استعلام/پشتیبانی) */
    trackingCode: text("tracking_code").notNull().unique(),
    /** کد پیگیری درگاه (ref_id پرداخت) */
    paymentRef: text("payment_ref"),
    /** آرایه‌ی JSON از ردیف‌های فاکتور: [{title, qty, amount}] (amount تومان؛ منفی برای تخفیف/اعتبار) */
    items: text("items").notNull().default("[]"),
    /** مبلغ کالا/خدمت بدون مالیات (پس از کسر اعتبار Proration) */
    subtotal: integer("subtotal").notNull().default(0),
    /** مجموع تخفیف/اعتبارهای اعمال‌شده (نمایشی؛ در ردیف‌ها هم هست) */
    discount: integer("discount").notNull().default(0),
    taxPercent: integer("tax_percent").notNull().default(0),
    taxAmount: integer("tax_amount").notNull().default(0),
    /** مبلغ نهایی قابل پرداخت/پرداخت‌شده (شامل مالیات) */
    total: integer("total").notNull().default(0),
    /** فاکتور آزمایشی (پرداخت sandbox/دمو) */
    test: boolean("test").notNull().default(false),
    buyer: text("buyer").notNull().default("{}"),
    seller: text("seller").notNull().default("{}"),
    note: text("note"),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_one_per_payment_idx").on(t.paymentId).where(sql`${t.paymentId} is not null and ${t.kind} = 'invoice'`),
    index("invoices_ws_idx").on(t.workspaceId, t.issuedAt),
    index("invoices_payment_idx").on(t.paymentId),
    index("invoices_related_idx").on(t.relatedInvoiceId),
  ],
);

/** شمارنده‌ی پیوسته‌ی فاکتور به‌ازای «پیشوند + سال شمسی» (مثلاً INV-1405) */
export const invoiceCounters = pgTable("invoice_counters", {
  key: text("key").primaryKey(),
  last: integer("last").notNull().default(0),
});

/**
 * بازپرداخت (Refund) پرداخت اشتراک — فقط مدیر کل پلتفرم.
 *  - method: wallet (بازگشت آنی به کیف پول فضای کاری) | manual (بازگشت بانکی خارج از سامانه؛ فقط ثبت می‌شود).
 *  - مجموع بازپرداخت‌های یک پرداخت هرگز از مبلغ آن بیشتر نمی‌شود (payments.refunded_amount زیر قفل ردیف).
 */
export const refunds = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    paymentId: integer("payment_id").references((): AnyPgColumn => payments.id, { onDelete: "no action" }).notNull(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "no action" }).notNull(),
    amount: integer("amount").notNull(),
    method: text("method").notNull().default("wallet"),
    reason: text("reason").notNull().default(""),
    /** آیا اشتراک هم لغو شد؟ */
    revoked: boolean("revoked").notNull().default(false),
    creditNoteId: integer("credit_note_id").references((): AnyPgColumn => invoices.id, { onDelete: "set null" }),
    actorId: integer("actor_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("refunds_payment_idx").on(t.paymentId), index("refunds_ws_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * اعلان‌های ارسال‌شده‌ی انقضای اشتراک (d7 | d3 | d1 | expired) — ضامن «هر مرحله، برای هر دوره، فقط یک‌بار».
 * کلید یکتا شامل پایان دوره است؛ با تمدید، دوره‌ی جدید یادآوری‌های تازه می‌گیرد.
 */
export const subscriptionNotices = pgTable(
  "subscription_notices",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references((): AnyPgColumn => workspaces.id, { onDelete: "cascade" }).notNull(),
    periodEnd: timestamp("period_end").notNull(),
    stage: text("stage").notNull(),
    sentAt: timestamp("sent_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscription_notices_uq").on(t.workspaceId, t.periodEnd, t.stage)],
);
