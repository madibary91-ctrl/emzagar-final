import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { STORAGE_DIR } from "@/lib/config";
import { compareVersions, APP_VERSION } from "@/lib/version";
import { logAudit } from "@/modules/audit/service";
import { runBackup } from "@/modules/backup/service";
import { getGlobalSetting, saveGlobalSetting } from "@/modules/settings/service";
import { callLicenseServer, getInstanceId, getLicenseInfo, lastCheckedUpdateAt, licenseServerUrl, resolveDomain } from "./client";
import { decryptSecret } from "@/lib/crypto";

/**
 * به‌روزرسانی یک‌کلیکی (مثل وردپرس) برای نصب‌های «بسته‌ی release»:
 *  ۱) بررسی: سرور فروشنده (با لایسنس معتبر) نسخه‌ی جدید + SHA-256 را با امضای Ed25519 اعلام می‌کند.
 *  ۲) دانلود جریانی روی دیسک و تطبیق SHA-256 با مانیفست امضاشده.
 *  ۳) بک‌آپ کامل دیتابیس پیش از هر تغییر (ناموفق = توقف).
 *  ۴) استخراج جریانی در پوشه‌ی موقت با فهرست سفید مسیرها و جلوگیری از Zip-Slip (storage و .env هرگز لمس نمی‌شوند).
 *  ۵) جایگزینی با rename اتمی؛ نسخه‌ی قبلی در .update-rollback نگه‌داری می‌شود و در خطا خودکار برمی‌گردد.
 *  ۶) ری‌استارت پردازه؛ ساختار دیتابیس هنگام بالا آمدن خودکار ارتقا می‌یابد (applySchema).
 */
const ROOT = process.cwd();
const UPDATES_DIR = path.join(STORAGE_DIR, "updates");
const ROLLBACK_DIR = path.join(ROOT, ".update-rollback");
const STAGING_DIR = path.join(ROOT, ".update-staging");
const ALLOWED_TOP = new Set([".next", "node_modules", "public", "assets", "wordpress-plugin", "docs", "server.js", "app.js", "package.json", "README-FA.txt"]);
const MAX_ZIP = 600 * 1024 * 1024;
const MAX_EXTRACTED = 2 * 1024 * 1024 * 1024;

const g = globalThis as typeof globalThis & { __emzUpdating?: boolean };

export interface UpdateSupport {
  supported: boolean;
  reason: string;
}

export function updateSupport(): UpdateSupport {
  if (process.env.EMZ_UPDATER_DISABLED === "1") return { supported: false, reason: "به‌روزرسانی از داخل پنل توسط مدیر سرور غیرفعال شده است." };
  if (fs.existsSync("/.dockerenv") && process.env.EMZ_UPDATER_FORCE !== "1") {
    return { supported: false, reason: "این نصب در Docker اجرا می‌شود؛ برای به‌روزرسانی ایمیج را بگیرید: docker compose pull && docker compose up -d (داده‌ها حفظ می‌شود)." };
  }
  if (!fs.existsSync(path.join(ROOT, "server.js"))) return { supported: false, reason: "این نصب از «بسته‌ی آماده‌ی release» نیست (حالت سورس/توسعه). به‌روزرسانی را با git pull و build انجام دهید." };
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
  } catch {
    return { supported: false, reason: "پوشه‌ی برنامه روی سرور قابل نوشتن نیست." };
  }
  return { supported: true, reason: "" };
}

export interface UpdateInfo {
  checkedAt: string | null;
  updateAvailable: boolean;
  latest: { version: string; changelog: string; publishedAt: string; size: number; sha256: string; security: boolean } | null;
  error: string | null;
  current: string;
}

export async function getUpdateInfo(): Promise<UpdateInfo> {
  try {
    const raw = await getGlobalSetting("update_state");
    if (raw) {
      const s = JSON.parse(raw) as Omit<UpdateInfo, "current">;
      // اگر نسخه‌ی ثبت‌شده از نسخه‌ی فعلی بالاتر نیست، به‌روزرسانی در دسترس نیست
      const available = !!s.latest && compareVersions(s.latest.version, APP_VERSION) > 0;
      return { ...s, updateAvailable: available && s.updateAvailable, current: APP_VERSION };
    }
  } catch {
    /* خراب */
  }
  return { checkedAt: null, updateAvailable: false, latest: null, error: null, current: APP_VERSION };
}

