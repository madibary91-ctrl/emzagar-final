import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { getConfig, hasInstallLock, STORAGE_DIR, storageWritable, writeConfig, writeInstallLock } from "@/lib/config";
import { db, getPool, withTransaction } from "@/db";
import { users } from "@/db/schema";
import { hashPasswordAsync } from "@/lib/password";
import { createWorkspace, EMAIL_RE } from "@/modules/tenancy/service";
import { saveSettings } from "@/modules/settings/service";
import { ensureLandingDefaults } from "@/modules/landing/service";
import { SCHEMA_PLAN } from "./schema-sql";
import { expectedColumns } from "@/db/ddl";

/* ───────── وضعیت نصب ───────── */
let installedMemo = false;

/**
 * وضعیت سه‌حالته (CR-03):
 *  - installed: قفل نصب هست یا دست‌کم یک کاربر در دیتابیس است.
 *  - fresh:     «به‌اثبات رسیده» که هنوز نصب نشده (آدرس دیتابیسی نیست، یا دیتابیس وصل است و جدول/کاربری ندارد).
 *  - unknown:   دیتابیس پیکربندی شده ولی نمی‌توان وضعیتش را خواند (قطعی، خطای دسترسی، …).
 *
 * قبلاً «unknown» هم مثل «fresh» رفتار می‌شد؛ یعنی با قطع موقت دیتابیس (و نبود lock-file) هر بازدیدکننده می‌توانست
 * نصب‌کننده را باز کند و حتی آدرس دیتابیس را بازنویسی کند. اکنون «نمی‌دانم» = «بسته» (fail-closed).
 */
export type InstallState = "installed" | "fresh" | "unknown";

