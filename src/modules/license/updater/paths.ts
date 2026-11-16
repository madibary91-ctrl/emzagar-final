import { STORAGE_DIR } from "@/lib/config";
import path from "node:path";

/**
 * به‌روزرسانی یک‌کلیکی (مثل وردپرس) برای نصب‌های «بسته‌ی release»:
 *  ۱) بررسی: سرور فروشنده (با لایسنس معتبر) نسخه‌ی جدید + SHA-256 را با امضای Ed25519 اعلام می‌کند.
 *  ۲) دانلود جریانی روی دیسک و تطبیق SHA-256 با مانیفست امضاشده.
 *  ۳) بک‌آپ کامل دیتابیس پیش از هر تغییر (ناموفق = توقف).
 *  ۴) استخراج جریانی در پوشه‌ی موقت با فهرست سفید مسیرها و جلوگیری از Zip-Slip (storage و .env هرگز لمس نمی‌شوند).
 *  ۵) جایگزینی با rename اتمی؛ نسخه‌ی قبلی در .update-rollback نگه‌داری می‌شود و در خطا خودکار برمی‌گردد.
 *  ۶) ری‌استارت پردازه؛ ساختار دیتابیس هنگام بالا آمدن خودکار ارتقا می‌یابد (applySchema).
 */
export const ROOT = process.cwd();
export const UPDATES_DIR = path.join(STORAGE_DIR, "updates");
export const ROLLBACK_DIR = path.join(ROOT, ".update-rollback");
export const STAGING_DIR = path.join(ROOT, ".update-staging");
export const ALLOWED_TOP = new Set([".next", "node_modules", "public", "assets", "wordpress-plugin", "docs", "server.js", "app.js", "package.json", "README-FA.txt"]);
export const MAX_ZIP = 600 * 1024 * 1024;
export const MAX_EXTRACTED = 2 * 1024 * 1024 * 1024;
export const g = globalThis as typeof globalThis & { __emzUpdating?: boolean };
