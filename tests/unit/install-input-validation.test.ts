import { describe, expect, it } from "vitest";
import { buildDatabaseUrl, type DbInput } from "@/modules/install/service/database";
import { validateAccount, type AccountInput } from "@/modules/install/service/account";

/**
 * S00-F04 — رشته‌ی اتصال دیتابیس ورودی کاربر: تزریق پارامتر، SSRF به سرویس فراداده‌ی ابر، و ورودی ساخته‌دست (Server Action).
 */
const url = (u: string): DbInput => ({ mode: "url", url: u });
const simple = (o: Partial<Extract<DbInput, { mode: "simple" }>> = {}): DbInput => ({ mode: "simple", host: "db", port: "5432", name: "emz", user: "u", password: "p@ss:w/rd", ssl: false, ...o });

describe("S00-F04: buildDatabaseUrl (حالت url)", () => {
  it("آدرس‌های درست را بدون تغییر می‌پذیرد", () => {
    for (const ok of [
      "postgresql://u:p@db:5432/emz",
      "postgres://u:p%40ss@db.internal.example:5432/emz?sslmode=require",
      "postgresql://u:p@127.0.0.1:5432/emz?sslmode=no-verify&application_name=emzagar",
      "postgresql://u:p@[::1]:5432/emz",
      "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require",
    ]) expect(buildDatabaseUrl(url(ok)), ok).toEqual({ url: ok });
  });

  it("پارامترهای تزریقی (host/options/sslrootcert/…) رد می‌شوند", () => {
    for (const bad of [
      "postgresql://u:p@db/emz?host=evil.example.net",
      "postgresql://u:p@db/emz?hostaddr=10.0.0.5",
      "postgresql://u:p@db/emz?options=-c%20search_path%3Devil",
      "postgresql://u:p@db/emz?sslrootcert=/etc/passwd",
      "postgresql://u:p@db/emz?sslkey=/etc/shadow",
      "postgresql://u:p@db/emz?service=x",
      "postgresql://u:p@db/emz?sslmode=require&port=22",
      "postgresql://u:p@db/emz?sslmode=bogus",
    ]) {
      const r = buildDatabaseUrl(url(bad));
      expect(r.url, bad).toBeUndefined();
      expect(r.error, bad).toBeTruthy();
    }
  });

  it("سرویس فراداده‌ی ابر (169.254.x.x)، میزبان خالی و سوکت یونیکس رد می‌شوند", () => {
    for (const bad of ["postgresql://u:p@169.254.169.254:5432/emz", "postgresql://u:p@169.254.169.254/emz", "postgresql:///emz?host=/var/run/postgresql", "postgresql://u:p@metadata.google.internal/emz"]) {
      expect(buildDatabaseUrl(url(bad)).url, bad).toBeUndefined();
    }
  });

  it("نام دیتابیس خالی/خطرناک و آدرس بیش از حد بلند رد می‌شود", () => {
    expect(buildDatabaseUrl(url("postgresql://u:p@db:5432/")).url).toBeUndefined();
    expect(buildDatabaseUrl(url("postgresql://u:p@db:5432/a%2Fb")).url).toBeUndefined();
    expect(buildDatabaseUrl(url(`postgresql://u:p@db:5432/emz?sslmode=${"x".repeat(3000)}`)).url).toBeUndefined();
  });
});

describe("S00-F04: buildDatabaseUrl (حالت simple) و ورودی ساخته‌دست", () => {
  it("کاراکترهای خاص رمز کدگذاری می‌شوند و آدرس معتبر است", () => {
    const r = buildDatabaseUrl(simple());
    expect(r.url).toBe("postgresql://u:p%40ss%3Aw%2Frd@db:5432/emz");
    expect(new URL(r.url!).password).toBe("p%40ss%3Aw%2Frd");
  });

  it("میزبان فراداده‌ی ابر رد می‌شود", () => {
    expect(buildDatabaseUrl(simple({ host: "169.254.169.254" })).url).toBeUndefined();
  });

  it("مقدار غیرمتنی (آرایه/عدد/شیء/null) TypeError نمی‌دهد و پیام خطا برمی‌گرداند", () => {
    const evil = [
      null,
      undefined,
      "x",
      { mode: "url", url: ["postgresql://a:b@c/d"] },
      { mode: "url", url: 123 },
      { mode: "simple", host: { toString: () => "x" }, port: 5432, name: "n", user: "u", password: "p" },
      { mode: "simple", host: "db", port: "5432", name: ["a"], user: "u", password: "p" },
      { mode: "simple", host: "db", port: "5432", name: "n", user: "u", password: 42 },
      { mode: "other" },
    ];
    for (const e of evil) {
      let r: ReturnType<typeof buildDatabaseUrl> | undefined;
      expect(() => (r = buildDatabaseUrl(e as unknown as DbInput)), JSON.stringify(e)).not.toThrow();
      expect(r?.url).toBeUndefined();
      expect(r?.error).toBeTruthy();
    }
  });
});

describe("S00-F04: validateAccount", () => {
  const good: AccountInput = { siteName: "سایت من", name: "مالک", email: "owner@example.com", mobile: "09120000000", password: "Passw0rdX9" };
  it("ورودی درست پذیرفته می‌شود", () => expect(validateAccount(good)).toBeNull());
  it("نوع نادرست TypeError نمی‌دهد", () => {
    for (const bad of [null, {}, { ...good, password: 12345678 }, { ...good, email: ["a@b.co"] }, { ...good, siteName: undefined }]) {
      let r: string | null = "unset";
      expect(() => (r = validateAccount(bad as unknown as AccountInput))).not.toThrow();
      expect(r).toBeTruthy();
    }
  });
  it("رمز و فیلدهای بی‌سقف رد می‌شوند (DoS هش‌کردن)", () => {
    expect(validateAccount({ ...good, password: `a1${"x".repeat(5_000_000)}` })).toBeTruthy();
    expect(validateAccount({ ...good, siteName: "س".repeat(101) })).toBeTruthy();
    expect(validateAccount({ ...good, name: "n".repeat(101) })).toBeTruthy();
  });
});
