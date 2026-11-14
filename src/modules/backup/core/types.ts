export const BACKUP_PREFIX = "backup-";
export const NAME_RE = /^backup-\d{8}-\d{6}$/;
export const FILE_DIRS = ["signatures", "documents", "attachments", "kyc", "identity"] as const;
export const SECRETS_FILE = "secrets.sealed.json";
export const SEAL_ALG = "x25519-hkdf-sha256-aes256gcm-v1";
export interface BackupTableInfo {
  name: string;
  rows: number;
  columns: string[];
  file: string;
  sha256: string;
  bytes: number;
}
export interface BackupFileInfo {
  path: string;
  sha256: string;
  bytes: number;
}
export interface BackupSecretsInfo {
  file: string;
  sha256: string;
  bytes: number;
  alg: string;
  /** اثر انگشت کلید عمومی گیرنده (برای اینکه مالک بداند با کدام کلید بازیابی مهر شده) */
  recipient: string;
}
export interface BackupManifest {
  version: 1;
  createdAt: string;
  tables: BackupTableInfo[];
  files: BackupFileInfo[];
  /** رازهای مهر‌شده (اختیاری؛ بک‌آپ‌های قدیمی ندارند) */
  secrets?: BackupSecretsInfo;
  /** هشدارهای قابل‌نمایش: secret-not-sealed · backups-inside-data-volume · mirror-failed */
  warnings?: string[];
}
export interface MirrorResult {
  dir: string;
  ok: boolean;
  error?: string;
  /** حذف‌شده‌ها به‌خاطر سیاست نگهداری در مقصد */
  removed?: number;
}
export interface BackupOptions {
  databaseUrl: string;
  storageDir: string;
  backupDir: string;
  /** چند بک‌آپ آخر نگه داشته شود (پیش‌فرض ۱۴) */
  keep?: number;
  /** SESSION_SECRET فعلی؛ فقط وقتی همراه recoveryPublicKey باشد (مهر‌شده) در بک‌آپ قرار می‌گیرد */
  sessionSecret?: string;
  /** کلید عمومی بازیابی (خروجی generateRecoveryKeyPair().publicKey) */
  recoveryPublicKey?: string;
  /** مقصدهای آینه‌ی بک‌آپ (مسیرهای روی دیسک/mount دیگر) */
  mirrorDirs?: string[];
}
/** ساخت یک بک‌آپ کامل (دیتابیس + امضاها + PDFها) و حذف بک‌آپ‌های قدیمی */
export interface BackupResultInfo {
  dir: string;
  manifest: BackupManifest;
  removed: string[];
  mirrors: MirrorResult[];
  /** هشدارهای «نهایی» (شامل شکست آینه‌ها) برای نمایش به مدیر */
  warnings: string[];
}
export interface RestoreOptions {
  /** پوشه‌ی یک بک‌آپ */
  backup: string;
  databaseUrl: string;
  storageDir: string;
  /** دستورهای ساخت جدول (SCHEMA_CREATE) تا روی دیتابیس خالی هم کار کند */
  schemaStatements: string[];
  /** کلید خصوصی بازیابی (emz-rk1-…): برای باز کردن SESSION_SECRET مهر‌شده؛ اگر بک‌آپ راز دارد و این نباشد، بازیابی شروع نمی‌شود */
  recoveryKey?: string;
  /** عمداً بدون راز بازیابی شود (مدارک KYC و رازهای رمزنگاری‌شده‌ی دیتابیس خوانا نخواهند بود) */
  skipSecrets?: boolean;
}
