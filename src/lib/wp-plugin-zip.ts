import { strToU8, zipSync } from "fflate";
import { collectPluginFiles, PLUGIN_CONFIG, PLUGIN_ROOT, PLUGIN_SLUG, RELEASE_MANIFEST, RELEASE_SIG, renderPluginConfig } from "@/lib/wp-release";
import fs from "node:fs";
import path from "node:path";

/** زمان ثابت فایل‌های zip: بسته‌ی یکسان ← بایت‌های یکسان (قابل بازتولید و قابل مقایسه) */
const FIXED_MTIME = Date.UTC(2020, 0, 1);

/**
 * بسته‌ی افزونه‌ی «از پیش پیکربندی‌شده»: همه‌ی فایل‌های امضاشده‌ی ناشر + RELEASE.json/RELEASE.sig + emzagar-config.php.
 * emzagar-config.php تنها فایلی است که ابر می‌سازد و فقط از قالب ثابت `renderPluginConfig` ساخته می‌شود.
 */
export function buildPluginZip(origin: string, pairing = "", dir = PLUGIN_ROOT): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const add = (rel: string, data: Uint8Array) => {
    files[`${PLUGIN_SLUG}/${rel}`] = data;
  };
  for (const [rel, data] of Object.entries(collectPluginFiles(dir))) add(rel, data);
  for (const f of [RELEASE_MANIFEST, RELEASE_SIG]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) add(f, new Uint8Array(fs.readFileSync(p)));
  }
  add(PLUGIN_CONFIG, strToU8(renderPluginConfig(origin, pairing)));
  return zipSync(files, { level: 6, mtime: FIXED_MTIME });
}
