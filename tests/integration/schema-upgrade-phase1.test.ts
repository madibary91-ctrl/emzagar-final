import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";
import { applySchema } from "@/modules/install/service";

/**
 * سناریوی «خریداری که از قبل نصب دارد»: روی یک دیتابیس جداگانه، ساختار «پیش از فاز ۱» ساخته می‌شود
 * (بدون users.is_guest، templates.library_key و ایندکس یکتای قالب کتابخانه) و داده‌ی واقعی در آن ریخته می‌شود؛
 * سپس همان `applySchema` که هنگام بالا آمدن برنامه اجرا می‌شود، اجرا و داده‌ها بررسی می‌شوند.
 */
const base = new URL(process.env.TEST_DATABASE_URL!);
const DB = "emz_test_upgrade";
const url = new URL(base.toString());
url.pathname = `/${DB}`;
let pool: Pool;
let prevUrl: string | undefined;

const cols = async (t: string) => (await pool.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1", [t])).rows.map((r) => r.column_name as string);

beforeAll(async () => {
  const admin = new Pool({ connectionString: new URL("/postgres", base).toString(), max: 1 });
  try {
    if ((await admin.query("select 1 from pg_database where datname=$1", [DB])).rowCount === 0) await admin.query(`CREATE DATABASE "${DB}"`);
  } finally {
    await admin.end();
  }
  pool = new Pool({ connectionString: url.toString(), max: 2 });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  for (const st of SCHEMA_CREATE) await pool.query(st);
  // «پسرفت» به نسخه‌ی پیش از فاز ۱
  await pool.query("DROP INDEX IF EXISTS templates_ws_library_key_uq");
  await pool.query("ALTER TABLE users DROP COLUMN is_guest");
  await pool.query("ALTER TABLE templates DROP COLUMN library_key");
  // داده‌ی واقعی نصب قدیمی
  await pool.query("insert into users (name,email,mobile,password_hash,role,email_verified_at) values ('مدیر قدیمی','old-admin@example.com','09120000001','x','user',now()),('مشتری قدیمی','old-client@example.com','09120000002','x','user',now())");
  await pool.query("insert into workspaces (name,slug,owner_id) values ('فضای قدیمی','old-ws',(select id from users where email='old-admin@example.com'))");
  await pool.query("insert into workspace_members (workspace_id,user_id,role) select w.id,u.id,case when u.email like 'old-admin%' then 'owner' else 'client' end from workspaces w, users u");
  await pool.query("insert into templates (workspace_id,title,body) select id,'قالب قدیمی ۱','<p>متن</p>' from workspaces union all select id,'قالب قدیمی ۲','<p>متن ۲</p>' from workspaces");
  prevUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString(); // getPool() به دیتابیس موقت سوئیچ می‌کند
});

afterAll(async () => {
  process.env.DATABASE_URL = prevUrl;
  await pool?.end();
});

describe("ارتقای نصب موجود به فاز ۱ (users.is_guest، templates.library_key)", () => {
  it("پیش‌شرط: ساختار قدیمی واقعاً ستون‌های جدید را ندارد", async () => {
    expect(await cols("users")).not.toContain("is_guest");
    expect(await cols("templates")).not.toContain("library_key");
  });

  it("applySchema ستون‌ها را اضافه می‌کند؛ داده‌ی قبلی دست‌نخورده و کاربران قدیمی «مهمان نیستند»", async () => {
    await applySchema();
    expect(await cols("users")).toContain("is_guest");
    expect(await cols("templates")).toContain("library_key");

    const users = (await pool.query("select email,is_guest,email_verified_at from users order by id")).rows;
    expect(users).toHaveLength(2);
    for (const u of users) {
      expect(u.is_guest).toBe(false); // مقدار پیش‌فرض: هیچ حساب قدیمی مهمان حساب نمی‌شود
      expect(u.email_verified_at).not.toBeNull(); // حساب‌های قدیمی قفل نمی‌شوند
    }
    const tpls = (await pool.query("select title,library_key from templates order by id")).rows;
    expect(tpls.map((t) => t.title)).toEqual(["قالب قدیمی ۱", "قالب قدیمی ۲"]);
    expect(tpls.every((t) => t.library_key === null)).toBe(true);
    const members = (await pool.query("select role from workspace_members order by id")).rows.map((r) => r.role);
    expect(members).toEqual(["owner", "client"]);
  });

  it("ایندکس یکتای قالب کتابخانه ساخته می‌شود و ستون is_guest قیود NOT NULL/DEFAULT درست دارد", async () => {
    expect((await pool.query("select 1 from pg_indexes where indexname='templates_ws_library_key_uq'")).rowCount).toBe(1);
    const c = (await pool.query("select is_nullable, column_default from information_schema.columns where table_name='users' and column_name='is_guest'")).rows[0];
    expect(c.is_nullable).toBe("NO");
    expect(String(c.column_default)).toContain("false");
  });

  it("اجرای دوباره (ری‌استارت‌های بعدی) ایدمپوتنت است", async () => {
    await applySchema();
    await applySchema();
    expect((await pool.query("select count(*)::int n from users")).rows[0].n).toBe(2);
  });

  it("نصب زنده‌ی فاز ۱ که پیش از ایندکس یکتا کپی تکراری قالب ساخته: ارتقا شکست نمی‌خورد، هیچ قالبی حذف نمی‌شود، فقط برچسب تکراری برداشته می‌شود", async () => {
    await pool.query("DROP INDEX templates_ws_library_key_uq");
    await pool.query("insert into templates (workspace_id,title,body,library_key) select id,'کپی ۱','<p>a</p>','rent-residential' from workspaces");
    await pool.query("insert into templates (workspace_id,title,body,library_key) select id,'کپی ۲ (ویرایش‌شده)','<p>b</p>','rent-residential' from workspaces");
    await pool.query("insert into templates (workspace_id,title,body,library_key) select id,'کپی ۳','<p>c</p>','rent-residential' from workspaces");
    const before = (await pool.query("select count(*)::int n from templates")).rows[0].n;

    await expect(applySchema()).resolves.toBeUndefined();

    expect((await pool.query("select count(*)::int n from templates")).rows[0].n).toBe(before);
    const lib = (await pool.query("select title from templates where library_key='rent-residential'")).rows;
    expect(lib.map((r) => r.title)).toEqual(["کپی ۱"]); // قدیمی‌ترین نگه داشته می‌شود
    const orphaned = (await pool.query("select title from templates where title like 'کپی ۲%' or title like 'کپی ۳%'")).rows;
    expect(orphaned).toHaveLength(2); // حذف نشده‌اند؛ قالب دست‌ساز شده‌اند
    expect((await pool.query("select 1 from pg_indexes where indexname='templates_ws_library_key_uq'")).rowCount).toBe(1);
    // و ایندکس حالا واقعاً تکرار را رد می‌کند
    await expect(pool.query("insert into templates (workspace_id,title,body,library_key) select id,'تکراری','<p/>','rent-residential' from workspaces")).rejects.toThrow(/templates_ws_library_key_uq|unique/i);
  });
});