/** خطای «جدول وجود ندارد» (42P01) یعنی دیتابیس وصل است ولی هنوز نصب نشده؛ drizzle خطای pg را در cause می‌پیچد */
function isUndefinedTable(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    if ((cur as { code?: string }).code === "42P01") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function getInstallState(): Promise<InstallState> {
  if (installedMemo) return "installed";
  if (hasInstallLock()) {
    installedMemo = true;
    discardInstallKey();
    return "installed";
  }
  if (!getConfig().databaseUrl) return "fresh";
  try {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    if (row && row.n > 0) {
      try {
        writeInstallLock();
      } catch {
        /* حتی اگر قفل نوشته نشد، نصب‌شده است */
      }
      installedMemo = true;
      discardInstallKey();
      return "installed";
    }
    return "fresh";
  } catch (e) {
    return isUndefinedTable(e) ? "fresh" : "unknown";
  }
}

/** نصب‌شده = قفل نصب وجود دارد، یا دست‌کم یک کاربر در دیتابیس هست (سازگار با نصب‌های قدیمی) */
export async function isInstalled(): Promise<boolean> {
  return (await getInstallState()) === "installed";
}

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

function discardInstallKey() {
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

export type InstallStatus = {
  installed: boolean;
  nodeOk: boolean;
  nodeVersion: string;
  storageOk: boolean;
  databaseFromEnv: boolean;
  databaseConnected: boolean;
  keyRequired: boolean;
  keySource: InstallKeySource;
  /** دیتابیس پیکربندی شده ولی وضعیتش خوانده نشد؛ برای امنیت نصب بسته است */
  stateUnknown: boolean;
  https: boolean;
};

export async function getInstallStatus(https: boolean): Promise<InstallStatus> {
  const state = await getInstallState();
  const installed = state === "installed";
  const cfg = getConfig();
  if (state === "fresh") prepareInstallKey();
  let databaseConnected = false;
  if (cfg.databaseUrl) {
    try {
      await db.execute(sql`select 1`);
      databaseConnected = true;
    } catch {
      databaseConnected = false;
    }
  }
  const major = Number(process.versions.node.split(".")[0]);
  return {
    installed,
    nodeOk: major >= 20,
    nodeVersion: process.versions.node,
    storageOk: storageWritable(),
    databaseFromEnv: cfg.databaseFromEnv,
    databaseConnected,
    keyRequired: installKeySource() !== "open",
    keySource: installKeySource(),
    stateUnknown: state === "unknown",
    https,
  };
}

export function keyMatches(given: string | undefined): boolean {
  const required = requiredKey();
  if (required === null) return true;
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(required).digest();
  return crypto.timingSafeEqual(a, b);
}

/* ───────── دیتابیس ───────── */
export type DbInput =
  | { mode: "simple"; host: string; port: string; name: string; user: string; password: string; ssl: boolean }
  | { mode: "url"; url: string };

/** ساخت آدرس اتصال از فیلدهای ساده‌ی فرم (کاراکترهای خاص رمز به‌درستی کدگذاری می‌شوند) */
export function buildDatabaseUrl(input: DbInput): { url?: string; error?: string } {
  if (input.mode === "url") {
    const url = input.url.trim();
    if (!/^postgres(ql)?:\/\/[^\s]+$/i.test(url)) return { error: "آدرس اتصال باید با postgresql:// شروع شود." };
    return { url };
  }
  const host = input.host.trim() || "localhost";
  const port = Number(input.port || "5432");
  const name = input.name.trim();
  const user = input.user.trim();
  if (!/^[A-Za-z0-9.\-_]+$/.test(host)) return { error: "آدرس سرور (Host) نامعتبر است." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "پورت باید عددی بین ۱ تا ۶۵۵۳۵ باشد." };
  if (!/^[A-Za-z0-9_\-]{1,63}$/.test(name)) return { error: "نام دیتابیس فقط می‌تواند شامل حروف انگلیسی، عدد، خط تیره و زیرخط باشد." };
  if (!user) return { error: "نام کاربری دیتابیس را وارد کنید." };
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(input.password)}`;
  return { url: `postgresql://${auth}@${host}:${port}/${name}${input.ssl ? "?sslmode=no-verify" : ""}` };
}

/** ترجمه‌ی خطاهای فنی PostgreSQL به راهنمای قابل‌فهم برای کاربر مبتدی */
export function describeDbError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const code = err?.code ?? "";
  const msg = String(err?.message ?? "");
  if (code === "ECONNREFUSED") return "اتصال برقرار نشد: سرور دیتابیس روی این آدرس و پورت پاسخ نمی‌دهد. «آدرس سرور» و «پورت» را بررسی کنید (در بیشتر هاست‌ها localhost و پورت ۵۴۳۲ است).";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "آدرس سرور دیتابیس پیدا نشد. نوشتار «آدرس سرور» را بررسی کنید.";
  if (code === "ETIMEDOUT" || /timeout/i.test(msg)) return "مهلت اتصال تمام شد. احتمالاً فایروال راه را بسته یا آدرس سرور درست نیست.";
  if (code === "28P01" || code === "28000") return "نام کاربری یا رمز عبور دیتابیس اشتباه است.";
  if (code === "3D000") return "دیتابیسی با این نام وجود ندارد.";
  if (code === "42501") return "این کاربر دسترسی کافی برای ساخت جدول در دیتابیس ندارد. در پنل هاست همه‌ی دسترسی‌ها (ALL PRIVILEGES) را به کاربر بدهید.";
  if (/SSL/i.test(msg)) return "سرور دیتابیس اتصال امن (SSL) می‌خواهد. گزینه‌ی «اتصال امن SSL» را روشن کنید.";
  if (code === "ECONNRESET") return "اتصال توسط سرور قطع شد. اگر سرور SSL می‌خواهد گزینه‌ی «اتصال امن SSL» را روشن کنید.";
  return "اتصال به دیتابیس ممکن نشد. اطلاعات واردشده را دوباره بررسی کنید.";
}

async function tryConnect(url: string): Promise<void> {
  const p = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 8000 });
  p.on("error", () => undefined);
  try {
    await p.query("select 1");
  } finally {
    await p.end().catch(() => undefined);
  }
}

