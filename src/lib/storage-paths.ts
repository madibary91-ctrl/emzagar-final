import path from "node:path";
import { STORAGE_DIR } from "@/lib/config";

/**
 * مسیرهای پوشه‌های محافظت‌شده (همه خارج از public؛ فقط از طریق مسیرهای احراز هویت‌شده قابل دریافت‌اند).
 * ساختار:  storage/signatures · storage/documents · storage/attachments · storage/backups
 */
export const signaturesDir = () => path.join(STORAGE_DIR, "signatures");
export const documentsDir = () => path.join(STORAGE_DIR, "documents");
export const attachmentsDir = () => path.join(STORAGE_DIR, "attachments");
export const backupsDir = () => process.env.BACKUP_DIR || path.join(STORAGE_DIR, "backups");
/** مدارک احراز هویت (KYC): فایل‌ها با AES-256-GCM رمزنگاری‌شده ذخیره می‌شوند */
export const kycDir = () => path.join(STORAGE_DIR, "kyc");
