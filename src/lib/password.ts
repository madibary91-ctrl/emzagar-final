import crypto from "node:crypto";

/**
 * هش رمز عبور (scrypt، قالب `salt:hash`).
 *
 * PERF-01: scryptSync با N=16384 حدود ۵۰–۱۵۰ms کل حلقه‌ی رویداد Node را قفل می‌کرد.
 * مسیرهای درخواست (ورود، ثبت‌نام، بازنشانی رمز، باز کردن لینک) اکنون فقط از نسخه‌های ناهمگام
 * (`hashPasswordAsync` / `verifyPasswordAsync`) استفاده می‌کنند که محاسبه را به threadpool ی libuv می‌سپارند
 * و حلقه‌ی اصلی آزاد می‌ماند. هر دو نسخه یک قالب و پارامتر دارند و هش‌های موجود بدون مهاجرت معتبرند.
 *
 * نسخه‌های همگام (`hashPassword` / `verifyPassword`) فقط برای اسکریپت‌ها، seed و آزمون‌ها نگه داشته شده‌اند
 * و نباید در مسیر درخواست‌های وب فراخوانی شوند.
 */
const KEYLEN = 64;
const SALT_BYTES = 16;

/** حداکثر محاسبه‌ی هم‌زمان scrypt: threadpool پیش‌فرض ۴ رشته دارد و باید برای fs/dns/zlib هم جا بماند */
const MAX_CONCURRENT = Math.max(1, Math.min(Number(process.env.PASSWORD_HASH_CONCURRENCY) || 2, 8));
/** سقف صف انتظار؛ بیش از آن «شلوغ» گزارش می‌شود تا حافظه با هجوم درخواست پر نشود */
const MAX_QUEUE = 512;

export class PasswordBusyError extends Error {
  constructor() {
    super("PASSWORD_HASH_BUSY");
    this.name = "PasswordBusyError";
  }
}

let running = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  if (waiting.length >= MAX_QUEUE) throw new PasswordBusyError();
  // انتقال مستقیم اسلات از release به نفر بعدی (running ثابت می‌ماند)
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function derive(password: string, salt: string): Promise<Buffer> {
  await acquire();
  try {
    return await scryptAsync(password, salt);
  } finally {
    release();
  }
}

function matches(hash: string, test: Buffer): boolean {
  const orig = Buffer.from(hash, "hex");
  return orig.length === test.length && crypto.timingSafeEqual(orig, test);
}

/** هش ناهمگام (بدون مسدود کردن حلقه‌ی رویداد) */
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const hash = await derive(password, salt);
  return `${salt}:${hash.toString("hex")}`;
}

/** راستی‌آزمایی ناهمگام (زمان‌ثابت، بدون مسدود کردن حلقه‌ی رویداد) */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return matches(hash, await derive(password, salt));
}

/**
 * هش «غیرقابل‌استفاده» برای حساب‌هایی که با رمز وارد نمی‌شوند (مشتری نمونه، حساب ساخته‌شده توسط اتصال وردپرس، …).
 * قالبش با هش واقعی یکی است ولی مقدار آن تصادفی و بی‌پیش‌تصویر است؛ پس هیچ رمزی با آن نمی‌خواند
 * و برای ساختنش هیچ هزینه‌ی CPU (scrypt) لازم نیست.
 */
export function unusablePasswordHash(): string {
  return `${crypto.randomBytes(SALT_BYTES).toString("hex")}:${crypto.randomBytes(KEYLEN).toString("hex")}`;
}

/** @deprecated فقط اسکریپت/seed/آزمون؛ در مسیر درخواست وب از hashPasswordAsync استفاده کنید */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

/** @deprecated فقط اسکریپت/seed/آزمون؛ در مسیر درخواست وب از verifyPasswordAsync استفاده کنید */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  return matches(hash, crypto.scryptSync(password, salt, KEYLEN));
}

export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
