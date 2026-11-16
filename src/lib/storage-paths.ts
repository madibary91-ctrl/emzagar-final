import path from "node:path";
import { STORAGE_DIR } from "@/lib/config";

/**
 * مسیرهای پوشه‌های محافظت‌شده (همه خارج از public؛ فقط از طریق مسیرهای احراز هویت‌شده قابل دریافت‌اند).
 * ساختار:  storage/signatures · documents · attachments · kyc · identity · sources · landing · branding · backups
 * (هر پوشه‌ی جدیدی که اینجا یا در ماژول‌ها اضافه می‌شود باید در FILE_DIRS بک‌آپ هم ثبت شود: src/modules/backup/core/types.ts)
 */
export const signaturesDir = () => path.join(STORAGE_DIR, "signatures");
export const documentsDir = () => path.join(STORAGE_DIR, "documents");
export const attachmentsDir = () => path.join(STORAGE_DIR, "attachments");
export const backupsDir = () => process.env.BACKUP_DIR || path.join(STORAGE_DIR, "backups");
/** مدارک احراز هویت (KYC): فایل‌ها با AES-256-GCM رمزنگاری‌شده ذخیره می‌شوند */
export const kycDir = () => path.join(STORAGE_DIR, "kyc");
/** مدارک هویتیِ امضاکننده (کارت ملی + سلفی)؛ رمزنگاری‌شده با AES-256-GCM */
export const identityDir = () => path.join(STORAGE_DIR, "identity");
/** فایل‌های مبدأ بارگذاری‌شده برای امضا روی فایل (PDF/Word) و PDF کاری آن‌ها */
export const sourcesDir = () => path.join(STORAGE_DIR, "sources");
