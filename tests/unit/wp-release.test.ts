import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { buildPluginZip } from "@/lib/wp-plugin-zip";
import {
  buildManifest,
  generateSigningKey,
  PLUGIN_CONFIG,
  PLUGIN_ROOT,
  PLUGIN_SLUG,
  RELEASE_MANIFEST,
  RELEASE_SIG,
  renderPluginConfig,
  signManifestBytes,
  trustedKeysFromPhp,
  verifyBundledRelease,
  verifyRelease,
  type TrustedKeys,
} from "@/lib/wp-release";

/**
 * CR-05 — «بسته‌ی افزونه فقط با بررسی ساده نصب می‌شد»؛ اکنون امضای Ed25519 + SHA-256 + پین کلید.
 * هر سناریوی حمله هم با پیاده‌سازی مرجع Node و هم با «کد واقعی PHP افزونه» (در صورت وجود PHP) آزموده می‌شود.
 */
const PHP = process.env.PHP_BIN || "php";
const phpOut = spawnSync(PHP, ["-r", 'echo function_exists("sodium_crypto_sign_verify_detached") ? "1" : "0";'], { encoding: "utf8", env: process.env });
const phpHasSodium = phpOut.status === 0 && phpOut.stdout === "1";
const phpHasCompat = !!process.env.SODIUM_COMPAT_DIR && fs.existsSync(path.join(process.env.SODIUM_COMPAT_DIR, "autoload.php"));
const phpReady = phpOut.status === 0 && (phpHasSodium || phpHasCompat);

const ORIGIN = "https://cloud.example.com";
const files = (): Record<string, Uint8Array> => ({
  "emzagar-contracts.php": strToU8("<?php // plugin v9.1.0\n"),
  "includes/class-a.php": strToU8("<?php class A {}\n"),
  "assets/app.js": strToU8("console.log(1)\n"),
});

const good = generateSigningKey();
const attacker = generateSigningKey();
const KEYS: TrustedKeys = { "emz-rel-test-a": good.publicRaw };

function signed(version: string, f = files(), opts: { key?: typeof good; keyId?: string; manifestFrom?: Record<string, Uint8Array> } = {}): Record<string, Uint8Array> {
  const manifest = Buffer.from(JSON.stringify(buildManifest(opts.manifestFrom ?? f, version), null, 2) + "\n");
  const sig = signManifestBytes(manifest, (opts.key ?? good).privatePem, opts.keyId ?? "emz-rel-test-a");
  return { ...f, [RELEASE_MANIFEST]: new Uint8Array(manifest), [RELEASE_SIG]: strToU8(sig) };
}

interface Case {
  name: string;
  entries: Record<string, Uint8Array>;
  expect: string; // ok | کد خطا
  expectVersion?: string;
  current?: string;
  origins?: string[];
  rawZip?: Zippable; // برای حمله‌هایی که نام‌های غیرمعمول دارند (Node آن‌ها را نمی‌سازد)
  symlink?: boolean;
  nodeToo?: boolean;
}

