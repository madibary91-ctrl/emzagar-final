import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * M-04 — سطل‌های محدودکننده‌ی نرخ «پایدار» (مشترک بین همه‌ی نمونه‌ها و ماندگار پس از ری‌استارت).
 * کلید همیشه SHA-256 «کل» کلید منطقی است (نه برش‌خورده)، پس کلید بلند/متنوع نه برخورد می‌سازد و نه سطل قربانی
 * را از حافظه بیرون می‌ریزد (هیچ سقف تعداد/حذف قدیمی‌ترین در کار نیست؛ فقط ردیف‌های منقضی پاک می‌شوند).
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    hits: integer("hits").notNull().default(0),
    resetAt: timestamp("reset_at").notNull(),
  },
  (t) => [index("rate_limit_buckets_reset_idx").on(t.resetAt)],
);
