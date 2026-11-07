#!/usr/bin/env -S npx tsx
/**
 * بازیابی از بک‌آپ:   npm run restore -- <مسیر پوشه‌ی بک‌آپ> --key emz-rk1-… --yes
 * ⚠️ محتوای فعلی همه‌ی جدول‌ها با بک‌آپ جایگزین می‌شود. بدون --yes فقط صحت بک‌آپ بررسی می‌شود.
 *
 * اگر بک‌آپ SESSION_SECRET مهر‌شده دارد، «کلید بازیابی» لازم است (--key یا متغیر BACKUP_RECOVERY_KEY): راز باز و در
 * storage/config.json نوشته می‌شود تا مدارک KYC و رازهای رمزنگاری‌شده‌ی دیتابیس دوباره خوانا شوند.
 * --skip-secrets: عمداً بدون راز (KYC و کلیدهای رمزنگاری‌شده خوانا نخواهند بود).
 */
import fs from "node:fs";
import path from "node:path";
import { restoreBackup, verifyBackup } from "../src/modules/backup/core";
import { SCHEMA_CREATE } from "../src/modules/install/schema-sql";

async function main() {
  const args = process.argv.slice(2);
  const valueFlags = new Set(["--key"]);
  const target = args.find((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1]));
  const yes = args.includes("--yes");
  const ki = args.indexOf("--key");
  const recoveryKey = (ki >= 0 ? args[ki + 1] : undefined) || process.env.BACKUP_RECOVERY_KEY;
  if (!target) throw new Error("مسیر پوشه‌ی بک‌آپ را بدهید:  npm run restore -- storage/backups/backup-YYYYMMDD-HHMMSS --key emz-rk1-… --yes");
  const dir = path.resolve(target);
  const storageDir = process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
  let databaseUrl = process.env.DATABASE_URL || "";
  if (!databaseUrl) {
    try {
      databaseUrl = JSON.parse(fs.readFileSync(path.join(storageDir, "config.json"), "utf8")).databaseUrl || "";
    } catch {
      /* ignore */
    }
  }
  const v = await verifyBackup(dir);
  if (!v.ok) throw new Error(`بک‌آپ معتبر نیست:\n  ${v.problems.join("\n  ")}`);
  const m = v.manifest!;
  console.log(`✓ بک‌آپ سالم است (${m.createdAt}) — ${m.tables.length} جدول، ${m.files.length} فایل${m.secrets ? `، راز مهر‌شده (اثر انگشت ${m.secrets.recipient})` : "، بدون راز مهر‌شده"}`);
  if (!yes) {
    console.log("برای اجرای واقعی بازیابی، گزینه‌ی --yes را اضافه کنید (این کار داده‌های فعلی را جایگزین می‌کند).");
    return;
  }
  if (!databaseUrl) throw new Error("DATABASE_URL تنظیم نشده است");
  const r = await restoreBackup({ backup: dir, databaseUrl, storageDir, schemaStatements: SCHEMA_CREATE, recoveryKey, skipSecrets: args.includes("--skip-secrets") });
  console.log(`✓ بازیابی انجام شد: ${r.tables} جدول، ${r.rows} ردیف، ${r.files} فایل`);
  if (r.secretsRestored) {
    console.log("✓ SESSION_SECRET بازیابی و در storage/config.json نوشته شد.");
    if (process.env.SESSION_SECRET) console.log("⚠ متغیر محیطی SESSION_SECRET روی config.json اولویت دارد؛ آن را حذف کنید یا با مقدار اصلی یکی کنید، وگرنه KYC خوانا نمی‌شود.");
  } else if (m.secrets) console.log("⚠ راز بازیابی نشد (--skip-secrets): مدارک KYC خوانا نیستند.");
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
