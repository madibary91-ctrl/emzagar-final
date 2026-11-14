import { ALLOWED_TOP, MAX_EXTRACTED, MAX_ZIP, ROOT, UPDATES_DIR } from "./paths";
import { Readable } from "node:stream";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import crypto from "node:crypto";
import fs from "node:fs";
import { getInstanceId, licenseServerUrl, resolveDomain } from "../client";
import { licenseKey } from "./info";
import path from "node:path";
import { SHA256_RE, updateZipPath } from "./manifest";

/* ───────── دانلود ───────── */

export async function download(version: string, expectedSha: string, expectedSize: number): Promise<string> {
  // C-01: نسخه/هش/اندازه ورودی بیرونی‌اند؛ پیش از هر کار روی دیسک سخت‌گیرانه سنجیده می‌شوند
  const file = updateZipPath(version);
  if (!SHA256_RE.test(expectedSha) || !Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_ZIP) throw new Error("مانیفست به‌روزرسانی ناقص یا نامعتبر است؛ نصب انجام نشد.");
  fs.mkdirSync(UPDATES_DIR, { recursive: true, mode: 0o700 });
  const key = await licenseKey();
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
  if (sha !== expectedSha || size !== expectedSize) {
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
export async function extract(file: string, dest: string): Promise<void> {
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
export function applyStaged(staged: string, rollbackTo: string): string[] {
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
