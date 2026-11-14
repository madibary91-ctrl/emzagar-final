import fs from "node:fs";
import path from "node:path";

/**
 * اطلاعات افزونه‌ی وردپرس همراه ابر (نسخه، سازگاری، تغییرات) — برای «به‌روزرسانی خودکار افزونه».
 * ابر همان افزونه‌ای را که همراه خودش دارد به سایت‌های وردپرسی متصل عرضه می‌کند؛
 * پس خریدار فقط ابر (VPS) را به‌روز می‌کند و همه‌ی سایت‌هایش خودکار به‌روز می‌شوند.
 */
export const WP_PLUGIN_SLUG = "emzagar-contracts";
export const WP_PLUGIN_DIR = path.join(process.cwd(), "wordpress-plugin", WP_PLUGIN_SLUG);

export interface WpPluginMeta {
  version: string;
  requires: string;
  requiresPhp: string;
  tested: string;
  changelog: string;
}

/** مقدار یک فیلد از هدر کامنت PHP (مثل «Version:  2.3.0») */
export function headerField(php: string, name: string): string {
  const m = php.match(new RegExp(`^[ \\t/*#@]*${name}:[ \\t]*(.+)$`, "mi"));
  return m ? m[1].trim() : "";
}

/** بخش «تغییرات» readme.txt: فقط n نسخه‌ی آخر، متن ساده */
export function parseChangelog(readme: string, versions = 3): string {
  const sec = readme.split(/^==\s*Changelog\s*==\s*$/im)[1];
  if (!sec) return "";
  const body = sec.split(/^==\s*[^=]+==\s*$/m)[0];
  const blocks = body.split(/^=\s*([0-9][0-9A-Za-z.\-]*)\s*=\s*$/m);
  // blocks: ["", "2.3.0", "...", "2.2.0", "..."]
  const out: string[] = [];
  for (let i = 1; i < blocks.length && out.length < versions; i += 2) {
    out.push(`${blocks[i]}\n${blocks[i + 1].trim()}`);
  }
  return out.join("\n\n").slice(0, 6000);
}

export const isSemver = (v: string) => /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$/.test(v);

let cache: { at: number; meta: WpPluginMeta | null } | null = null;

/** نسخه و تغییرات افزونه‌ی همراه (۶۰ ثانیه کش)؛ اگر فایل‌ها نباشند null */
export function readPluginMeta(dir = WP_PLUGIN_DIR): WpPluginMeta | null {
  if (cache && Date.now() - cache.at < 60_000 && dir === WP_PLUGIN_DIR) return cache.meta;
  let meta: WpPluginMeta | null = null;
  try {
    const php = fs.readFileSync(path.join(dir, `${WP_PLUGIN_SLUG}.php`), "utf8").slice(0, 4000);
    const version = headerField(php, "Version");
    if (isSemver(version)) {
      let readme = "";
      try {
        readme = fs.readFileSync(path.join(dir, "readme.txt"), "utf8");
      } catch {
        /* readme اختیاری است */
      }
      meta = {
        version,
        requires: headerField(php, "Requires at least") || "5.8",
        requiresPhp: headerField(php, "Requires PHP") || "7.4",
        tested: headerField(readme, "Tested up to"),
        changelog: parseChangelog(readme),
      };
    }
  } catch {
    meta = null;
  }
  if (dir === WP_PLUGIN_DIR) cache = { at: Date.now(), meta };
  return meta;
}