const cases: Case[] = [
  { name: "valid", entries: signed("9.1.0"), expect: "ok", current: "9.0.0", expectVersion: "9.1.0", nodeToo: true },
  { name: "valid-with-exact-config", entries: { ...signed("9.1.0"), [PLUGIN_CONFIG]: strToU8(renderPluginConfig(ORIGIN)) }, expect: "ok", current: "9.0.0", nodeToo: true },
  {
    name: "tampered-file",
    entries: { ...signed("9.1.0"), "includes/class-a.php": strToU8("<?php system($_GET['c']); ") },
    expect: "hash_mismatch",
    current: "9.0.0",
    nodeToo: true,
  },
  { name: "extra-backdoor-file", entries: { ...signed("9.1.0"), "includes/backdoor.php": strToU8("<?php evil();") }, expect: "unexpected_file", current: "9.0.0", nodeToo: true },
  {
    name: "missing-file",
    entries: (() => {
      const e = signed("9.1.0");
      delete e["assets/app.js"];
      return e;
    })(),
    expect: "missing_file",
    current: "9.0.0",
    nodeToo: true,
  },
  { name: "unsigned", entries: files(), expect: "unsigned", current: "9.0.0", nodeToo: true },
  { name: "signed-by-attacker-with-trusted-key-id", entries: signed("9.1.0", files(), { key: attacker }), expect: "bad_signature", current: "9.0.0", nodeToo: true },
  { name: "signed-by-unpinned-key-id", entries: signed("9.1.0", files(), { key: attacker, keyId: "evil-key-1" }), expect: "unknown_key", current: "9.0.0", nodeToo: true },
  {
    name: "swapped-manifest-original-signature",
    entries: (() => {
      const legit = signed("9.1.0");
      const evil = { ...files(), "includes/class-a.php": strToU8("<?php evil();") };
      const m = Buffer.from(JSON.stringify(buildManifest(evil, "9.1.0"), null, 2) + "\n");
      return { ...evil, [RELEASE_MANIFEST]: new Uint8Array(m), [RELEASE_SIG]: legit[RELEASE_SIG] };
    })(),
    expect: "bad_signature",
    current: "9.0.0",
    nodeToo: true,
  },
  { name: "rollback-same-version", entries: signed("9.0.0"), expect: "rollback", current: "9.0.0", nodeToo: true },
  { name: "rollback-older-signed-release", entries: signed("8.5.0"), expect: "rollback", current: "9.0.0", nodeToo: true },
  { name: "advertised-version-mismatch", entries: signed("9.1.0"), expect: "version_mismatch", current: "9.0.0", expectVersion: "9.2.0", nodeToo: true },
  { name: "config-with-malicious-php", entries: { ...signed("9.1.0"), [PLUGIN_CONFIG]: strToU8("<?php system($_GET['c']);") }, expect: "config_mismatch", current: "9.0.0", nodeToo: true },
  {
    name: "config-pointing-to-another-cloud",
    entries: { ...signed("9.1.0"), [PLUGIN_CONFIG]: strToU8(renderPluginConfig("https://evil.example.net")) },
    expect: "config_mismatch",
    current: "9.0.0",
    nodeToo: true,
  },
  {
    name: "config-with-injected-pairing",
    entries: { ...signed("9.1.0"), [PLUGIN_CONFIG]: strToU8(renderPluginConfig(ORIGIN, "emzp_deadbeef")) },
    expect: "config_mismatch",
    current: "9.0.0",
    nodeToo: true,
  },
  {
    name: "path-traversal-entry",
    entries: signed("9.1.0"),
    rawZip: Object.fromEntries(Object.entries({ ...signed("9.1.0"), "../evil.php": strToU8("<?php evil();") }).map(([k, v]) => [`${PLUGIN_SLUG}/${k}`, v])),
    expect: "bad_path",
    current: "9.0.0",
  },
  {
    name: "entry-outside-plugin-folder",
    entries: signed("9.1.0"),
    rawZip: { ...Object.fromEntries(Object.entries(signed("9.1.0")).map(([k, v]) => [`${PLUGIN_SLUG}/${k}`, v])), "evil/x.php": strToU8("<?php evil();") },
    expect: "bad_path",
    current: "9.0.0",
  },
  { name: "symlink-entry", entries: signed("9.1.0"), symlink: true, expect: "symlink", current: "9.0.0" },
];

