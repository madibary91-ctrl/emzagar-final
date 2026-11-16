import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  createBackup,
  generateRecoveryKeyPair,
  listBackups,
  openBackupSecrets,
  openSecrets,
  recoveryFingerprint,
  restoreBackup,
  sealSecrets,
  verifyBackup,
} from "@/modules/backup/core";
import { SCHEMA_CREATE } from "@/modules/install/schema-sql";

/**
 * CR-04 — «مدارک KYC و SESSION_SECRET در بک‌آپ نیستند و نسخه‌ها روی همان volume داده‌ی اصلی ذخیره می‌شوند.»
 */
const databaseUrl = process.env.TEST_DATABASE_URL!;
const SECRET = "prod-session-secret-" + crypto.randomBytes(16).toString("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "emz-bkc-"));
const usersCount = async () => ((await db.execute(sql`select count(*)::int as n from users`)).rows[0] as { n: number }).n;

function storageWithKyc() {
  const storage = tmp();
  fs.mkdirSync(path.join(storage, "kyc"));
  fs.mkdirSync(path.join(storage, "signatures"));
  fs.writeFileSync(path.join(storage, "kyc", "kyc-1.enc"), crypto.randomBytes(64));
  fs.writeFileSync(path.join(storage, "signatures", "s.png"), "SIG");
  return storage;
}

function allFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe("CR-04: محتوای بک‌آپ کامل است", () => {
  it("مدارک KYC در بک‌آپ و manifest هستند و هشِ آن‌ها راستی‌آزمایی می‌شود", async () => {
    const storage = storageWithKyc();
    const pair = generateRecoveryKeyPair();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp(), sessionSecret: SECRET, recoveryPublicKey: pair.publicKey });
    expect(r.manifest.files.map((f) => f.path)).toContain("files/kyc/kyc-1.enc");
    expect((await verifyBackup(r.dir)).ok).toBe(true);
    // دستکاری مدرک KYC در بک‌آپ شناسایی می‌شود
    fs.appendFileSync(path.join(r.dir, "files", "kyc", "kyc-1.enc"), "x");
    expect((await verifyBackup(r.dir)).problems.join()).toMatch(/kyc-1\.enc/);
  });

  it("SESSION_SECRET در بک‌آپ هست ولی «هرگز» به‌صورت متن ساده نیست", async () => {
    const storage = storageWithKyc();
    const pair = generateRecoveryKeyPair();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp(), sessionSecret: SECRET, recoveryPublicKey: pair.publicKey });
    expect(r.manifest.secrets?.recipient).toBe(recoveryFingerprint(pair.publicKey));
    expect(r.warnings).not.toContain("secret-not-sealed");
    for (const f of allFiles(r.dir)) {
      const data = fs.readFileSync(f);
      expect(data.includes(Buffer.from(SECRET)), f).toBe(false);
      expect(data.includes(Buffer.from(pair.privateKey)), f).toBe(false);
    }
    expect((fs.statSync(path.join(r.dir, "secrets.sealed.json")).mode & 0o077)).toBe(0);
    // فقط دارنده‌ی کلید خصوصی بازیابی می‌تواند باز کند
    expect((await openBackupSecrets(r.dir, pair.privateKey))?.sessionSecret).toBe(SECRET);
    const other = generateRecoveryKeyPair();
    await expect(openBackupSecrets(r.dir, other.privateKey)).rejects.toThrow(/اشتباه/);
    // دستکاری فایل مهر‌شده هم در verify و هم در باز کردن رد می‌شود
    const f = path.join(r.dir, "secrets.sealed.json");
    const sealed = JSON.parse(fs.readFileSync(f, "utf8"));
    sealed.ct = Buffer.from(Buffer.from(sealed.ct, "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url");
    fs.writeFileSync(f, JSON.stringify(sealed));
    expect((await verifyBackup(r.dir)).problems.join()).toMatch(/secrets\.sealed/);
    expect(() => openSecrets(JSON.stringify(sealed), pair.privateKey)).toThrow();
  });

  it("هر مهر، تصادفی است (دو بک‌آپ پشت‌سرهم رمزنوشته‌ی یکسان ندارند)", () => {
    const pair = generateRecoveryKeyPair();
    expect(sealSecrets({ sessionSecret: SECRET }, pair.publicKey)).not.toBe(sealSecrets({ sessionSecret: SECRET }, pair.publicKey));
  });

  it("بدون کلید بازیابی: بک‌آپ ساخته می‌شود ولی راز ذخیره نمی‌شود و هشدار می‌دهد (هرگز متن ساده نمی‌نویسد)", async () => {
    const storage = storageWithKyc();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp(), sessionSecret: SECRET });
    expect(r.manifest.secrets).toBeUndefined();
    expect(r.warnings).toContain("secret-not-sealed");
    expect(r.manifest.files.map((f) => f.path)).toContain("files/kyc/kyc-1.enc");
    for (const f of allFiles(r.dir)) expect(fs.readFileSync(f).includes(Buffer.from(SECRET)), f).toBe(false);
  });
});

