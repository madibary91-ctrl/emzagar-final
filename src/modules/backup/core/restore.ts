import { Pool } from "pg";
import { type RestoreOptions } from "./types";
import { from as copyFrom } from "pg-copy-streams";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { openBackupSecrets } from "./secrets";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { q } from "./fs-utils";
import { verifyBackup } from "./verify";
import zlib from "node:zlib";

/** SESSION_SECRET بازیابی‌شده را در storage/config.json می‌نویسد (اتمی، فقط مالک) */
async function writeSessionSecret(storageDir: string, secret: string): Promise<void> {
  const file = path.join(storageDir, "config.json");
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* هنوز نیست */
  }
  await fsp.mkdir(storageDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ ...cur, sessionSecret: secret }, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, file);
}
/** بازیابی کامل: محتوای فعلی جدول‌ها با بک‌آپ جایگزین می‌شود (در یک تراکنش؛ اگر خطا شد هیچ تغییری اعمال نمی‌شود) */
export async function restoreBackup(opts: RestoreOptions): Promise<{ tables: number; rows: number; files: number; secretsRestored: boolean }> {
  const check = await verifyBackup(opts.backup);
  if (!check.ok || !check.manifest) throw new Error(`بک‌آپ معتبر نیست: ${check.problems.join("؛ ")}`);
  const manifest = check.manifest;
  // راز مهر‌شده «پیش از هر تغییر» باز می‌شود: کلید غلط/نبود کلید ← هیچ چیز دست نمی‌خورد
  let restoredSecret: string | null = null;
  if (manifest.secrets && !opts.skipSecrets) {
    if (!opts.recoveryKey) throw new Error(`این بک‌آپ شامل رازهای مهر‌شده (SESSION_SECRET) است؛ «کلید بازیابی» (emz-rk1-…) لازم است. اثر انگشت کلید: ${manifest.secrets.recipient}`);
    restoredSecret = (await openBackupSecrets(opts.backup, opts.recoveryKey))?.sessionSecret ?? null;
  }
  const pool = new Pool({ connectionString: opts.databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined);
  const client = await pool.connect();
  let rows = 0;
  try {
    await client.query("BEGIN");
    // DB-01: Foreign Keyها DEFERRABLE‌اند؛ ترتیب بارگذاری جدول‌ها مهم نیست و یکپارچگی ارجاعی در COMMIT سنجیده می‌شود
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const st of opts.schemaStatements) await client.query(st);
    const names = manifest.tables.map((t) => q(t.name)).join(", ");
    if (names) await client.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    for (const t of manifest.tables) {
      if (t.rows === 0) continue;
      const stream = client.query(copyFrom(`COPY ${q(t.name)} (${t.columns.map(q).join(", ")}) FROM STDIN`));
      await pipeline(fs.createReadStream(path.join(opts.backup, t.file)), zlib.createGunzip(), stream);
      rows += t.rows;
    }
    // همگام‌سازی شمارنده‌ی شناسه‌ها (serial) با بیشینه‌ی شناسه‌ی بازیابی‌شده
    const seqs = await client.query<{ t: string; c: string; s: string }>(
      `select table_name as t, column_name as c, pg_get_serial_sequence(quote_ident(table_name), column_name) as s
         from information_schema.columns where table_schema = current_schema() and column_default like 'nextval(%'`,
    );
    for (const s of seqs.rows) {
      if (!s.s) continue;
      await client.query(`select setval($1, coalesce((select max(${q(s.c)}) from ${q(s.t)}), 0) + 1, false)`, [s.s]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }

  let files = 0;
  for (const f of manifest.files) {
    const to = path.join(opts.storageDir, f.path.replace(/^files\//, ""));
    await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await fsp.copyFile(path.join(opts.backup, f.path), to);
    await fsp.chmod(to, 0o600);
    files++;
  }
  if (restoredSecret) await writeSessionSecret(opts.storageDir, restoredSecret);
  return { tables: manifest.tables.length, rows, files, secretsRestored: !!restoredSecret };
}
