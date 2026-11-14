import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/* ═════════════ داشبورد سلامت سیستم ═════════════ */

/** نمونه‌های بررسی سلامت (برای نمودار تأخیر، درصد دسترسی و تاریخچه) — نگهداری ۱۴ روزه */
export const healthChecks = pgTable(
  "health_checks",
  {
    id: serial("id").primaryKey(),
    checkId: text("check_id").notNull(),
    status: text("status").notNull(), // ok | warn | fail | unconfigured
    latencyMs: integer("latency_ms"),
    message: text("message").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("health_checks_id_time_idx").on(t.checkId, t.createdAt)],
);
/** رخدادهای قطعی/افت کیفیت سرویس‌ها (باز تا لحظه‌ی بازیابی) */
export const healthIncidents = pgTable(
  "health_incidents",
  {
    id: serial("id").primaryKey(),
    checkId: text("check_id").notNull(),
    label: text("label").notNull().default(""),
    severity: text("severity").notNull().default("fail"), // warn | fail
    message: text("message").notNull().default(""),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    alertedAt: timestamp("alerted_at"),
    recoveryAlertedAt: timestamp("recovery_alerted_at"),
  },
  (t) => [index("health_incidents_open_idx").on(t.checkId, t.resolvedAt), index("health_incidents_started_idx").on(t.startedAt)],
);
/**
 * صف کارهای پس‌زمینه‌ی ماندگار (Outbox) — PERF-03 / DB-04.
 * کار (تولید PDF، ایمیل، اعلان، پاک‌سازی فایل) در همان تراکنشِ کسب‌وکار درج می‌شود و پس از commit، بیرون از مسیر پاسخ
 * اجرا می‌گردد؛ با شکست، با backoff نمایی تکرار می‌شود و با ری‌استارت سرور از بین نمی‌رود.
 */
export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: serial("id").primaryKey(),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    /** pending | running | done | dead */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    runAt: timestamp("run_at").notNull().defaultNow(),
    /** اجاره‌ی اجرا: اگر پردازه وسط کار بمیرد، پس از این زمان کار دوباره برداشته می‌شود */
    lockedUntil: timestamp("locked_until"),
    lastError: text("last_error"),
    /** کلید یکتا برای درج ایدمپوتنت (درج تکراری نادیده گرفته می‌شود) */
    dedupeKey: text("dedupe_key").unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("background_jobs_due_idx").on(t.status, t.runAt)],
);
