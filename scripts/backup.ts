#!/usr/bin/env -S npx tsx
/**
 * بک‌آپ دستی/زمان‌بندی‌شده از خط فرمان:   npm run backup
 * (مناسب cron سیستم‌عامل: 0 3 * * *  cd /path/to/app && npm run backup)
 *
 *   npm run backup                       بک‌آپ کامل (دیتابیس + امضا + PDF + پیوست + مدارک KYC + SESSION_SECRET مهر‌شده)
 *   npm run backup -- keygen             ساخت «کلید بازیابی» (کلید خصوصی فقط همین یک بار چاپ می‌شود؛ آفلاین نگه دارید)
 *   npm run backup -- list
 *   npm run backup -- verify [پوشه] [--key emz-rk1-…]   بررسی صحت؛ با --key «تمرین بازیابی» (باز کردن راز) هم انجام می‌شود
 *
 * متغیرها: DATABASE_URL · STORAGE_DIR · BACKUP_DIR · BACKUP_KEEP · BACKUP_MIRROR_DIRS (چند مسیر با ویرگول) ·
 *          BACKUP_RECOVERY_PUBLIC_KEY (یا فایل storage/backup-recovery.pub) · BACKUP_RECOVERY_KEY (فقط برای verify)
 */
import fs from "node:fs";
import path from "node:path";
import { createBackup, generateRecoveryKeyPair, listBackups, openBackupSecrets, recoveryFingerprint, verifyBackup } from "../src/modules/backup/core";

const storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");

function readConfigFile(): { databaseUrl?: string; sessionSecret?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(storageDir, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function recoveryPublicKey(): string {
  const cands = [process.env.BACKUP_RECOVERY_PUBLIC_KEY ?? ""];
  try {
    cands.push(fs.readFileSync(path.join(storageDir, "backup-recovery.pub"), "utf8"));
  } catch {
    /* نیست */
  }
  for (const c of cands) {
    const k = c.trim();
    if (!k) continue;
    try {
      recoveryFingerprint(k);
      return k;
    } catch {
      /* نامعتبر */
    }
  }
  return "";
}

const WARN: Record<string, string> = {
  "secret-not-sealed": "⚠ SESSION_SECRET در این بک‌آپ نیست (کلید بازیابی تنظیم نشده): `npm run backup -- keygen`",
  "backups-inside-data-volume": "⚠ نسخه‌ها روی همان volume داده‌ی اصلی‌اند: BACKUP_DIR را روی دیسک دیگر بگذارید یا BACKUP_MIRROR_DIRS را تنظیم کنید",
  "mirror-failed": "⚠ کپی در دست‌کم یک مقصد آینه ناموفق بود",
};

async function main() {
  const cfg = readConfigFile();
  const databaseUrl = process.env.DATABASE_URL || cfg.databaseUrl || "";
  const backupDir = process.env.BACKUP_DIR || path.join(storageDir, "backups");
  const args = process.argv.slice(2);
  const arg = args[0];
  const flag = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (arg === "keygen") {
    const existing = recoveryPublicKey();
    if (existing && !args.includes("--rotate")) throw new Error(`کلید بازیابی از قبل هست (اثر انگشت ${recoveryFingerprint(existing)}). برای ساخت کلید جدید --rotate بدهید.`);
    if (process.env.BACKUP_RECOVERY_PUBLIC_KEY && !args.includes("--rotate")) throw new Error("BACKUP_RECOVERY_PUBLIC_KEY در محیط تنظیم شده است");
    const k = generateRecoveryKeyPair();
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(storageDir, "backup-recovery.pub"), `${k.publicKey}\n`, { mode: 0o600 });
    console.log(`✓ کلید عمومی روی سرور ذخیره شد (اثر انگشت ${recoveryFingerprint(k.publicKey)}).\n`);
    console.log("══ کلید بازیابی (فقط همین یک بار نمایش داده می‌شود؛ در مدیر رمز/جای آفلاین نگه دارید، نه روی این سرور) ══");
    console.log(k.privateKey);
    console.log("══════════════════════════════════════════════════════════════════════════════════════════════");
    return;
  }
  if (arg === "list") {
    for (const b of await listBackups(backupDir)) console.log(`${b.ok ? "✓" : "✗ ناتمام"}  ${b.name}  ${b.createdAt.toISOString()}`);
    return;
  }
  if (arg === "verify") {
    const given = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const target = given ? path.resolve(given) : (await listBackups(backupDir)).find((b) => b.ok)?.dir;
    if (!target) throw new Error("بک‌آپی پیدا نشد");
    const v = await verifyBackup(target);
    if (!v.ok) {
      console.log(`✗ مشکل: ${v.problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`✓ ${target} سالم است`);
    const key = flag("key") || process.env.BACKUP_RECOVERY_KEY;
    if (v.manifest?.secrets) {
      if (key) {
        await openBackupSecrets(target, key);
        console.log(`✓ تمرین بازیابی: کلید بازیابی درست است و SESSION_SECRET بازیابی‌پذیر است (اثر انگشت ${v.manifest.secrets.recipient})`);
      } else console.log(`ℹ این بک‌آپ راز مهر‌شده دارد (اثر انگشت ${v.manifest.secrets.recipient}). برای تمرین بازیابی --key بدهید.`);
    } else console.log("⚠ این بک‌آپ SESSION_SECRET ندارد (کلید بازیابی در زمان ساخت آن تنظیم نبوده).");
    return;
  }
  if (!databaseUrl) throw new Error("DATABASE_URL تنظیم نشده است");
  const secret = process.env.SESSION_SECRET || cfg.sessionSecret || "";
  const mirrorDirs = (process.env.BACKUP_MIRROR_DIRS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  const r = await createBackup({
    databaseUrl,
    storageDir,
    backupDir,
    keep: Number(process.env.BACKUP_KEEP) || 14,
    sessionSecret: secret || undefined,
    recoveryPublicKey: recoveryPublicKey() || undefined,
    mirrorDirs,
  });
  const rows = r.manifest.tables.reduce((a, t) => a + t.rows, 0);
  console.log(`✓ بک‌آپ ساخته شد: ${r.dir}\n  ${r.manifest.tables.length} جدول، ${rows} ردیف، ${r.manifest.files.length} فایل${r.manifest.secrets ? "، SESSION_SECRET مهر‌شده" : ""}${r.removed.length ? `\n  حذف نسخه‌های قدیمی: ${r.removed.length}` : ""}`);
  for (const m of r.mirrors) console.log(m.ok ? `  ✓ آینه: ${m.dir}` : `  ✗ آینه ${m.dir}: ${m.error}`);
  for (const w of r.warnings) console.log(`  ${WARN[w] ?? w}`);
  if (r.warnings.includes("mirror-failed")) process.exitCode = 2;
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
