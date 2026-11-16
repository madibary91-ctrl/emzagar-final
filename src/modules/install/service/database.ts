import { Pool } from "pg";
import crypto from "node:crypto";
import { getConfig, writeConfig } from "@/lib/config";

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
