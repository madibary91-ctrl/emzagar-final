/**
 * هسته‌ی بک‌آپ و بازیابی — «مستقل» از برنامه (بدون import با alias) تا هم داخل برنامه (زمان‌بند) و هم
 * از خط فرمان (scripts/backup.ts · scripts/restore.ts) اجرا شود و روی هاست‌های بدون pg_dump هم کار کند.
 *
 * ساختار هر بک‌آپ (یک پوشه‌ی خودبسنده):
 *   backup-YYYYMMDD-HHMMSS/
 *     manifest.json            فهرست همه‌ی فایل‌ها + SHA-256 هرکدام + تعداد ردیف جدول‌ها
 *     db/<table>.copy.gz       خروجی COPY هر جدول (فشرده)
 *     files/signatures/*       تصویر امضاها
 *     files/documents/*        PDF قراردادهای نهایی
 *     files/attachments/*      پیوست‌های قرارداد (کارت ملی، فاکتور …)
 *     files/kyc/*              مدارک احراز هویت (KYC) — همان فایل‌های «رمزنگاری‌شده» با AES-256-GCM (CR-04)
 *     secrets.sealed.json      SESSION_SECRET (کلید رمزگشایی KYC و رازهای دیتابیس) «مهر و موم‌شده» با کلید عمومی بازیابی (CR-04)
 *
 * CR-04 — بک‌آپ ناقص:
 *   «مدارک KYC و SESSION_SECRET در بک‌آپ نیستند و نسخه‌ها روی همان volume داده‌ی اصلی ذخیره می‌شوند.»
 *   ۱. KYC اکنون در بک‌آپ است؛ بدون SESSION_SECRET بی‌مصرف است، پس راز هم همراه بک‌آپ می‌آید ولی «هرگز به‌صورت متن ساده»:
 *      با رمزنگاری ترکیبی (X25519 + HKDF-SHA256 + AES-256-GCM، «sealed box») فقط برای «کلید بازیابی» مالک مهر می‌شود.
 *      کلید خصوصی بازیابی هرگز روی سرور نمی‌ماند؛ پس دزدیدن بک‌آپ (یا حتی هک سرور) راز را فاش نمی‌کند، و
 *      با از دست رفتن کامل سرور، بک‌آپ + کلید بازیابی برای بازگشت کامل کافی است.
 *   ۲. نسخه‌ها می‌توانند هم‌زمان به مقصدهای آینه (mirrorDirs: دیسک/NFS/mount دیگر) کپی و در مقصد دوباره راستی‌آزمایی شوند؛
 *      و اگر هیچ نسخه‌ای خارج از volume داده نباشد، هشدار «backups-inside-data-volume» ثبت می‌شود.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Pool } from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";

export const BACKUP_PREFIX = "backup-";
const NAME_RE = /^backup-\d{8}-\d{6}$/;
const FILE_DIRS = ["signatures", "documents", "attachments", "kyc"] as const;
export const SECRETS_FILE = "secrets.sealed.json";
const SEAL_ALG = "x25519-hkdf-sha256-aes256gcm-v1";

export interface BackupTableInfo {
  name: string;
  rows: number;
  columns: string[];
  file: string;
  sha256: string;
  bytes: number;
}
export interface BackupFileInfo {
  path: string;
  sha256: string;
  bytes: number;
}
export interface BackupSecretsInfo {
  file: string;
  sha256: string;
  bytes: number;
  alg: string;
  /** اثر انگشت کلید عمومی گیرنده (برای اینکه مالک بداند با کدام کلید بازیابی مهر شده) */
  recipient: string;
}
export interface BackupManifest {
  version: 1;
  createdAt: string;
  tables: BackupTableInfo[];
  files: BackupFileInfo[];
  /** رازهای مهر‌شده (اختیاری؛ بک‌آپ‌های قدیمی ندارند) */
  secrets?: BackupSecretsInfo;
  /** هشدارهای قابل‌نمایش: secret-not-sealed · backups-inside-data-volume · mirror-failed */
  warnings?: string[];
}

export interface MirrorResult {
  dir: string;
  ok: boolean;
  error?: string;
  /** حذف‌شده‌ها به‌خاطر سیاست نگهداری در مقصد */
  removed?: number;
}

export interface BackupOptions {
  databaseUrl: string;
  storageDir: string;
  backupDir: string;
  /** چند بک‌آپ آخر نگه داشته شود (پیش‌فرض ۱۴) */
  keep?: number;
  /** SESSION_SECRET فعلی؛ فقط وقتی همراه recoveryPublicKey باشد (مهر‌شده) در بک‌آپ قرار می‌گیرد */
  sessionSecret?: string;
  /** کلید عمومی بازیابی (خروجی generateRecoveryKeyPair().publicKey) */
  recoveryPublicKey?: string;
  /** مقصدهای آینه‌ی بک‌آپ (مسیرهای روی دیسک/mount دیگر) */
  mirrorDirs?: string[];
}


