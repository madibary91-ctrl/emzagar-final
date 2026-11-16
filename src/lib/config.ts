import fs from "node:fs";
import path from "node:path";

/**
 * پیکربندی زمان اجرا.
 *
 * اولویت: متغیرهای محیطی (Docker / سرورهای حرفه‌ای)  ←  فایل storage/config.json (نصب‌کننده‌ی وب).
 * نصب‌کننده‌ی وب همه‌ی مقادیر را خودش می‌نویسد؛ خریدار هرگز فایل .env را ویرایش نمی‌کند.
 */
export const STORAGE_DIR = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
const CONFIG_FILE = path.join(STORAGE_DIR, "config.json");
const LOCK_FILE = path.join(STORAGE_DIR, "installed.lock");

export const PLACEHOLDER_SECRET = "change-me-to-a-long-random-string";

export type FileConfig = {
  databaseUrl?: string;
  sessionSecret?: string;
  appUrl?: string;
};

let cached: { at: number; value: FileConfig } | null = null;

function readFileConfig(): FileConfig {
  // کش کوتاه‌مدت: هم سریع است، هم تغییر دستی فایل (مثلاً از طریق مدیریت فایل هاست) به‌زودی اعمال می‌شود
  if (cached && Date.now() - cached.at < 3000) return cached.value;
  let value: FileConfig = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      value = {
        databaseUrl: typeof p.databaseUrl === "string" ? p.databaseUrl : undefined,
        sessionSecret: typeof p.sessionSecret === "string" ? p.sessionSecret : undefined,
        appUrl: typeof p.appUrl === "string" ? p.appUrl : undefined,
      };
    }
  } catch {
    /* فایل هنوز ساخته نشده */
  }
  cached = { at: Date.now(), value };
  return value;
}

const validSecret = (s: string | undefined): s is string => !!s && s.length >= 16 && s !== PLACEHOLDER_SECRET;

export function getConfig() {
  const file = readFileConfig();
  return {
    databaseUrl: process.env.DATABASE_URL || file.databaseUrl || "",
    sessionSecret: validSecret(process.env.SESSION_SECRET) ? process.env.SESSION_SECRET : validSecret(file.sessionSecret) ? file.sessionSecret : "",
    appUrl: process.env.APP_URL || file.appUrl || "",
    /** آیا دیتابیس از متغیر محیطی آمده؟ (در این حالت مرحله‌ی دیتابیس در نصب‌کننده رد می‌شود) */
    databaseFromEnv: !!process.env.DATABASE_URL,
    secretFromEnv: validSecret(process.env.SESSION_SECRET),
  };
}

/**
 * آدرس پایه‌ی مورد اعتماد (APP_URL محیط یا آدرس ثبت‌شده توسط نصب‌کننده).
 * لینک‌های حساس (بازیابی رمز، تأیید ایمیل، دعوت‌نامه) باید از این ساخته شوند، نه از هدر Host که مهاجم می‌تواند جعل کند.
 * اگر مقداری تنظیم نشده باشد رشته‌ی خالی برمی‌گردد.
 */
export function trustedAppOrigin(): string {
  const fixed = (getConfig().appUrl || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[A-Za-z0-9.\-:]+$/.test(fixed) ? fixed : "";
}

export function writeConfig(patch: FileConfig): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const next = { ...readFileConfig(), ...patch };
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  cached = null;
}

export function hasInstallLock(): boolean {
  try {
    return fs.existsSync(LOCK_FILE);
  } catch {
    return false;
  }
}

export function writeInstallLock(): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, `installed:${new Date().toISOString()}\n`, { mode: 0o600 });
}

export function storageWritable(): boolean {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const probe = path.join(STORAGE_DIR, `.probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
