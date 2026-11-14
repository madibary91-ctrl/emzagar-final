import { STORAGE_DIR } from "@/lib/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ───────── کلید نصب (CR-03) ─────────
 * قبلاً اگر INSTALL_KEY تنظیم نمی‌شد، «اولین بازدیدکننده‌ی اینترنت» مدیر کل می‌شد (مثل نصب‌کننده‌ی وردپرس، ولی با
 * دسترسی کامل به پلتفرم). اکنون نصب‌کننده همیشه «اثبات مالکیت سرور» می‌خواهد:
 *   • INSTALL_KEY در محیط (Docker/VPS) ← همان کلید.
 *   • وگرنه یک کلید تصادفی ۱۴۴ بیتی در storage/install-key.txt (مجوز 0600) ساخته و در لاگ سرور چاپ می‌شود؛
 *     فقط کسی که به فایل‌های هاست یا لاگ سرور دسترسی دارد (یعنی مالک) آن را می‌بیند. پس از پایان نصب حذف می‌شود.
 *   • INSTALL_OPEN=1: انصراف صریح و آگاهانه (فقط برای CI/آزمون محلی).
 */
const KEY_FILE = path.join(STORAGE_DIR, "install-key.txt");
let memKey: string | null = null;
let openWarned = false;
export type InstallKeySource = "env" | "file" | "open";
export function installKeySource(): InstallKeySource {
  if (process.env.INSTALL_KEY) return "env";
  if (process.env.INSTALL_OPEN === "1") return "open";
  return "file";
}
export const INSTALL_KEY_FILE = KEY_FILE;
function readKeyFile(): string | null {
  try {
    const k = fs.readFileSync(KEY_FILE, "utf8").trim();
    return k.length >= 16 ? k : null;
  } catch {
    return null;
  }
}
function announceKey(key: string, where: string) {
  console.warn(`\n[install] ⚠ کلید نصب (برای باز کردن /install لازم است): ${key}\n[install]   ${where}\n`);
}
/** کلید فایل را (اگر نبود) می‌سازد؛ هم‌زمانیِ چند درخواست با فلگ "wx" بی‌خطر است */
function ensureFileKey(): string {
  const existing = readKeyFile();
  if (existing) return existing;
  if (memKey) return memKey;
  const key = crypto.randomBytes(18).toString("base64url");
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600, flag: "wx" });
    announceKey(key, `ذخیره‌شده در ${KEY_FILE}`);
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return readKeyFile() ?? key;
    memKey = key; // storage قابل‌نوشتن نیست؛ کلید فقط در حافظه‌ی همین پردازه و لاگ می‌ماند (باز هم بسته است)
    announceKey(key, "فقط در حافظه‌ی سرور (پوشه‌ی storage قابل نوشتن نیست)");
    return key;
  }
}
function requiredKey(): string | null {
  const src = installKeySource();
  if (src === "env") return process.env.INSTALL_KEY!;
  if (src === "open") {
    if (!openWarned) {
      openWarned = true;
      console.warn("[install] ⚠ INSTALL_OPEN=1: نصب‌کننده بدون کلید باز است؛ فقط برای آزمون محلی/CI.");
    }
    return null;
  }
  return ensureFileKey();
}
export function discardInstallKey() {
  memKey = null;
  try {
    fs.unlinkSync(KEY_FILE);
  } catch {
    /* وجود نداشت */
  }
}
/** ساخت کلید (در صورت نیاز) بدون افشای آن؛ هنگام نمایش صفحه‌ی نصب فراخوانی می‌شود تا مالک کلید را در فایل/لاگ ببیند */
export function prepareInstallKey(): void {
  requiredKey();
}
// شمارش سراسری کلید غلط: حتی با هزاران IP هم نمی‌توان کلید را حدس زد (۲۰ تلاش ناموفق در ۱۵ دقیقه ← قفل موقت)
const KEY_FAIL_MAX = 20;
const KEY_FAIL_WINDOW = 15 * 60_000;
let keyFails = { n: 0, reset: 0 };
export function keyAttemptsLocked(): boolean {
  return Date.now() < keyFails.reset && keyFails.n >= KEY_FAIL_MAX;
}
export function recordKeyFailure(): void {
  const now = Date.now();
  keyFails = now >= keyFails.reset ? { n: 1, reset: now + KEY_FAIL_WINDOW } : { n: keyFails.n + 1, reset: keyFails.reset };
}
/** فقط برای آزمون */
export function __resetKeyFailures(): void {
  keyFails = { n: 0, reset: 0 };
}
export function keyMatches(given: string | undefined): boolean {
  const required = requiredKey();
  if (required === null) return true;
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(required).digest();
  return crypto.timingSafeEqual(a, b);
}