/* ───────── کلید بازیابی و مهر و موم رازها (sealed box) ───────── */
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const PRIV_PREFIX = "emz-rk1-";

const pubObj = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const privObj = (raw: Buffer) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });

function parsePublic(b64: string): Buffer {
  const raw = Buffer.from(b64.trim(), "base64url");
  if (raw.length !== 32) throw new Error("کلید عمومی بازیابی نامعتبر است");
  return raw;
}
function parsePrivate(text: string): Buffer {
  const t = text.trim();
  const raw = Buffer.from(t.startsWith(PRIV_PREFIX) ? t.slice(PRIV_PREFIX.length) : t, "base64url");
  if (raw.length !== 32) throw new Error("کلید بازیابی نامعتبر است");
  return raw;
}

/** اثر انگشت کوتاه و قابل‌خواندن کلید عمومی: «A1B2-C3D4-E5F6-0718» */
export function recoveryFingerprint(publicKey: string): string {
  const h = crypto.createHash("sha256").update(parsePublic(publicKey)).digest("hex").slice(0, 16).toUpperCase();
  return h.match(/.{4}/g)!.join("-");
}

/** جفت‌کلید بازیابی؛ publicKey روی سرور می‌ماند، privateKey فقط یک بار به مالک نشان داده می‌شود */
export function generateRecoveryKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const priv = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
  return { publicKey: Buffer.from(pub).toString("base64url"), privateKey: PRIV_PREFIX + Buffer.from(priv).toString("base64url") };
}

function sealKey(shared: Buffer, epk: Buffer, rpk: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([epk, rpk]), "emz-backup-secrets-v1", 32));
}

/** مهر و موم: فقط دارنده‌ی کلید خصوصی بازیابی می‌تواند باز کند */
export function sealSecrets(payload: { sessionSecret: string }, recoveryPublicKey: string): string {
  const rpk = parsePublic(recoveryPublicKey);
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = Buffer.from((eph.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
  const key = sealKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubObj(rpk) }), epk, rpk);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("emz-backup-secrets-v1"));
  const ct = Buffer.concat([c.update(JSON.stringify({ v: 1, sessionSecret: payload.sessionSecret, sealedAt: new Date().toISOString() }), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, alg: SEAL_ALG, epk: epk.toString("base64url"), iv: iv.toString("base64url"), tag: c.getAuthTag().toString("base64url"), ct: ct.toString("base64url") }, null, 2);
}

export function openSecrets(sealedJson: string, recoveryPrivateKey: string): { sessionSecret: string } {
  let obj: { alg: string; epk: string; iv: string; tag: string; ct: string };
  try {
    obj = JSON.parse(sealedJson);
  } catch {
    throw new Error("فایل رازهای مهر‌شده خراب است");
  }
  if (obj.alg !== SEAL_ALG) throw new Error("الگوریتم مهر و موم پشتیبانی نمی‌شود");
  try {
    const priv = parsePrivate(recoveryPrivateKey);
    const epk = Buffer.from(obj.epk, "base64url");
    const rpk = Buffer.from((crypto.createPublicKey(privObj(priv)).export({ format: "der", type: "spki" }) as Buffer).subarray(-32));
    const key = sealKey(crypto.diffieHellman({ privateKey: privObj(priv), publicKey: pubObj(epk) }), epk, rpk);
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(obj.iv, "base64url"));
    d.setAAD(Buffer.from("emz-backup-secrets-v1"));
    d.setAuthTag(Buffer.from(obj.tag, "base64url"));
    const plain = JSON.parse(Buffer.concat([d.update(Buffer.from(obj.ct, "base64url")), d.final()]).toString("utf8")) as { sessionSecret?: string };
    if (!plain.sessionSecret) throw new Error("empty");
    return { sessionSecret: plain.sessionSecret };
  } catch {
    throw new Error("کلید بازیابی اشتباه است (یا فایل دستکاری شده است)");
  }
}

/** باز کردن رازِ مهر‌شده‌ی یک پوشه‌ی بک‌آپ (برای «تمرین بازیابی» و restore) */
export async function openBackupSecrets(backupDir: string, recoveryPrivateKey: string): Promise<{ sessionSecret: string } | null> {
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(backupDir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    throw new Error("manifest.json خوانده نشد");
  }
  if (!manifest.secrets) return null;
  return openSecrets(await fsp.readFile(path.join(backupDir, manifest.secrets.file), "utf8"), recoveryPrivateKey);
}

