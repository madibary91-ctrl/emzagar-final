/**
 * DDL ایدمپوتنت نصب‌کننده و ارتقا — «محاسبه‌شده» از `src/db/schema.ts` (DB-05).
 * این فایل دیگر تولیدی/دستی نیست؛ منبع حقیقتِ ساختار دیتابیس فقط schema.ts است.
 */
import { buildSchemaPlan } from "@/db/ddl";

export const SCHEMA_PLAN = buildSchemaPlan();

/**
 * ساخت کامل ساختار روی دیتابیس تازه: افزونه‌ها ← جدول‌ها ← ایندکس‌ها ← Foreign Keyها (به همین ترتیب).
 * برای ارتقای دیتابیس قدیمی، `applySchema` از مراحل جداگانه‌ی SCHEMA_PLAN استفاده می‌کند
 * (ستون‌های جدید باید پیش از ایندکس‌ها و قیدها افزوده شوند).
 */
export const SCHEMA_CREATE: string[] = [...SCHEMA_PLAN.extensions, ...SCHEMA_PLAN.tables, ...SCHEMA_PLAN.indexes, ...SCHEMA_PLAN.foreignKeys];

/** افزودن ستون‌های جدید به جدول‌های موجود (ADD COLUMN IF NOT EXISTS). خطای هر دستور دیگر نادیده گرفته نمی‌شود. */
export const SCHEMA_ALTER: string[] = SCHEMA_PLAN.columns;
