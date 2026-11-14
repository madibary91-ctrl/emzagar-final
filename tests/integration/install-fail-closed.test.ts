import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { STORAGE_DIR, writeConfig } from "@/lib/config";
import { installAccountAction, installDatabaseAction, testDatabaseAction } from "@/modules/install/actions";
import { getInstallState, getInstallStatus, INSTALL_KEY_FILE } from "@/modules/install/service";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";

/**
 * CR-03 (بخش دوم، فایل جدا چون وضعیت «نصب‌شده» در حافظه‌ی پردازه می‌ماند):
 * «در شرایط خاص (قطع DB و نبود lock-file) آدرس دیتابیس هم قابل بازنویسی است.» ← اکنون وضعیت نامعلوم = بسته.
 */
const ISO = "emz_test_install_cr03b";
const base = new URL(process.env.TEST_DATABASE_URL!);
const urlOf = (name: string) => {
  const u = new URL(base.toString());
  u.pathname = `/${name}`;
  return u.toString();
};
const savedUrl = process.env.DATABASE_URL;
const CONFIG_FILE = path.join(STORAGE_DIR, "config.json");
const LOCK_FILE = path.join(STORAGE_DIR, "installed.lock");
const DEAD_URL = "postgresql://postgres:postgres@127.0.0.1:1/ghost"; // پورتی که کسی روی آن گوش نمی‌دهد
const HOSTILE = { mode: "url" as const, url: "postgresql://attacker:pw@evil.example.net:5432/loot" };
const account = { siteName: "سایت من", name: "مالک سرور", email: "owner@example.com", mobile: "09120000000", password: "Passw0rdX9" };
const clean = () => {
  for (const f of [CONFIG_FILE, LOCK_FILE, INSTALL_KEY_FILE]) fs.rmSync(f, { force: true });
};

let iso: Pool;
const admin = () => new Pool({ connectionString: urlOf("postgres"), max: 1 });

beforeAll(async () => {
  const a = admin();
  try {
    await a.query(`DROP DATABASE IF EXISTS "${ISO}" WITH (FORCE)`);
    await a.query(`CREATE DATABASE "${ISO}"`);
  } finally {
    await a.end();
  }
  iso = new Pool({ connectionString: urlOf(ISO), max: 2 });
  for (const st of SCHEMA_CREATE) await iso.query(st);
  clean();
});

afterAll(async () => {
  process.env.DATABASE_URL = savedUrl;
  delete process.env.INSTALL_OPEN;
  await db.execute(sql`select 1`);
  await iso.end();
  const a = admin();
  await a.query(`DROP DATABASE IF EXISTS "${ISO}" WITH (FORCE)`).catch(() => undefined);
  await a.end();
  clean();
});

describe("CR-03: قطع دیتابیس + نبود lock-file دیگر آدرس دیتابیس را قابل بازنویسی نمی‌کند", () => {
  it("دیتابیس پیکربندی‌شده ولی در دسترس نیست ← وضعیت «نامعلوم» ← نصب‌کننده بسته (حتی با کلید درست)", async () => {
    clean();
    // نصب‌شده‌ی واقعی با فایل پیکربندی (بدون DATABASE_URL محیطی) که دیتابیسش موقتاً قطع است
    process.env.DATABASE_URL = "";
    writeConfig({ databaseUrl: DEAD_URL, sessionSecret: "s".repeat(40) });
    const before = fs.readFileSync(CONFIG_FILE, "utf8");
    expect(fs.existsSync(LOCK_FILE)).toBe(false);

    expect(await getInstallState()).toBe("unknown");
    const st = await getInstallStatus(true);
    expect(st.installed).toBe(false);
    expect(st.stateUnknown).toBe(true);

    // مهاجم بدون کلید، و حتی مالک با کلید درست، تا برگشتن دیتابیس نمی‌تواند چیزی بنویسد
    const keyAttempts = [undefined, "x", "emz-anything"];
    for (const k of keyAttempts) {
      expect((await installDatabaseAction(HOSTILE, k)).ok).toBe(false);
      expect((await testDatabaseAction(HOSTILE, k)).ok).toBe(false);
      expect((await installAccountAction(account, k)).ok).toBe(false);
    }
    process.env.INSTALL_OPEN = "1"; // حتی حالت باز هم در وضعیت نامعلوم بسته می‌ماند
    const open = await installDatabaseAction(HOSTILE, undefined);
    expect(open.ok).toBe(false);
    expect(open.error).toMatch(/دیتابیس/);

    expect(fs.readFileSync(CONFIG_FILE, "utf8")).toBe(before); // آدرس دیتابیس دست‌نخورده
    expect(JSON.parse(before).databaseUrl).toBe(DEAD_URL);
    expect(fs.existsSync(LOCK_FILE)).toBe(false);
  });

  it("وقتی دیتابیس برگشت و کاربری دارد، خودش قفل می‌شود (نصب‌شده)", async () => {
    // دیتابیس برگشته و یک مدیر دارد، ولی lock-file هنوز نیست
    await iso.query("insert into users (name, email, mobile, password_hash, role) values ('مالک', 'o@example.com', '09120000009', 'x', 'admin')");
    clean();
    process.env.DATABASE_URL = urlOf(ISO);
    writeConfig({ databaseUrl: urlOf(ISO) }); // کش پیکربندی را تازه می‌کند
    process.env.DATABASE_URL = "";
    expect(await getInstallState()).toBe("installed");
    expect(fs.existsSync(LOCK_FILE)).toBe(true);
    // با وجود قفل، حتی با دیتابیس قطع هم «نصب‌شده» است (نه نامعلوم)
    writeConfig({ databaseUrl: DEAD_URL });
    expect(await getInstallState()).toBe("installed");
  });
});
