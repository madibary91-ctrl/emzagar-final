import fs from "node:fs";
import path from "node:path";
import { STORAGE_DIR, getConfig } from "@/lib/config";
import { backupsDir } from "@/lib/storage-paths";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { createBackup, generateRecoveryKeyPair, isInside, listBackups, recoveryFingerprint, verifyBackup, type BackupManifest } from "./core";

/* ───────── کلید بازیابی (CR-04) ─────────
 * کلید «عمومی» روی سرور (storage/backup-recovery.pub یا BACKUP_RECOVERY_PUBLIC_KEY) می‌ماند و فقط برای «مهر کردن»
 * SESSION_SECRET در بک‌آپ است. کلید «خصوصی» فقط یک بار هنگام ساخت به مدیر کل نشان داده می‌شود و هیچ‌جا ذخیره نمی‌شود.
 */
const recoveryPubFile = () => path.join(STORAGE_DIR, "backup-recovery.pub");

export function recoveryPublicKey(): string {
  const candidates = [process.env.BACKUP_RECOVERY_PUBLIC_KEY ?? "", (() => {
    try {
      return fs.readFileSync(recoveryPubFile(), "utf8");
    } catch {
      return "";
    }
  })()];
  for (const c of candidates) {
    const k = c.trim();
    if (!k) continue;
    try {
      recoveryFingerprint(k); // اعتبارسنجی
      return k;
    } catch {
      /* نامعتبر ← نادیده */
    }
  }
  return "";
}

export function recoveryStatus(): { configured: boolean; fingerprint: string; fromEnv: boolean } {
  const k = recoveryPublicKey();
  return { configured: !!k, fingerprint: k ? recoveryFingerprint(k) : "", fromEnv: !!process.env.BACKUP_RECOVERY_PUBLIC_KEY?.trim() };
}

/** ساخت (یا چرخش) کلید بازیابی؛ کلید خصوصی فقط در خروجی همین تابع وجود دارد */
export function provisionRecoveryKey(): { privateKey: string; fingerprint: string } {
  if (process.env.BACKUP_RECOVERY_PUBLIC_KEY?.trim()) throw new Error("کلید بازیابی از طریق BACKUP_RECOVERY_PUBLIC_KEY مدیریت می‌شود");
  const pair = generateRecoveryKeyPair();
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  fs.writeFileSync(recoveryPubFile(), `${pair.publicKey}\n`, { mode: 0o600 });
  return { privateKey: pair.privateKey, fingerprint: recoveryFingerprint(pair.publicKey) };
}

/** مقصدهای آینه‌ی بک‌آپ (BACKUP_MIRROR_DIRS: چند مسیر جداشده با ویرگول؛ دیسک/NFS/mount دیگر) */
export const mirrorDirs = (): string[] =>
  (process.env.BACKUP_MIRROR_DIRS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

/** بک‌آپ خودکار پیش‌فرض روشن است (BACKUP_ENABLED=0 خاموشش می‌کند)؛ هر ۲۴ ساعت و نگهداری ۱۴ نسخه */
export const backupConfig = () => ({
  enabled: process.env.BACKUP_ENABLED !== "0",
  keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 14),
  intervalHours: Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 24),
  dir: backupsDir(),
});

export type BackupResult =
  | { ok: true; name: string; tables: number; rows: number; files: number; removed: number; warnings: string[]; mirrorsOk: number; mirrorsFailed: number }
  | { ok: false; error: string };

function summarize(m: BackupManifest) {
  return { tables: m.tables.length, rows: m.tables.reduce((a, t) => a + t.rows, 0), files: m.files.length };
}

export async function runBackup(trigger: "scheduler" | "manual"): Promise<BackupResult> {
  const cfg = backupConfig();
  const databaseUrl = getConfig().databaseUrl;
  if (!databaseUrl) return { ok: false, error: "دیتابیس پیکربندی نشده است" };
  try {
    const r = await createBackup({
      databaseUrl,
      storageDir: STORAGE_DIR,
      backupDir: cfg.dir,
      keep: cfg.keep,
      sessionSecret: getConfig().sessionSecret || undefined,
      recoveryPublicKey: recoveryPublicKey() || undefined,
      mirrorDirs: mirrorDirs(),
    });
    const name = r.dir.split(/[\\/]/).pop() ?? "";
    const mirrorsOk = r.mirrors.filter((m) => m.ok).length;
    const mirrorsFailed = r.mirrors.length - mirrorsOk;
    await saveGlobalSetting(
      "backup_last",
      JSON.stringify({ at: new Date().toISOString(), ok: true, name, trigger, warnings: r.warnings, mirrorsOk, mirrorsFailed, mirrorErrors: r.mirrors.filter((m) => !m.ok).map((m) => `${m.dir}: ${m.error}`).slice(0, 3) }),
    ).catch(() => undefined);
    return { ok: true, name, ...summarize(r.manifest), removed: r.removed.length, warnings: r.warnings, mirrorsOk, mirrorsFailed };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 300) : "خطای ناشناخته";
    console.error("[backup]", error);
    await saveGlobalSetting("backup_last", JSON.stringify({ at: new Date().toISOString(), ok: false, error, trigger })).catch(() => undefined);
    return { ok: false, error };
  }
}

/** آیا از آخرین بک‌آپ کامل بیش از بازه‌ی تعیین‌شده گذشته است؟ */
export async function backupDue(): Promise<boolean> {
  const cfg = backupConfig();
  if (!cfg.enabled) return false;
  const [latest] = (await listBackups(cfg.dir)).filter((b) => b.ok);
  if (latest && Date.now() - latest.createdAt.getTime() < cfg.intervalHours * 3600_000) return false;
  // پس از یک خطا، دست‌کم یک ساعت صبر می‌کنیم تا سیستم زیر بار تلاش مکرر نرود
  try {
    const last = JSON.parse(await getGlobalSetting("backup_last")) as { at: string; ok: boolean };
    if (!last.ok && Date.now() - new Date(last.at).getTime() < 3600_000) return false;
  } catch {
    /* هنوز اجرایی ثبت نشده */
  }
  return true;
}

export async function runScheduledBackupIfDue(): Promise<void> {
  if (await backupDue()) await runBackup("scheduler");
}

export async function backupOverview() {
  const cfg = backupConfig();
  const list = await listBackups(cfg.dir);
  let last: { at: string; ok: boolean; error?: string; trigger?: string; warnings?: string[]; mirrorsOk?: number; mirrorsFailed?: number; mirrorErrors?: string[] } | null = null;
  try {
    last = JSON.parse(await getGlobalSetting("backup_last"));
  } catch {
    last = null;
  }
  const mirrors = mirrorDirs();
  return {
    cfg,
    list: list.slice(0, 10),
    last,
    recovery: recoveryStatus(),
    mirrorCount: mirrors.length,
    /** بک‌آپ‌ها روی همان volume داده‌ی اصلی‌اند (و هیچ آینه‌ی بیرونی تنظیم نشده) */
    insideDataVolume: isInside(cfg.dir, STORAGE_DIR) && !mirrors.some((m) => !isInside(m, STORAGE_DIR)),
  };
}

export async function verifyLatestBackup() {
  const [latest] = (await listBackups(backupConfig().dir)).filter((b) => b.ok);
  if (!latest) return null;
  return { name: latest.name, ...(await verifyBackup(latest.dir)) };
}
