#!/usr/bin/env -S npx tsx
/**
 * امضای انتشار افزونه‌ی وردپرس (CR-05) — فقط روی «دستگاه ناشر» اجرا می‌شود، نه روی سرور ابر.
 *
 *   npm run plugin:keygen -- <keyId> <فایل-خروجی-کلید-خصوصی>   ساخت جفت‌کلید Ed25519 (کلید خصوصی را آفلاین نگه دارید)
 *   npm run plugin:sign                                        امضای افزونه (کلید: EMZ_RELEASE_SIGNING_KEY_FILE و EMZ_RELEASE_KEY_ID)
 *   npm run plugin:verify                                      بررسی اینکه امضای ثبت‌شده با فایل‌های فعلی و کلید پین‌شده می‌خواند
 *
 * پس از هر تغییر در wordpress-plugin/ باید دوباره `plugin:sign` اجرا شود (آزمون tests/unit/wp-release.test.ts و
 * `plugin:verify` در ساخت بسته‌ی فروش، هر انحراف را رد می‌کنند).
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildManifest,
  collectPluginFiles,
  generateSigningKey,
  headerVersion,
  PLUGIN_ROOT,
  RELEASE_MANIFEST,
  RELEASE_SIG,
  signManifestBytes,
  trustedKeysFromPhp,
  verifyBundledRelease,
} from "../src/lib/wp-release";

function fail(msg: string): never {
  console.error("✗", msg);
  process.exit(1);
}

const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === "keygen") {
  if (!a1 || !a2) fail("استفاده:  npm run plugin:keygen -- <keyId> <فایل-کلید-خصوصی>   (مثلاً emz-rel-2027-a ~/keys/emz-a.pem)");
  const out = path.resolve(a2);
  if (fs.existsSync(out)) fail(`فایل ${out} از قبل وجود دارد؛ رونویسی نمی‌شود.`);
  if (out.startsWith(process.cwd() + path.sep)) fail("کلید خصوصی نباید داخل پوشه‌ی پروژه (و مخزن گیت) ذخیره شود.");
  const k = generateSigningKey();
  fs.writeFileSync(out, k.privatePem, { mode: 0o600 });
  console.log(`✓ کلید خصوصی ذخیره شد: ${out}  (آفلاین و پشتیبان‌گیری‌شده نگه دارید؛ هرگز روی سرور ابر نگذارید)`);
  console.log(`\nاین سطر را به KEYS در wordpress-plugin/emzagar-contracts/includes/class-emzagar-release.php اضافه کنید:\n\t\t'${a1}' => '${k.publicRaw}',`);
} else if (cmd === "sign") {
  const keyFile = process.env.EMZ_RELEASE_SIGNING_KEY_FILE;
  const keyId = process.env.EMZ_RELEASE_KEY_ID;
  if (!keyFile || !keyId) fail("EMZ_RELEASE_SIGNING_KEY_FILE و EMZ_RELEASE_KEY_ID را تنظیم کنید.");
  if (!trustedKeysFromPhp()[keyId]) fail(`کلید ${keyId} در فهرست KEYS افزونه پین نشده است؛ بسته‌ای که امضا شود هیچ افزونه‌ای نمی‌پذیرد.`);
  const files = collectPluginFiles();
  const version = headerVersion(fs.readFileSync(path.join(PLUGIN_ROOT, "emzagar-contracts.php"), "utf8"));
  if (!version) fail("نسخه‌ی افزونه در هدر پیدا نشد.");
  const manifest = Buffer.from(JSON.stringify(buildManifest(files, version), null, 2) + "\n");
  const sig = signManifestBytes(manifest, fs.readFileSync(keyFile, "utf8"), keyId);
  fs.writeFileSync(path.join(PLUGIN_ROOT, RELEASE_MANIFEST), manifest);
  fs.writeFileSync(path.join(PLUGIN_ROOT, RELEASE_SIG), sig);
  const v = verifyBundledRelease(PLUGIN_ROOT, trustedKeysFromPhp());
  if (!v.ok) fail(`امضا ساخته شد ولی با کلید پین‌شده نمی‌خواند: ${v.error}`);
  console.log(`✓ افزونه‌ی ${version} با کلید ${keyId} امضا شد (${Object.keys(v.manifest.files).length} فایل)`);
} else if (cmd === "verify") {
  const v = verifyBundledRelease(PLUGIN_ROOT, trustedKeysFromPhp());
  if (!v.ok) fail(`امضای افزونه معتبر نیست (${v.error}). پس از هر تغییر، «npm run plugin:sign» را اجرا کنید.`);
  console.log(`✓ افزونه‌ی ${v.manifest.version} امضای معتبر دارد (کلید ${v.keyId}، ${Object.keys(v.manifest.files).length} فایل)`);
} else {
  fail("دستور: keygen | sign | verify");
}