async function saveUpdateState(s: Omit<UpdateInfo, "current">) {
  await saveGlobalSetting("update_state", JSON.stringify(s));
}

const licenseKey = async () => decryptSecret(await getGlobalSetting("license_key"));

/** بررسی نسخه‌ی جدید از سرور فروشنده */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const key = await licenseKey();
  if (!key) {
    const s = { checkedAt: new Date().toISOString(), updateAvailable: false, latest: null, error: "برای دریافت به‌روزرسانی ابتدا لایسنس را فعال کنید." };
    await saveUpdateState(s);
    return { ...s, current: APP_VERSION };
  }
  try {
    const r = await callLicenseServer("/api/updates/v1/check", { key, domain: await resolveDomain(), version: APP_VERSION, channel: process.env.UPDATE_CHANNEL === "beta" ? "beta" : "stable" });
    if (r.data.valid !== true) {
      const s = { checkedAt: new Date().toISOString(), updateAvailable: false, latest: null, error: "لایسنس معتبر نیست؛ وضعیت لایسنس را بررسی کنید." };
      await saveUpdateState(s);
      return { ...s, current: APP_VERSION };
    }
    const latest = (r.data.latest ?? null) as UpdateInfo["latest"];
    const s = { checkedAt: new Date().toISOString(), updateAvailable: !!latest && r.data.updateAvailable === true && compareVersions(latest.version, APP_VERSION) > 0, latest, error: null };
    await saveUpdateState(s);
    return { ...s, current: APP_VERSION };
  } catch (e) {
    const prev = await getUpdateInfo();
    const s = { checkedAt: new Date().toISOString(), updateAvailable: prev.updateAvailable, latest: prev.latest, error: e instanceof Error ? e.message : "بررسی ناموفق بود" };
    await saveUpdateState(s);
    return { ...s, current: APP_VERSION };
  }
}

export async function checkUpdatesIfDue(): Promise<void> {
  if (!(await licenseKey())) return;
  if (Date.now() - (await lastCheckedUpdateAt()) < 23 * 3600_000) return;
  await checkForUpdate();
}

/* ───────── دانلود ───────── */