function materialize(root: string, c: Case): { zip: string; dir: string } {
  const zipPath = path.join(root, `${c.name}.zip`);
  const dir = path.join(root, `dir-${c.name}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, data] of Object.entries(c.entries)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  let z: Zippable = c.rawZip ?? Object.fromEntries(Object.entries(c.entries).map(([k, v]) => [`${PLUGIN_SLUG}/${k}`, v]));
  if (c.symlink) {
    z = { ...z, [`${PLUGIN_SLUG}/includes/link.php`]: [strToU8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }] };
    fs.symlinkSync("/etc/passwd", path.join(dir, "includes", "link.php"));
  }
  fs.writeFileSync(zipPath, zipSync(z, { level: 6 }));
  return { zip: zipPath, dir };
}

const nodeCode = (r: ReturnType<typeof verifyRelease>) => (r.ok ? "ok" : r.error.split(":")[0]);

describe("امضای انتشار افزونه — پیاده‌سازی مرجع Node", () => {
  for (const c of cases.filter((x) => x.nodeToo)) {
    it(`${c.name} ← ${c.expect}`, () => {
      const r = verifyRelease(c.entries, { keys: KEYS, expectVersion: c.expectVersion, currentVersion: c.current, cloudOrigin: ORIGIN });
      expect(nodeCode(r)).toBe(c.expect);
    });
  }

  it("امضای ساخته‌شده روی بایت‌های دیگر هرگز پذیرفته نمی‌شود (یک بایت تغییر ← رد)", () => {
    const e = signed("9.1.0");
    e[RELEASE_MANIFEST] = new Uint8Array(Buffer.concat([Buffer.from(e[RELEASE_MANIFEST]), Buffer.from(" ")]));
    expect(nodeCode(verifyRelease(e, { keys: KEYS }))).toBe("bad_signature");
  });
});

describe("افزونه‌ی همراه پروژه (انتشار واقعی)", () => {
  const keys = trustedKeysFromPhp();

  it("کلیدهای پین‌شده در PHP خوانده می‌شود و دست‌کم دو کلید (اصلی + جایگزین اضطراری) دارد", () => {
    expect(Object.keys(keys).length).toBeGreaterThanOrEqual(2);
    for (const v of Object.values(keys)) expect(Buffer.from(v, "base64")).toHaveLength(32);
  });

  it("امضای ثبت‌شده با فایل‌های فعلی می‌خواند (انحراف = باید دوباره `npm run plugin:sign` زد)", () => {
    const r = verifyBundledRelease(PLUGIN_ROOT, keys);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  });

  it("بسته‌ی zip که ابر می‌سازد (با config تولیدشده) کاملاً قابل راستی‌آزمایی است و قابل بازتولید (بایت‌به‌بایت) است", () => {
    const a = buildPluginZip(ORIGIN);
    const b = buildPluginZip(ORIGIN);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const entries = Object.fromEntries(Object.entries(unzipSync(a)).map(([k, v]) => [k.slice(PLUGIN_SLUG.length + 1), v]));
    const r = verifyRelease(entries, { keys, currentVersion: "0.0.1", cloudOrigin: ORIGIN });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    // با آدرس ابر دیگری همان بسته پذیرفته نمی‌شود
    expect(nodeCode(verifyRelease(entries, { keys, cloudOrigin: "https://other.example.org" }))).toBe("config_mismatch");
  });

  it("پس از دستکاری یک فایل افزونه، بسته‌ی ابر رد می‌شود", () => {
    const entries = Object.fromEntries(Object.entries(unzipSync(buildPluginZip(ORIGIN))).map(([k, v]) => [k.slice(PLUGIN_SLUG.length + 1), v]));
    entries["includes/class-emzagar-updater.php"] = strToU8("<?php evil();");
    expect(nodeCode(verifyRelease(entries, { keys }))).toBe("hash_mismatch");
  });

  it("به‌روزرسانی افزونه (PHP) مسیر دانلود و «استخراج‌شده» را هر دو با Emzagar_Release می‌سنجد", () => {
    const up = fs.readFileSync(path.join(PLUGIN_ROOT, "includes/class-emzagar-updater.php"), "utf8");
    expect(up).toContain("Emzagar_Release::verify_zip(");
    expect(up).toContain("Emzagar_Release::verify_dir(");
    expect(up).toContain("'upgrader_source_selection'");
    const main = fs.readFileSync(path.join(PLUGIN_ROOT, "emzagar-contracts.php"), "utf8");
    expect(main.indexOf("class-emzagar-release.php")).toBeGreaterThan(-1);
    expect(main.indexOf("class-emzagar-release.php")).toBeLessThan(main.indexOf("class-emzagar-updater.php"));
  });
});

describe.skipIf(!phpReady)("امضای انتشار افزونه — کد واقعی PHP افزونه (Emzagar_Release)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "emz-rel-"));
  const results: Record<string, string> = {};
  const realKeys = trustedKeysFromPhp();

  it("PHP همه‌ی سناریوها را اجرا می‌کند", () => {
    const list: object[] = [];
    for (const c of cases) {
      const m = materialize(root, c);
      const base = { keys: KEYS, expect: c.expectVersion ?? "", current: c.current ?? "", origins: c.origins ?? [ORIGIN] };
      list.push({ ...base, name: `zip:${c.name}`, kind: "zip", path: m.zip });
      if (!c.rawZip) list.push({ ...base, name: `dir:${c.name}`, kind: "dir", path: m.dir });
    }
    // انتشار واقعی با کلیدهای پین‌شده‌ی خود افزونه
    const bundled = path.join(root, "bundled.zip");
    fs.writeFileSync(bundled, buildPluginZip(ORIGIN));
    list.push({ name: "zip:bundled-real", kind: "zip", path: bundled, keys: null, expect: "", current: "0.0.1", origins: [ORIGIN] });
    list.push({ name: "zip:bundled-real-wrong-cloud", kind: "zip", path: bundled, keys: null, expect: "", current: "0.0.1", origins: ["https://other.example.org"] });
    list.push({ name: "dir:bundled-plugin-folder", kind: "dir", path: PLUGIN_ROOT, keys: null, expect: "", current: "0.0.1", origins: [ORIGIN] });
    // کلید خصوصی ناشر به‌جز کلیدهای پین‌شده، هیچ‌چیز را نمی‌پذیرد
    list.push({ name: "zip:valid-test-key-vs-real-pins", kind: "zip", path: path.join(root, "valid.zip"), keys: realKeys, expect: "", current: "9.0.0", origins: [ORIGIN] });

    const casesFile = path.join(root, "cases.json");
    fs.writeFileSync(casesFile, JSON.stringify(list));
    const r = spawnSync(PHP, [path.join(process.cwd(), "tests/php/release.php"), casesFile], { encoding: "utf8", env: process.env });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    Object.assign(results, JSON.parse(r.stdout) as Record<string, string>);
  }, 120_000);

  for (const c of cases) {
    it(`PHP zip: ${c.name} ← ${c.expect}`, () => {
      expect(results[`zip:${c.name}`]?.replace(/^emzagar_release_/, "")).toBe(c.expect);
    });
    if (!c.rawZip) {
      it(`PHP dir: ${c.name} ← ${c.expect}`, () => {
        expect(results[`dir:${c.name}`]?.replace(/^emzagar_release_/, "")).toBe(c.expect);
      });
    }
  }

  it("PHP: انتشار واقعی ناشر با کلیدهای پین‌شده پذیرفته می‌شود، با آدرس ابر دیگر یا کلید آزمون رد", () => {
    expect(results["zip:bundled-real"]).toBe("ok");
    expect(results["dir:bundled-plugin-folder"]).toBe("ok");
    expect(results["zip:bundled-real-wrong-cloud"]).toBe("emzagar_release_config_mismatch");
    expect(results["zip:valid-test-key-vs-real-pins"]).toBe("emzagar_release_unknown_key");
  });
});
