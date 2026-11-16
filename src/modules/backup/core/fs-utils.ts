import { type BackupFileInfo } from "./types";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

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
export const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
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
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
/** قفل ساده‌ی فایلی: جلوگیری از اجرای هم‌زمان دو بک‌آپ (قفل مانده بیش از ۲ ساعت باطل است) */
export async function acquireLock(dir: string): Promise<() => Promise<void>> {
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
export async function copyDirFlat(src: string, dest: string, prefix: string, out: BackupFileInfo[]) {
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
export async function chmodTree(root: string): Promise<void> {
  await fsp.chmod(root, 0o700);
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) await chmodTree(p);
    else await fsp.chmod(p, 0o600);
  }
}