async function download(version: string, expectedSha: string, expectedSize: number): Promise<string> {
  fs.mkdirSync(UPDATES_DIR, { recursive: true, mode: 0o700 });
  const key = await licenseKey();
  const file = path.join(UPDATES_DIR, `emzagar-${version}.zip`);
  const part = `${file}.part`;
  let res: Response;
  try {
    res = await fetch(`${licenseServerUrl()}/api/updates/v1/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, domain: await resolveDomain(), version, instanceId: await getInstanceId() }),
      redirect: "error",
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch {
    throw new Error("ارتباط با سرور دانلود برقرار نشد");
  }
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    const map: Record<string, string> = { updates_expired: "مدت دسترسی شما به به‌روزرسانی‌ها تمام شده است", invalid_license: "لایسنس معتبر نیست", release_not_found: "این نسخه روی سرور موجود نیست", rate_limited: "تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کنید" };
    throw new Error(map[j?.error ?? ""] ?? `دانلود ناموفق بود (${res.status})`);
  }
  const hash = crypto.createHash("sha256");
  let size = 0;
  const out = fs.createWriteStream(part, { mode: 0o600 });
  try {
    for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_ZIP) throw new Error("حجم فایل به‌روزرسانی بیش از حد مجاز است");
      hash.update(buf);
      if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  const sha = hash.digest("hex");
  if (sha !== expectedSha || (expectedSize && size !== expectedSize)) {
    fs.rmSync(part, { force: true });
    throw new Error("اثر انگشت فایل دانلودشده با مانیفست امضاشده یکی نیست؛ دانلود دستکاری یا ناقص بوده و نصب نشد.");
  }
  fs.renameSync(part, file);
  return file;
}

/* ───────── استخراج امن ───────── */

/** مسیر داخل zip را به مسیر نسبی امن تبدیل می‌کند؛ نامعتبر/خارج از فهرست سفید = null */
export function safeEntryPath(name: string, prefix: string): string | null {
  if (name.endsWith("/") || name.includes("\0") || name.includes("\\")) return null;
  if (prefix && !name.startsWith(prefix)) return null;
  const rel = path.posix.normalize(name.slice(prefix.length));
  if (!rel || rel.startsWith("../") || rel === ".." || path.posix.isAbsolute(rel)) return null;
  return ALLOWED_TOP.has(rel.split("/")[0]) ? rel : null;
}

/** پیشوند بسته: «emzagar/» (خروجی build-release) یا ریشه */
function detectPrefix(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const uz = new Unzip();
    uz.register(UnzipInflate);
    uz.register(UnzipPassThrough);
    let found: string | null = null;
    uz.onfile = (f) => {
      if (f.name === "server.js") found ??= "";
      else if (/^[^/]+\/server\.js$/.test(f.name)) found ??= f.name.replace(/server\.js$/, "");
    };
    const s = fs.createReadStream(file);
    s.on("data", (c) => uz.push(new Uint8Array(c as Buffer)));
    s.on("error", reject);
    s.on("end", () => {
      uz.push(new Uint8Array(0), true);
      found === null ? reject(new Error("بسته‌ی به‌روزرسانی معتبر نیست (server.js پیدا نشد)")) : resolve(found);
    });
  });
}

async function extract(file: string, dest: string): Promise<void> {
  const prefix = await detectPrefix(file);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const destResolved = path.resolve(dest) + path.sep;
  let total = 0;
  let failure: Error | null = null;
  await new Promise<void>((resolve, reject) => {
    const uz = new Unzip();
    uz.register(UnzipInflate);
    uz.register(UnzipPassThrough);
    uz.onfile = (f) => {
      const rel = safeEntryPath(f.name, prefix);
      if (!rel) return; // نادیده (مسیر ناامن یا خارج از فهرست سفید)
      const target = path.resolve(dest, rel);
      if (!target.startsWith(destResolved)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, "w");
      f.ondata = (err, chunk, final) => {
        if (err) {
          failure ??= err;
          return;
        }
        total += chunk.length;
        if (total > MAX_EXTRACTED) failure ??= new Error("حجم بسته‌ی استخراج‌شده بیش از حد مجاز است");
        if (!failure) fs.writeSync(fd, chunk);
        if (final) fs.closeSync(fd);
      };
      f.start();
    };
    const s = fs.createReadStream(file);
    s.on("data", (c) => {
      try {
        uz.push(new Uint8Array(c as Buffer));
      } catch (e) {
        failure ??= e as Error;
      }
    });
    s.on("error", reject);
    s.on("end", () => {
      try {
        uz.push(new Uint8Array(0), true);
      } catch (e) {
        failure ??= e as Error;
      }
      failure ? reject(failure) : resolve();
    });
  });
  if (!fs.existsSync(path.join(dest, "server.js")) || !fs.existsSync(path.join(dest, ".next"))) throw new Error("بسته‌ی به‌روزرسانی ناقص است (.next یا server.js وجود ندارد)");
}

function move(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** جایگزینی اتمی با امکان بازگشت خودکار در خطا */
function applyStaged(staged: string, rollbackTo: string): string[] {
  const entries = fs.readdirSync(staged).filter((e) => ALLOWED_TOP.has(e));
  fs.mkdirSync(rollbackTo, { recursive: true });
  const moved: string[] = [];
  try {
    for (const e of entries) {
      const live = path.join(ROOT, e);
      if (fs.existsSync(live)) {
        move(live, path.join(rollbackTo, e));
        moved.push(e);
      }
      move(path.join(staged, e), live);
    }
  } catch (err) {
    for (const e of [...moved].reverse()) {
      fs.rmSync(path.join(ROOT, e), { recursive: true, force: true });
      move(path.join(rollbackTo, e), path.join(ROOT, e));
    }
    throw err;
  }
  return entries;
}

export function scheduleRestart(delayMs = 2000) {
  // Passenger / cPanel: لمس tmp/restart.txt؛ سایر مدیرهای پردازه (Docker, systemd, pm2): خروج و راه‌اندازی دوباره
  try {
    const tmp = path.join(ROOT, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "restart.txt"), String(Date.now()));
  } catch {
    /* ناچیز */
  }
  if (process.env.NODE_ENV === "production") setTimeout(() => process.exit(0), delayMs).unref?.();
}

interface HistoryItem {
  at: string;
  from: string;
  to: string;
  kind: "update" | "rollback";
}

async function pushHistory(item: HistoryItem) {
  let list: HistoryItem[] = [];
  try {
    list = JSON.parse((await getGlobalSetting("update_history")) || "[]") as HistoryItem[];
  } catch {
    list = [];
  }
  await saveGlobalSetting("update_history", JSON.stringify([item, ...list].slice(0, 12)));
}

export async function getUpdateHistory(): Promise<HistoryItem[]> {
  try {
    return JSON.parse((await getGlobalSetting("update_history")) || "[]") as HistoryItem[];
  } catch {
    return [];
  }
}

export function rollbackAvailable(): string | null {
  try {
    const dirs = fs.readdirSync(ROLLBACK_DIR).sort();
    return dirs.at(-1) ?? null;
  } catch {
    return null;
  }
}

export type UpdateResult = { ok: true; version: string; message: string } | { ok: false; error: string };

/** نصب نسخه‌ی جدید (کل فرایند ۱ تا ۶) */
export async function installUpdate(actorId: number): Promise<UpdateResult> {
  const support = updateSupport();
  if (!support.supported) return { ok: false, error: support.reason };
  if (g.__emzUpdating) return { ok: false, error: "یک به‌روزرسانی در حال انجام است" };
  g.__emzUpdating = true;
  try {
    const lic = await getLicenseInfo();
    if (!lic.licensed) return { ok: false, error: "برای به‌روزرسانی، لایسنس باید فعال و معتبر باشد." };
    const info = await checkForUpdate(); // مانیفست تازه و امضاشده
    if (!info.updateAvailable || !info.latest) return { ok: false, error: info.error ?? "نسخه‌ی جدیدتری موجود نیست." };
    const { version, sha256, size } = info.latest;

    const zip = await download(version, sha256, size);
    const backup = await runBackup("manual");
    if (!backup.ok) throw new Error(`پشتیبان‌گیری پیش از به‌روزرسانی ناموفق بود؛ نصب انجام نشد (${backup.error})`);

    await extract(zip, STAGING_DIR);
    const rollbackTo = path.join(ROLLBACK_DIR, `${APP_VERSION}-${Date.now()}`);
    applyStaged(STAGING_DIR, rollbackTo);
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    // نگه‌داشتن فقط ۲ نسخه‌ی بازگشت
    const olds = fs.readdirSync(ROLLBACK_DIR).sort();
    for (const d of olds.slice(0, Math.max(0, olds.length - 2))) fs.rmSync(path.join(ROLLBACK_DIR, d), { recursive: true, force: true });

    await pushHistory({ at: new Date().toISOString(), from: APP_VERSION, to: version, kind: "update" });
    await saveUpdateState({ checkedAt: new Date().toISOString(), updateAvailable: false, latest: info.latest, error: null });
    await logAudit({ workspaceId: 0, userId: actorId, action: "update.installed", detail: `${APP_VERSION} ← ${version}` }).catch(() => undefined);
    scheduleRestart();
    return { ok: true, version, message: `نسخه‌ی ${version} نصب شد. برنامه تا چند ثانیه‌ی دیگر دوباره راه‌اندازی می‌شود؛ سپس صفحه را تازه کنید.` };
  } catch (e) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    return { ok: false, error: e instanceof Error ? e.message : "به‌روزرسانی ناموفق بود" };
  } finally {
    g.__emzUpdating = false;
  }
}

/** بازگشت به نسخه‌ی پیش از آخرین به‌روزرسانی */
export async function rollbackUpdate(actorId: number): Promise<UpdateResult> {
  const support = updateSupport();
  if (!support.supported) return { ok: false, error: support.reason };
  const name = rollbackAvailable();
  if (!name) return { ok: false, error: "نسخه‌ای برای بازگشت وجود ندارد." };
  if (g.__emzUpdating) return { ok: false, error: "یک عملیات در حال انجام است" };
  g.__emzUpdating = true;
  try {
    const dir = path.join(ROLLBACK_DIR, name);
    const swap = path.join(ROLLBACK_DIR, `.swap-${Date.now()}`);
    applyStaged(dir, swap);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(swap, { recursive: true, force: true });
    const version = name.split("-")[0];
    await pushHistory({ at: new Date().toISOString(), from: APP_VERSION, to: version, kind: "rollback" });
    await logAudit({ workspaceId: 0, userId: actorId, action: "update.rolled_back", detail: `${APP_VERSION} ← ${version}` }).catch(() => undefined);
    scheduleRestart();
    return { ok: true, version, message: `به نسخه‌ی ${version} بازگشت داده شد؛ برنامه دوباره راه‌اندازی می‌شود.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "بازگشت ناموفق بود" };
  } finally {
    g.__emzUpdating = false;
  }
}
