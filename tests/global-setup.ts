import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { SCHEMA_ALTER, SCHEMA_CREATE } from "../src/modules/install/schema-sql";

/** قبل از همه‌ی آزمون‌ها: دیتابیس آزمایشی را (اگر نبود) می‌سازد، تمیز و با ساختار فعلی پر می‌کند */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL!;
  const u = new URL(url);
  const dbName = decodeURIComponent(u.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(dbName) || !/test/i.test(dbName)) throw new Error(`نام دیتابیس آزمایشی باید شامل «test» باشد: ${dbName}`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const a = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    const exists = await a.query("select 1 from pg_database where datname = $1", [dbName]);
    if (exists.rowCount === 0) await a.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await a.end();
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    for (const st of SCHEMA_CREATE) await pool.query(st);
    for (const st of SCHEMA_ALTER) await pool.query(st).catch(() => undefined);
  } finally {
    await pool.end();
  }
  const storage = path.resolve(process.cwd(), ".test-storage");
  fs.rmSync(storage, { recursive: true, force: true });
  fs.mkdirSync(storage, { recursive: true });
}
