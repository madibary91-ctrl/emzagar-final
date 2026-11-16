import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { settings, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "@/modules/backup/core";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";
import { uniq } from "../helpers";

const databaseUrl = process.env.TEST_DATABASE_URL!;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "emz-bk-"));
}

describe("بک‌آپ و بازیابی", () => {
  it("بک‌آپ کامل می‌سازد، صحتش تأیید می‌شود و دستکاری شناسایی می‌شود", async () => {
    const storage = tmp();
    fs.mkdirSync(path.join(storage, "signatures"));
    fs.mkdirSync(path.join(storage, "documents"));
    fs.writeFileSync(path.join(storage, "signatures", "a.png"), "SIGDATA");
    fs.writeFileSync(path.join(storage, "documents", "d.pdf"), "%PDF-fake");
    const backupDir = tmp();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir });
    expect(r.manifest.tables.length).toBeGreaterThan(20);
    expect(r.manifest.files.map((f) => f.path).sort()).toEqual(["files/documents/d.pdf", "files/signatures/a.png"]);
    expect((await verifyBackup(r.dir)).ok).toBe(true);
    expect((fs.statSync(r.dir).mode & 0o077)).toBe(0); // فقط مالک

    fs.appendFileSync(path.join(r.dir, "files", "signatures", "a.png"), "x");
    const bad = await verifyBackup(r.dir);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join()).toMatch(/a\.png/);
  });

  it("بازیابی داده‌ها و فایل‌ها را دقیقاً برمی‌گرداند و شمارنده‌ی شناسه را درست می‌کند", async () => {
    const email = `${uniq("bk")}@example.com`;
    await db.insert(users).values({ name: "بک‌آپ", email, mobile: "09120000007", passwordHash: hashPassword("Backup123x"), emailVerifiedAt: new Date() });
    await db.insert(settings).values({ key: `bk_${uniq()}`, value: "v" });
    const storage = tmp();
    fs.mkdirSync(path.join(storage, "signatures"));
    fs.writeFileSync(path.join(storage, "signatures", "keep.png"), "KEEP");
    const backupDir = tmp();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir });
    const [{ n: before }] = (await db.execute(sql`select count(*)::int as n from users`)).rows as { n: number }[];

    // «حادثه»: همه‌ی کاربران و فایل امضا از بین می‌روند
    await db.execute(sql`truncate users restart identity cascade`);
    fs.rmSync(path.join(storage, "signatures", "keep.png"));
    expect(((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n).toBe(0);

    const res = await restoreBackup({ backup: r.dir, databaseUrl, storageDir: storage, schemaStatements: SCHEMA_CREATE });
    expect(res.rows).toBeGreaterThan(0);
    expect(((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n).toBe(before);
    expect(((await db.execute(sql`select count(*)::int as n from users where email = ${email}`)).rows[0] as { n: number }).n).toBe(1);
    expect(fs.readFileSync(path.join(storage, "signatures", "keep.png"), "utf8")).toBe("KEEP");
    // شمارنده‌ی serial: ثبت بعدی نباید با شناسه‌ی موجود تصادم کند
    const [u] = await db.insert(users).values({ name: "بعد", email: `${uniq("af")}@example.com`, mobile: "09120000006", passwordHash: "x" }).returning();
    expect(u.id).toBeGreaterThan(0);
  });

  it("بک‌آپ خراب هرگز بازیابی نمی‌شود (داده‌ی فعلی دست‌نخورده می‌ماند)", async () => {
    const storage = tmp();
    const backupDir = tmp();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir });
    const file = path.join(r.dir, r.manifest.tables.find((t) => t.rows > 0)!.file);
    fs.appendFileSync(file, "garbage");
    const before = ((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n;
    await expect(restoreBackup({ backup: r.dir, databaseUrl, storageDir: storage, schemaStatements: SCHEMA_CREATE })).rejects.toThrow(/معتبر نیست/);
    expect(((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n).toBe(before);
  });

  it("سیاست نگهداری: فقط N نسخه‌ی آخر می‌ماند", async () => {
    const storage = tmp();
    const backupDir = tmp();
    for (let i = 0; i < 3; i++) {
      await createBackup({ databaseUrl, storageDir: storage, backupDir, keep: 2 });
      await new Promise((r) => setTimeout(r, 1100)); // نام پوشه تا ثانیه است
    }
    expect((await listBackups(backupDir)).filter((b) => b.ok).length).toBe(2);
  });
});
