import { BACKUP_PREFIX, type BackupFileInfo, type BackupManifest, type BackupOptions, type BackupResultInfo, type BackupSecretsInfo, type BackupTableInfo, FILE_DIRS, type MirrorResult, NAME_RE, SEAL_ALG, SECRETS_FILE } from "./types";
import { Pool } from "pg";
import { acquireLock, chmodTree, copyDirFlat, hashFile, isInside, q, stamp } from "./fs-utils";
import { to as copyTo } from "pg-copy-streams";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { recoveryFingerprint, sealSecrets } from "./secrets";
import { verifyBackup } from "./verify";
import zlib from "node:zlib";

export async function listBackups(backupDir: string): Promise<{ name: string; dir: string; createdAt: Date; ok: boolean }[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(backupDir);
  } catch {
    return [];
  }
  const out: { name: string; dir: string; createdAt: Date; ok: boolean }[] = [];
  for (const name of names.filter((n) => NAME_RE.test(n)).sort().reverse()) {
    const dir = path.join(backupDir, name);
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
      out.push({ name, dir, createdAt: new Date(m.createdAt), ok: true });
    } catch {
      out.push({ name, dir, createdAt: new Date(0), ok: false }); // ناتمام (manifest آخر نوشته می‌شود)
    }
  }
  return out;
}
export async function createBackup(opts: BackupOptions): Promise<BackupResultInfo> {
  await fsp.mkdir(opts.backupDir, { recursive: true, mode: 0o700 });
  const release = await acquireLock(opts.backupDir);
  const dir = path.join(opts.backupDir, `${BACKUP_PREFIX}${stamp()}`);
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined);
  try {
    await fsp.mkdir(path.join(dir, "db"), { recursive: true, mode: 0o700 });
    const tables: BackupTableInfo[] = [];
    const client = await pool.connect();
    try {
      // یک تصویر منسجم از کل دیتابیس (همه‌ی جدول‌ها در یک تراکنش)
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const list = await client.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name",
      );
      for (const { table_name: name } of list.rows) {
        const cols = await client.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1 order by ordinal_position",
          [name],
        );
        const columns = cols.rows.map((c) => c.column_name);
        const count = await client.query<{ n: string }>(`select count(*)::text as n from ${q(name)}`);
        const file = `db/${name}.copy.gz`;
        const target = path.join(dir, file);
        const stream = client.query(copyTo(`COPY (SELECT ${columns.map(q).join(", ")} FROM ${q(name)}) TO STDOUT`));
        await pipeline(stream, zlib.createGzip({ level: 6 }), fs.createWriteStream(target, { mode: 0o600 }));
        const { sha256, bytes } = await hashFile(target);
        tables.push({ name, rows: Number(count.rows[0].n), columns, file, sha256, bytes });
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }

    const files: BackupFileInfo[] = [];
    for (const d of FILE_DIRS) await copyDirFlat(path.join(opts.storageDir, d), path.join(dir, "files", d), `files/${d}`, files);

    // رازها: فقط «مهر‌شده» (هرگز متن ساده) و فقط وقتی کلید عمومی بازیابی تنظیم شده باشد
    const warnings: string[] = [];
    let secrets: BackupSecretsInfo | undefined;
    if (opts.sessionSecret) {
      if (opts.recoveryPublicKey) {
        const target = path.join(dir, SECRETS_FILE);
        await fsp.writeFile(target, sealSecrets({ sessionSecret: opts.sessionSecret }, opts.recoveryPublicKey), { mode: 0o600 });
        const { sha256, bytes } = await hashFile(target);
        secrets = { file: SECRETS_FILE, sha256, bytes, alg: SEAL_ALG, recipient: recoveryFingerprint(opts.recoveryPublicKey) };
      } else {
        warnings.push("secret-not-sealed");
      }
    }
    const mirrorRoots = [...new Set((opts.mirrorDirs ?? []).map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d)))];
    const offVolume = (d: string) => !isInside(d, opts.storageDir);
    const needsOffVolume = !offVolume(opts.backupDir);
    if (needsOffVolume && !mirrorRoots.some(offVolume)) warnings.push("backups-inside-data-volume");

    const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), tables, files, ...(secrets ? { secrets } : {}), ...(warnings.length ? { warnings: [...warnings] } : {}) };
    // manifest «آخر» نوشته می‌شود؛ نبودنش یعنی بک‌آپ ناتمام است
    const tmp = path.join(dir, "manifest.json.tmp");
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, path.join(dir, "manifest.json"));

    const v = await verifyBackup(dir);
    if (!v.ok) throw new Error(`بررسی صحت بک‌آپ ناموفق بود: ${v.problems.slice(0, 3).join("؛ ")}`);

    const keep = Math.max(1, opts.keep ?? 14);
    const removed = await applyRetention(opts.backupDir, keep, path.basename(dir));

    // آینه‌ها: شکست آینه بک‌آپ اصلی را خراب نمی‌کند ولی «هشدار» می‌شود
    const mirrors: MirrorResult[] = [];
    for (const root of mirrorRoots) mirrors.push(await mirrorBackup(dir, root, opts.backupDir, keep));
    const final = [...warnings];
    if (mirrors.some((m) => !m.ok)) final.push("mirror-failed");
    if (needsOffVolume && !mirrors.some((m) => m.ok && offVolume(m.dir)) && !final.includes("backups-inside-data-volume")) final.push("backups-inside-data-volume");
    return { dir, manifest, removed, mirrors, warnings: final };
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined); // بک‌آپ ناتمام باقی نمی‌ماند
    throw e;
  } finally {
    await pool.end().catch(() => undefined);
    await release();
  }
}
/** کپی یک بک‌آپ کامل به مقصد آینه، راستی‌آزمایی «در مقصد»، سپس جابه‌جایی اتمی و اعمال سیاست نگهداری */
async function mirrorBackup(dir: string, root: string, primaryRoot: string, keep: number): Promise<MirrorResult> {
  const name = path.basename(dir);
  const tmp = path.join(root, `.${name}.partial`);
  try {
    if (path.resolve(root) === path.resolve(primaryRoot) || isInside(root, dir)) throw new Error("مقصد آینه با مقصد اصلی یکی است");
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.cp(dir, tmp, { recursive: true });
    await chmodTree(tmp);
    const v = await verifyBackup(tmp);
    if (!v.ok) throw new Error(`نسخه‌ی آینه سالم نیست: ${v.problems.slice(0, 2).join("؛ ")}`);
    await fsp.rm(path.join(root, name), { recursive: true, force: true });
    await fsp.rename(tmp, path.join(root, name));
    const removed = await applyRetention(root, keep, name);
    return { dir: root, ok: true, removed: removed.length };
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { dir: root, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "خطای ناشناخته" };
  }
}
async function applyRetention(backupDir: string, keep: number, current: string): Promise<string[]> {
  const all = await listBackups(backupDir);
  const removed: string[] = [];
  // ناتمام‌ها همیشه پاک می‌شوند؛ از کامل‌ها فقط `keep` تای آخر می‌ماند
  const complete = all.filter((b) => b.ok);
  for (const b of all) {
    const idx = complete.findIndex((c) => c.name === b.name);
    const stale = !b.ok ? b.name !== current : idx >= keep;
    if (stale) {
      await fsp.rm(b.dir, { recursive: true, force: true });
      removed.push(b.name);
    }
  }
  return removed;
}