describe("CR-04: بازیابی کامل (KYC + SESSION_SECRET)", () => {
  it("سرور از دست رفته: از بک‌آپ + کلید بازیابی، KYC و کلید امنیتی روی سرور تازه برمی‌گردد", async () => {
    const storage = storageWithKyc();
    const kycBytes = fs.readFileSync(path.join(storage, "kyc", "kyc-1.enc"));
    const pair = generateRecoveryKeyPair();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp(), sessionSecret: SECRET, recoveryPublicKey: pair.publicKey });
    const before = await usersCount();

    const fresh = tmp(); // storage سرور جدید: خالی
    const res = await restoreBackup({ backup: r.dir, databaseUrl, storageDir: fresh, schemaStatements: SCHEMA_CREATE, recoveryKey: pair.privateKey });
    expect(res.secretsRestored).toBe(true);
    expect(fs.readFileSync(path.join(fresh, "kyc", "kyc-1.enc")).equals(kycBytes)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(fresh, "config.json"), "utf8"));
    expect(cfg.sessionSecret).toBe(SECRET);
    expect(fs.statSync(path.join(fresh, "config.json")).mode & 0o077).toBe(0);
    expect(await usersCount()).toBe(before);
  });

  it("بدون کلید یا با کلید غلط، بازیابی «پیش از هر تغییر» متوقف می‌شود (داده‌ی فعلی دست‌نخورده)", async () => {
    const storage = storageWithKyc();
    const pair = generateRecoveryKeyPair();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp(), sessionSecret: SECRET, recoveryPublicKey: pair.publicKey });
    const before = await usersCount();
    const fresh = tmp();
    await expect(restoreBackup({ backup: r.dir, databaseUrl, storageDir: fresh, schemaStatements: SCHEMA_CREATE })).rejects.toThrow(/کلید بازیابی/);
    await expect(restoreBackup({ backup: r.dir, databaseUrl, storageDir: fresh, schemaStatements: SCHEMA_CREATE, recoveryKey: generateRecoveryKeyPair().privateKey })).rejects.toThrow(/اشتباه/);
    expect(fs.readdirSync(fresh)).toEqual([]);
    expect(await usersCount()).toBe(before);
    // انتخاب آگاهانه‌ی «بدون راز»
    const res = await restoreBackup({ backup: r.dir, databaseUrl, storageDir: fresh, schemaStatements: SCHEMA_CREATE, skipSecrets: true });
    expect(res.secretsRestored).toBe(false);
    expect(fs.existsSync(path.join(fresh, "config.json"))).toBe(false);
  });

  it("بک‌آپ‌های قدیمی (بدون راز) مثل قبل بازیابی می‌شوند", async () => {
    const storage = tmp();
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp() });
    const res = await restoreBackup({ backup: r.dir, databaseUrl, storageDir: storage, schemaStatements: SCHEMA_CREATE });
    expect(res.secretsRestored).toBe(false);
  });
});

