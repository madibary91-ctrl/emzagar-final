#!/usr/bin/env node
/**
 * ساخت «بسته‌ی نصب آماده» برای فروش در مارکت‌پلیس:
 *
 *     node scripts/build-release.mjs
 *
 * خروجی: release/emzagar-<نسخه>.zip
 * خریدار فقط zip را روی هاست (cPanel → Setup Node.js App) آپلود می‌کند، Start می‌زند و /install را باز می‌کند.
 * هیچ npm install / build / ترمینالی لازم نیست؛ همه‌چیز (node_modules ردیابی‌شده) داخل بسته است.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.RELEASE_VERSION || "1.0.0";
const out = join(root, "release");
const stage = join(out, "emzagar");

// CR-05: بسته‌ی فروش فقط با افزونه‌ی «امضاشده‌ی معتبر» ساخته می‌شود (انحراف امضا = توقف)
console.log("⓪ بررسی امضای دیجیتال افزونه‌ی وردپرس…");
const sigCheck = spawnSync("npx", ["tsx", "scripts/plugin-release.ts", "verify"], { cwd: root, stdio: "inherit" });
if (sigCheck.status !== 0) {
  console.error("✗ افزونه‌ی وردپرس امضای معتبر ندارد؛ ابتدا «npm run plugin:sign» را روی دستگاه ناشر اجرا کنید.");
  process.exit(sigCheck.status ?? 1);
}

console.log("① ساخت پروژه (حالت standalone، بدون نیاز به دیتابیس)…");
const build = spawnSync("npm", ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, EMZ_STANDALONE: "1", DATABASE_URL: "", SESSION_SECRET: "" },
});
if (build.status !== 0) process.exit(build.status ?? 1);

const standalone = join(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("✗ خروجی standalone پیدا نشد.");
  process.exit(1);
}

console.log("② چیدن فایل‌ها…");
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(standalone, stage, {
  recursive: true,
  // هرگز فایل‌های محیط توسعه یا داده‌های محلی وارد بسته نشوند
  filter: (src) => {
    const rel = relative(standalone, src).split(sep)[0];
    return ![".env", ".env.local", "storage", "release", ".git"].includes(rel);
  },
});
mkdirSync(join(stage, ".next", "static"), { recursive: true });
cpSync(join(root, ".next", "static"), join(stage, ".next", "static"), { recursive: true });
if (existsSync(join(root, "public"))) cpSync(join(root, "public"), join(stage, "public"), { recursive: true });
if (existsSync(join(root, "assets"))) cpSync(join(root, "assets"), join(stage, "assets"), { recursive: true }); // قلم‌های PDF سمت سرور
if (existsSync(join(root, "wordpress-plugin"))) cpSync(join(root, "wordpress-plugin"), join(stage, "wordpress-plugin"), { recursive: true });
mkdirSync(join(stage, "storage"), { recursive: true });
writeFileSync(join(stage, "storage", ".gitkeep"), "");

// نقطه‌ی ورود برای هاست‌های cPanel / Passenger (فیلد Application startup file = app.js)
writeFileSync(
  join(stage, "app.js"),
  `// نقطه‌ی ورود هاست (cPanel → Setup Node.js App → Application startup file)
process.env.NODE_ENV = "production";
process.env.HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
process.chdir(__dirname);
require("./server.js");
`,
);
writeFileSync(
  join(stage, "README-FA.txt"),
  `نصب امضاگیر (نسخه ${version})
================================
۱) این پوشه را (یا محتوای zip را) روی هاست آپلود کنید.
۲) در cPanel بخش «Setup Node.js App» → Create Application:
   - Node.js version: 20 یا بالاتر
   - Application root: پوشه‌ای که آپلود کردید
   - Application startup file: app.js
۳) دکمه‌ی Run / Restart را بزنید.
۴) آدرس سایت را در مرورگر باز کنید؛ صفحه‌ی نصب خودکار نمایش داده می‌شود و بقیه‌ی کار با چند کلیک تمام می‌شود.

راهنمای تصویری و روش Docker: docs/INSTALL-FA.md
`,
);
if (existsSync(join(root, "docs"))) cpSync(join(root, "docs"), join(stage, "docs"), { recursive: true });

console.log("③ ساخت فایل zip…");
const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else files[`emzagar/${relative(stage, p).split(sep).join("/")}`] = [readFileSync(p), { level: 6, mtime: new Date() }];
  }
})(stage);
const zipPath = join(out, `emzagar-${version}.zip`);
writeFileSync(zipPath, zipSync(files));
console.log(`✓ آماده شد: ${relative(root, zipPath)}  (${(statSync(zipPath).size / 1048576).toFixed(1)} مگابایت) — ${pkg.name}`);