/** اتصال را می‌آزماید؛ اگر دیتابیس وجود نداشت و کاربر اجازه داشت، خودش می‌سازد */
export async function testDatabase(url: string): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  try {
    await tryConnect(url);
    return { ok: true, created: false };
  } catch (e) {
    if ((e as { code?: string }).code !== "3D000") return { ok: false, error: describeDbError(e) };
    try {
      const u = new URL(url);
      const dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
      if (!/^[A-Za-z0-9_\-]{1,63}$/.test(dbName)) return { ok: false, error: describeDbError(e) };
      u.pathname = "/postgres";
      const admin = new Pool({ connectionString: u.toString(), max: 1, connectionTimeoutMillis: 8000 });
      admin.on("error", () => undefined);
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end().catch(() => undefined);
      }
      await tryConnect(url);
      return { ok: true, created: true };
    } catch {
      return { ok: false, error: "دیتابیس وجود ندارد و ساخت خودکار آن هم ممکن نشد. آن را در پنل هاست (بخش PostgreSQL) بسازید و دوباره امتحان کنید." };
    }
  }
}

/** ذخیره‌ی آدرس دیتابیس + ساخت کلید امنیتی تصادفی (فقط اگر هنوز وجود ندارد) */
export function persistConfig(opts: { databaseUrl?: string; appUrl?: string }): void {
  const cfg = getConfig();
  const patch: Parameters<typeof writeConfig>[0] = {};
  if (opts.databaseUrl && !cfg.databaseFromEnv) patch.databaseUrl = opts.databaseUrl;
  if (!cfg.sessionSecret) patch.sessionSecret = crypto.randomBytes(48).toString("base64url");
  if (opts.appUrl) patch.appUrl = opts.appUrl;
  writeConfig(patch);
}

export class SchemaApplyError extends Error {
  constructor(readonly statement: string, readonly cause: unknown) {
    super(`SCHEMA_APPLY_FAILED: ${cause instanceof Error ? cause.message : String(cause)} — ${statement.replace(/\s+/g, " ").slice(0, 160)}`);
    this.name = "SchemaApplyError";
  }
}

/** جدول/ستون‌هایی که schema.ts می‌خواهد ولی در دیتابیس نیستند */
export async function missingSchemaObjects(client: { query: (q: string) => Promise<{ rows: Record<string, string>[] }> }): Promise<string[]> {
  const have = new Set((await client.query("select table_name as t, column_name as c from information_schema.columns where table_schema = current_schema()")).rows.map((r) => `${r.t}.${r.c}`));
  return expectedColumns().filter((c) => !have.has(`${c.table}.${c.column}`)).map((c) => `${c.table}.${c.column}`);
}

/** ساخت همه‌ی جدول‌ها (idempotent: اجرای دوباره بی‌خطر است) */
export async function applySchema(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(727001)");
    // ارتقا از نسخه‌ی بدون «تأیید ایمیل»: حساب‌های موجود پیش از این قابلیت ساخته شده‌اند و نباید قفل شوند
    const hadUsersTable = (await client.query("select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'users'")).rowCount! > 0;
    const hadVerifyColumn =
      (await client.query("select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'users' and column_name = 'email_verified_at'")).rowCount! > 0;
    const hadPaymentsTable = (await client.query("select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'payments'")).rowCount! > 0;
    const hadFulfilledColumn =
      (await client.query("select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'payments' and column_name = 'fulfilled_at'")).rowCount! > 0;
    // DB-05: ارتقا در یک تراکنش و به ترتیب امن: افزونه‌ها ← جدول‌ها ← ستون‌های جدید ← ایندکس‌ها ← Foreign Keyها.
    // هر خطا کل مرحله را برمی‌گرداند و بالا می‌اندازد (پیش‌تر ALTERهای ناموفق بی‌صدا رد می‌شدند و برنامه با schema ناقص بالا می‌آمد).
    try {
      await client.query("BEGIN");
      for (const st of [...SCHEMA_PLAN.extensions, ...SCHEMA_PLAN.tables, ...SCHEMA_PLAN.columns, ...SCHEMA_PLAN.indexes, ...SCHEMA_PLAN.foreignKeys]) {
        try {
          await client.query(st);
        } catch (e) {
          throw new SchemaApplyError(st, e);
        }
      }
      // تأیید نهایی: هر جدول/ستون مورد انتظار schema.ts باید واقعاً وجود داشته باشد
      const missing = await missingSchemaObjects(client);
      if (missing.length) throw new SchemaApplyError(`verify: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " …" : ""}`, new Error("ساختار دیتابیس پس از ارتقا ناقص است"));
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
    if (hadPaymentsTable && !hadFulfilledColumn) {
      // ارتقا از نسخه‌ی بدون ستون fulfilled_at: پرداخت‌های paid قدیمی قبلاً اعمال شده‌اند و نباید دوباره اعمال (تمدید) شوند.
      // تنها استثنا: شارژ کیف پول paid که ردیفی در دفتر کل ندارد (اعمال نیمه‌کاره)؛ شارژ با کلید یکتای ref ایدمپوتنت است، پس زمان‌بند آن را ترمیم می‌کند.
      await client.query(
        `update payments p set fulfilled_at = coalesce(p.paid_at, p.created_at)
         where p.status = 'paid' and p.fulfilled_at is null
           and not (p.kind = 'topup' and p.gateway <> 'wallet' and not exists (select 1 from wallet_transactions w where w.ref = 'topup:' || p.id))`,
      );
    }
    if (hadUsersTable && !hadVerifyColumn) {
      await client.query("update users set email_verified_at = created_at where email_verified_at is null");
    }
  } finally {
    await client.query("select pg_advisory_unlock(727001)").catch(() => undefined);
    client.release();
  }
}