/** آیا مسیر `inner` داخل (یا برابر) `outer` است؟ (با realpath؛ پوشه‌ی ناموجود ← نزدیک‌ترین والد موجود) */
export function isInside(inner: string, outer: string): boolean {
  const real = (p: string) => {
    let cur = path.resolve(p);
    const tail: string[] = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...tail.reverse());
      } catch {
        const up = path.dirname(cur);
        if (up === cur) return path.resolve(p);
        tail.push(path.basename(cur));
        cur = up;
      }
    }
  };
  const rel = path.relative(real(outer), real(inner));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  await pipeline(
    fs.createReadStream(file),
    async function* (src) {
      for await (const chunk of src as AsyncIterable<Buffer>) {
        h.update(chunk);
        bytes += chunk.length;
      }
    },
  );
  return { sha256: h.digest("hex"), bytes };
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** قفل ساده‌ی فایلی: جلوگیری از اجرای هم‌زمان دو بک‌آپ (قفل مانده بیش از ۲ ساعت باطل است) */
async function acquireLock(dir: string): Promise<() => Promise<void>> {
  const lock = path.join(dir, ".lock");
  try {
    const st = await fsp.stat(lock);
    if (Date.now() - st.mtimeMs < 2 * 3600_000) throw new Error("بک‌آپ دیگری در حال اجراست");
    await fsp.unlink(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const fd = await fsp.open(lock, "wx", 0o600);
  await fd.writeFile(String(process.pid));
  await fd.close();
  return () => fsp.unlink(lock).catch(() => undefined);
}

async function copyDirFlat(src: string, dest: string, prefix: string, out: BackupFileInfo[]) {
  let names: string[] = [];
  try {
    names = await fsp.readdir(src);
  } catch {
    return; // پوشه هنوز ساخته نشده (هیچ امضایی ثبت نشده)
  }
  await fsp.mkdir(dest, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (name.startsWith(".") || name.endsWith(".tmp")) continue;
    const from = path.join(src, name);
    const st = await fsp.stat(from);
    if (!st.isFile()) continue;
    const to = path.join(dest, name);
    await fsp.copyFile(from, to);
    await fsp.chmod(to, 0o600);
    const { sha256, bytes } = await hashFile(to);
    out.push({ path: `${prefix}/${name}`, sha256, bytes });
  }
}

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

/** ساخت یک بک‌آپ کامل (دیتابیس + امضاها + PDFها) و حذف بک‌آپ‌های قدیمی */
export interface BackupResultInfo {
  dir: string;
  manifest: BackupManifest;
  removed: string[];
  mirrors: MirrorResult[];
  /** هشدارهای «نهایی» (شامل شکست آینه‌ها) برای نمایش به مدیر */
  warnings: string[];
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

async function chmodTree(root: string): Promise<void> {
  await fsp.chmod(root, 0o700);
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) await chmodTree(p);
    else await fsp.chmod(p, 0o600);
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

/** بررسی صحت: مجموع SHA-256 همه‌ی فایل‌ها با manifest مطابقت دارد و چیزی کم نیست */
export async function verifyBackup(dir: string): Promise<{ ok: boolean; problems: string[]; manifest?: BackupManifest }> {
  const problems: string[] = [];
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    return { ok: false, problems: ["manifest.json خوانده نشد (بک‌آپ ناتمام یا خراب است)"] };
  }
  if (manifest.version !== 1) problems.push("نسخه‌ی بک‌آپ پشتیبانی نمی‌شود");
  const entries = [
    ...manifest.tables.map((t) => ({ p: t.file, sha: t.sha256 })),
    ...manifest.files.map((f) => ({ p: f.path, sha: f.sha256 })),
    ...(manifest.secrets ? [{ p: manifest.secrets.file, sha: manifest.secrets.sha256 }] : []),
  ];
  for (const e of entries) {
    const abs = path.join(dir, e.p);
    if (!abs.startsWith(path.resolve(dir) + path.sep) && !abs.startsWith(dir + path.sep)) {
      problems.push(`مسیر نامعتبر: ${e.p}`);
      continue;
    }
    try {
      const { sha256 } = await hashFile(abs);
      if (sha256 !== e.sha) problems.push(`هش ناهمخوان: ${e.p}`);
    } catch {
      problems.push(`فایل گم شده: ${e.p}`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

export interface RestoreOptions {
  /** پوشه‌ی یک بک‌آپ */
  backup: string;
  databaseUrl: string;
  storageDir: string;
  /** دستورهای ساخت جدول (SCHEMA_CREATE) تا روی دیتابیس خالی هم کار کند */
  schemaStatements: string[];
  /** کلید خصوصی بازیابی (emz-rk1-…): برای باز کردن SESSION_SECRET مهر‌شده؛ اگر بک‌آپ راز دارد و این نباشد، بازیابی شروع نمی‌شود */
  recoveryKey?: string;
  /** عمداً بدون راز بازیابی شود (مدارک KYC و رازهای رمزنگاری‌شده‌ی دیتابیس خوانا نخواهند بود) */
  skipSecrets?: boolean;
}

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
