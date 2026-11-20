import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STORAGE_DIR } from "@/lib/config";
import { installAccountAction, installDatabaseAction, installFinishAction } from "@/modules/install/actions";
import { INSTALL_KEY_FILE, getInstallState } from "@/modules/install/service";

/**
 * S00-F05: اگر مدیر ساخته و commit شد ولی ساخت نشست/کوکی شکست خورد، نباید «ساخت حساب ناموفق بود» گزارش شود
 * (مدیر وجود دارد و سامانه نصب‌شده است؛ پیام دروغ مرحله‌ی «پایان» را می‌پراند و تلاش دوباره «قبلاً نصب شده» می‌داد).
 */
vi.mock("@/modules/auth/session", async (orig) => ({ ...(await orig<typeof import("@/modules/auth/session")>()), createSession: vi.fn().mockRejectedValue(new Error("cookie store unavailable")) }));

const ISO = "emz_test_install_s00f05";
const base = new URL(process.env.TEST_DATABASE_URL!);
const urlOf = (name: string) => {
  const u = new URL(base.toString());
  u.pathname = `/${name}`;
  return u.toString();
};
const savedUrl = process.env.DATABASE_URL;
const files = [path.join(STORAGE_DIR, "config.json"), path.join(STORAGE_DIR, "installed.lock"), INSTALL_KEY_FILE];
const clean = () => files.forEach((f) => fs.rmSync(f, { force: true }));
const admin = () => new Pool({ connectionString: urlOf("postgres"), max: 1 });
const account = { siteName: "سایت من", name: "مالک سرور", email: "owner@example.com", mobile: "09120000000", password: "Passw0rdX9" };
let iso: Pool;

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
  process.env.INSTALL_OPEN = "1";
  process.env.DATABASE_URL = urlOf(ISO);
});
afterAll(async () => {
  process.env.DATABASE_URL = savedUrl;
  delete process.env.INSTALL_OPEN;
  await iso.end();
  const a = admin();
  await a.query(`DROP DATABASE IF EXISTS "${ISO}" WITH (FORCE)`).catch(() => undefined);
  await a.end();
  clean();
});

describe("S00-F05: شکست ساخت نشست پس از ساخت مدیر", () => {
  it("موفقیت (با راهنمای ورود دستی) گزارش می‌شود و مرحله‌ی پایان قفل نصب را می‌نویسد", async () => {
    expect((await installDatabaseAction({ mode: "url", url: urlOf(ISO) })).ok).toBe(true);
    const res = await installAccountAction(account);
    expect(res.ok, res.error).toBe(true);
    expect(res.note).toMatch(/ورود/);
    expect((await iso.query("select count(*)::int as n from users where role = 'admin'")).rows[0].n).toBe(1);
    expect((await installFinishAction()).ok).toBe(true);
    expect(await getInstallState()).toBe("installed");
    // تلاش دوم مدیر دومی نمی‌سازد
    expect((await installAccountAction({ ...account, email: "second@example.com" })).ok).toBe(false);
    expect((await iso.query("select count(*)::int as n from users")).rows[0].n).toBe(1);
  });
});