describe("CR-04: نسخه‌ها فقط روی volume داده‌ی اصلی نیستند", () => {
  it("آینه‌ها: کپی کامل، راستی‌آزمایی در مقصد، و سیاست نگهداری در هر مقصد", async () => {
    const storage = storageWithKyc();
    const backupDir = tmp();
    const m1 = path.join(tmp(), "offsite-a");
    const m2 = path.join(tmp(), "offsite-b");
    const pair = generateRecoveryKeyPair();
    let last!: Awaited<ReturnType<typeof createBackup>>;
    for (let i = 0; i < 3; i++) {
      last = await createBackup({ databaseUrl, storageDir: storage, backupDir, keep: 2, mirrorDirs: [m1, m2], sessionSecret: SECRET, recoveryPublicKey: pair.publicKey });
      await new Promise((r) => setTimeout(r, 1100));
    }
    expect(last.mirrors.map((m) => m.ok)).toEqual([true, true]);
    for (const m of [m1, m2]) {
      const list = (await listBackups(m)).filter((b) => b.ok);
      expect(list.length).toBe(2); // نگهداری در مقصد هم اعمال شد
      expect((await verifyBackup(list[0].dir)).ok).toBe(true);
      expect(fs.statSync(list[0].dir).mode & 0o077).toBe(0);
      expect((await openBackupSecrets(list[0].dir, pair.privateKey))?.sessionSecret).toBe(SECRET);
    }
    // نسخه‌ی آینه به‌تنهایی قابل بازیابی است (سرور اصلی و volume اصلی از بین رفته‌اند)
    const [fromMirror] = await listBackups(m2);
    const fresh = tmp();
    const res = await restoreBackup({ backup: fromMirror.dir, databaseUrl, storageDir: fresh, schemaStatements: SCHEMA_CREATE, recoveryKey: pair.privateKey });
    expect(res.files).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(fresh, "kyc", "kyc-1.enc"))).toBe(true);
  }, 60_000);

  it("خرابی یک آینه، بک‌آپ اصلی را خراب نمی‌کند ولی هشدار می‌دهد؛ آینه‌ی سالم دیگر کار می‌کند", async () => {
    const storage = tmp();
    const notADir = path.join(tmp(), "file");
    fs.writeFileSync(notADir, "x");
    const good = path.join(tmp(), "good");
    const r = await createBackup({ databaseUrl, storageDir: storage, backupDir: tmp(), mirrorDirs: [path.join(notADir, "sub"), good] });
    expect((await verifyBackup(r.dir)).ok).toBe(true);
    expect(r.mirrors.map((m) => m.ok)).toEqual([false, true]);
    expect(r.warnings).toContain("mirror-failed");
    expect((await listBackups(good)).length).toBe(1);
  });

  it("مقصد آینه برابر مقصد اصلی رد می‌شود (کپی بی‌معنی)", async () => {
    const backupDir = tmp();
    const r = await createBackup({ databaseUrl, storageDir: tmp(), backupDir, mirrorDirs: [backupDir] });
    expect(r.mirrors[0].ok).toBe(false);
    expect(r.warnings).toContain("mirror-failed");
  });

  it("نسخه‌ها داخل volume داده‌ی اصلی و بدون آینه‌ی بیرونی ← هشدار؛ با آینه‌ی بیرونی ← بدون هشدار", async () => {
    const storage = storageWithKyc();
    const inside = path.join(storage, "backups");
    const a = await createBackup({ databaseUrl, storageDir: storage, backupDir: inside });
    expect(a.warnings).toContain("backups-inside-data-volume");
    expect(a.manifest.warnings).toContain("backups-inside-data-volume");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await createBackup({ databaseUrl, storageDir: storage, backupDir: inside, mirrorDirs: [path.join(tmp(), "offsite")] });
    expect(b.warnings).not.toContain("backups-inside-data-volume");
    // آینه‌ای که خودش داخل volume داده است، «بیرونی» حساب نمی‌شود
    await new Promise((r) => setTimeout(r, 1100));
    const c = await createBackup({ databaseUrl, storageDir: storage, backupDir: inside, mirrorDirs: [path.join(storage, "mirror")] });
    expect(c.warnings).toContain("backups-inside-data-volume");
    // خود پوشه‌ی backups داخل storage، در بک‌آپ بعدی تو در تو کپی نمی‌شود
    expect(c.manifest.files.some((f) => f.path.includes("backups/"))).toBe(false);
  }, 30_000);

  it("نسخه‌ی بیرون از volume داده، هشدار ندارد", async () => {
    const r = await createBackup({ databaseUrl, storageDir: tmp(), backupDir: tmp() });
    expect(r.warnings).toEqual([]);
  });
});