/* ───────── حساب مدیر ───────── */
export type AccountInput = { siteName: string; name: string; email: string; mobile: string; password: string };

export function passwordProblem(p: string): string | null {
  if (p.length < 8) return "رمز عبور باید حداقل ۸ نویسه باشد.";
  if (!/[A-Za-z\u0600-\u06FF]/.test(p) || !/\d/.test(p)) return "رمز عبور باید ترکیبی از حروف و عدد باشد.";
  return null;
}

export function validateAccount(a: AccountInput): string | null {
  if (!a.siteName.trim()) return "نام سایت یا کسب‌وکار را وارد کنید.";
  if (!a.name.trim()) return "نام و نام‌خانوادگی را وارد کنید.";
  if (!EMAIL_RE.test(a.email.trim())) return "ایمیل معتبر نیست.";
  if (!/^09\d{9}$/.test(a.mobile.trim())) return "موبایل باید به‌صورت 09xxxxxxxxx باشد.";
  return passwordProblem(a.password);
}

/**
 * ساخت مدیر کل + فضای کاری اصلی + تنظیمات و صفحه‌ی فرود پیش‌فرض؛ با قفل دیتابیس، فقط یک نصب هم‌زمان می‌تواند موفق شود.
 *
 * اتمی: همه‌ی مراحل در «یک» تراکنش‌اند. اگر هر مرحله (مثلاً ساخت فضای کاری) خطا بدهد، مدیر هم ساخته نمی‌شود؛
 * در نتیجه سامانه هرگز در حالت «مدیر بدون فضای کاری» که نصب را برای همیشه قفل می‌کند (چون کاربر وجود دارد) نمی‌ماند
 * و کاربر می‌تواند نصب را دوباره امتحان کند. قفل مشاوره‌ای تا بعد از commit نگه داشته می‌شود.
 */
export async function createFirstAdmin(a: AccountInput): Promise<{ userId: number; passwordHash: string; workspaceId: number } | null> {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(727002)");
    const passwordHash = await hashPasswordAsync(a.password);
    return await withTransaction(async () => {
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
      if (n > 0) return null;
      const [user] = await db
        .insert(users)
        .values({ name: a.name.trim().slice(0, 100), email: a.email.trim().toLowerCase(), mobile: a.mobile.trim(), passwordHash, role: "admin", emailVerifiedAt: new Date() })
        .returning();
      const workspaceId = await createWorkspace(user.id, a.siteName.trim());
      await saveSettings({ site_name: a.siteName.trim().slice(0, 40), admin_email: user.email }, workspaceId);
      await ensureLandingDefaults(a.siteName.trim());
      return { userId: user.id, passwordHash, workspaceId };
    });
  } finally {
    await client.query("select pg_advisory_unlock(727002)").catch(() => undefined);
    client.release();
  }
}

export function finalizeInstall(): void {
  writeInstallLock();
  installedMemo = true;
  discardInstallKey();
}
