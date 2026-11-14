import { type BackupManifest } from "./types";
import fsp from "node:fs/promises";
import { hashFile } from "./fs-utils";
import path from "node:path";

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
