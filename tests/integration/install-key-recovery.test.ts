import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { INSTALL_KEY_FILE, __resetKeyFailures, installKeySource, keyMatches } from "@/modules/install/service";

/**
 * S00-F02: فایل کلید نصب «موجود ولی بی‌مصرف» (خالی/کوتاه) نباید نصب‌کننده را برای همیشه قفل کند.
 * S00-F03: فاصله/خط‌جدیدِ اضافه در کلید (کپی از لاگ یا .env) نباید کلید درست را رد کند.
 */
const rm = () => fs.rmSync(INSTALL_KEY_FILE, { force: true });
const read = () => fs.readFileSync(INSTALL_KEY_FILE, "utf8").trim();

beforeEach(() => {
  rm();
  __resetKeyFailures();
  delete process.env.INSTALL_KEY;
  delete process.env.INSTALL_OPEN;
});
afterAll(() => {
  rm();
  delete process.env.INSTALL_KEY;
});

describe("S00-F02: بازیابی از فایل کلید خراب", () => {
  for (const [name, content] of [["خالی", ""], ["فقط خط‌جدید", "\n"], ["کوتاه‌تر از ۱۶", "abc123\n"]] as const) {
    it(`فایل ${name}: کلید تازه ساخته، ذخیره و پایدار می‌شود (قفل همیشگی نیست)`, () => {
      fs.mkdirSync(INSTALL_KEY_FILE.replace(/[^/\\]+$/, ""), { recursive: true });
      fs.writeFileSync(INSTALL_KEY_FILE, content, { mode: 0o600 });
      expect(keyMatches("anything-wrong")).toBe(false); // اولین فراخوانی کلید تازه می‌سازد
      const key = read();
      expect(key.length).toBeGreaterThanOrEqual(16);
      expect(keyMatches(key)).toBe(true); // همان کلیدی که در فایل (و لاگ) است پذیرفته می‌شود
      expect(read()).toBe(key); // پایدار: فراخوانی بعدی عوضش نمی‌کند
      expect(fs.statSync(INSTALL_KEY_FILE).mode & 0o077).toBe(0);
    });
  }
  it("فایل معتبر دست‌نخورده می‌ماند", () => {
    fs.mkdirSync(INSTALL_KEY_FILE.replace(/[^/\\]+$/, ""), { recursive: true });
    fs.writeFileSync(INSTALL_KEY_FILE, "owner-wrote-this-key-0123456789\n", { mode: 0o600 });
    expect(keyMatches("owner-wrote-this-key-0123456789")).toBe(true);
    expect(read()).toBe("owner-wrote-this-key-0123456789");
  });
});

describe("S00-F03: فاصله‌ی اضافه در کلید", () => {
  it("کلید واردشده‌ی دارای فاصله/خط‌جدید پذیرفته می‌شود", () => {
    process.env.INSTALL_KEY = "owner-chosen-key-123";
    expect(keyMatches("  owner-chosen-key-123\n")).toBe(true);
    expect(keyMatches("owner-chosen-key-124")).toBe(false);
  });
  it("INSTALL_KEY محیط با فاصله‌ی اضافه هم قابل استفاده است و INSTALL_KEY فقط-فاصله «تنظیم‌نشده» حساب می‌شود", () => {
    process.env.INSTALL_KEY = "  owner-chosen-key-123 \n";
    expect(installKeySource()).toBe("env");
    expect(keyMatches("owner-chosen-key-123")).toBe(true);
    process.env.INSTALL_KEY = "   ";
    expect(installKeySource()).toBe("file"); // نه کلیدی که هیچ‌کس نمی‌تواند تایپ کند
  });
  it("ورودی غیرمتنی (آرایه/شیء) هرگز کلید را درست نمی‌کند", () => {
    process.env.INSTALL_KEY = "owner-chosen-key-123";
    expect(keyMatches(["owner-chosen-key-123"] as unknown as string)).toBe(false);
    expect(keyMatches(undefined)).toBe(false);
  });
});
