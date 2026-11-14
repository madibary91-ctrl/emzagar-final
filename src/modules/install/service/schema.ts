import { SCHEMA_PLAN } from "../schema-sql";
import { expectedColumns } from "@/db/ddl";
import { getPool } from "@/db";

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
/**
 * تعمیر داده «پیش از» ساخت ایندکس‌های یکتای تازه، تا ارتقا هرگز به‌خاطر داده‌ی قدیمی شکست نخورد (fail-closed بالا آمدن برنامه را متوقف می‌کند).
 * فاز ۱ پیش از وجود ایندکس یکتای templates(workspace_id, library_key) منتشر شده؛ اگر در یک نصب زنده دو کلیکِ هم‌زمان
 * «افزودن به قالب‌های من» کپی تکراری ساخته باشد، ایندکس ساخته نمی‌شد. کپی‌های اضافه «حذف» نمی‌شوند (ممکن است ویرایش شده باشند)؛
 * فقط برچسب کتابخانه‌شان برداشته می‌شود و قالب دست‌ساز می‌مانند. فقط یک‌بار (تا وقتی ایندکس نیست) اجرا می‌شود.
 */
export const PRE_INDEX_FIXES: string[] = [
  `DO $emz$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'templates_ws_library_key_uq') THEN
       UPDATE templates t SET library_key = NULL
        WHERE t.library_key IS NOT NULL
          AND t.id <> (SELECT min(t2.id) FROM templates t2 WHERE t2.workspace_id = t.workspace_id AND t2.library_key = t.library_key);
     END IF;
   END $emz$`,
];
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
      for (const st of [...SCHEMA_PLAN.extensions, ...SCHEMA_PLAN.tables, ...SCHEMA_PLAN.columns, ...PRE_INDEX_FIXES, ...SCHEMA_PLAN.indexes, ...SCHEMA_PLAN.foreignKeys]) {
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
