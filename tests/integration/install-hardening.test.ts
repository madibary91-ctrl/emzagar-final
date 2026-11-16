import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { STORAGE_DIR, writeConfig } from "@/lib/config";
import {
  installAccountAction,
  installDatabaseAction,
  installFinishAction,
  testDatabaseAction,
} from "@/modules/install/actions";
import {
  __resetKeyFailures,
  getInstallState,
  getInstallStatus,
  INSTALL_KEY_FILE,
  keyMatches,
} from "@/modules/install/service";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";

/**
 * CR-03 — نصب‌کننده‌ی وب:
 *  «اگر INSTALL_KEY تنظیم نشده باشد، اولین بازدیدکننده مدیر کل می‌شود. در شرایط خاص (قطع DB و نبود lock-file)
 *   آدرس دیتابیس هم قابل بازنویسی است.»
 * هر دو راه باید بسته باشد: بدون کلید مالکیت، نصب ممکن نیست؛ و «وضعیت نامعلوم» = بسته.
 */
const ISO = "emz_test_install_cr03";
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

const readKey = () => fs.readFileSync(INSTALL_KEY_FILE, "utf8").trim();
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
  clean();
});

afterAll(async () => {
  process.env.DATABASE_URL = savedUrl;
  await db.execute(sql`select 1`);
  await iso.end();
  const a = admin();
  await a.query(`DROP DATABASE IF EXISTS "${ISO}" WITH (FORCE)`).catch(() => undefined);
  await a.end();
  clean();
});

beforeEach(() => {
  __resetKeyFailures();
  delete process.env.INSTALL_KEY;
  delete process.env.INSTALL_OPEN;
});

describe("CR-03: اولین بازدیدکننده دیگر مدیر کل نمی‌شود", () => {
  it("روی دیتابیس خالی بدون کلید: همه‌ی مراحل نصب رد می‌شوند و هیچ مدیری ساخته نمی‌شود", async () => {
    process.env.DATABASE_URL = urlOf(ISO); // دیتابیس خالی (جدولی نیست)
    expect(await getInstallState()).toBe("fresh");

    const st = await getInstallStatus(true);
    expect(st.keyRequired).toBe(true);
    expect(st.keySource).toBe("file");
    // کلید تصادفی فقط روی دیسک سرور (مجوز 0600) ساخته شده؛ به بازدیدکننده داده نمی‌شود
    const key = readKey();
    expect(key.length).toBeGreaterThanOrEqual(24);
    expect(fs.statSync(INSTALL_KEY_FILE).mode & 0o077).toBe(0);
    expect(JSON.stringify(st)).not.toContain(key);

    for (const wrong of [undefined, "", "guess", key.slice(0, -1), key + "x"]) {
      expect((await testDatabaseAction({ mode: "url", url: urlOf(ISO) }, wrong)).ok).toBe(false);
      expect((await installDatabaseAction({ mode: "url", url: urlOf(ISO) }, wrong)).ok).toBe(false);
      const r = await installAccountAction(account, wrong);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/کلید نصب/);
    }
    // هیچ جدول و کاربری ساخته نشد
    const t = await iso.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'");
    expect(t.rows[0].n).toBe(0);
  });

  it("کلید غلط تکراری، نصب‌کننده را (حتی برای کلید درست) موقتاً قفل می‌کند", async () => {
    process.env.DATABASE_URL = urlOf(ISO);
    const key = readKey();
    for (let i = 0; i < 20; i++) await installAccountAction(account, `wrong-${i}`);
    const locked = await installAccountAction(account, key);
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(/قفل/);
    __resetKeyFailures();
    expect(keyMatches(key)).toBe(true);
  });

  it("INSTALL_KEY محیط اولویت دارد؛ کلید فایل دیگر پذیرفته نمی‌شود", () => {
    process.env.INSTALL_KEY = "owner-chosen-key-123";
    expect(keyMatches("owner-chosen-key-123")).toBe(true);
    expect(keyMatches(readKey())).toBe(false);
    expect(keyMatches("")).toBe(false);
  });

  it("INSTALL_OPEN=1 فقط انصراف صریح (CI) است و بدون آن هرگز باز نیست", () => {
    expect(keyMatches("")).toBe(false);
    process.env.INSTALL_OPEN = "1";
    expect(keyMatches("")).toBe(true);
  });

  it("با کلید درست نصب کامل می‌شود؛ پس از پایان، کلید حذف و نصب‌کننده برای همیشه بسته می‌شود", async () => {
    process.env.DATABASE_URL = urlOf(ISO);
    const key = readKey();
    expect((await testDatabaseAction({ mode: "url", url: urlOf(ISO) }, key)).ok).toBe(true);
    expect((await installDatabaseAction({ mode: "url", url: urlOf(ISO) }, key)).ok).toBe(true);
    const res = await installAccountAction(account, key);
    expect(res.ok, res.error).toBe(true);
    expect((await installFinishAction()).ok).toBe(true);

    expect(await getInstallState()).toBe("installed");
    expect(fs.existsSync(INSTALL_KEY_FILE)).toBe(false);
    expect((await iso.query("select count(*)::int as n from users where role = 'admin'")).rows[0].n).toBe(1);

    // نفر دوم، حتی با کلیدی که قبلاً درست بود، مدیر دومی نمی‌سازد
    const again = await installAccountAction({ ...account, email: "attacker@example.com" }, key);
    expect(again.ok).toBe(false);
    expect((await iso.query("select count(*)::int as n from users")).rows[0].n).toBe(1);
  });
});
