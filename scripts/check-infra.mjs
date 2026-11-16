#!/usr/bin/env node
/**
 * نگهبان زیرساخت (Infra Guard) — بدون وابستگی؛ در CI و پیش از انتشار اجرا می‌شود:
 *
 *     npm run infra:check
 *
 * هر ردیف، «بازگشت» (regression) یکی از یافته‌های ممیزی زیرساخت (INF-xx) را می‌گیرد تا دوباره بی‌صدا اتفاق نیفتد:
 *   INF-01  همه‌ی «npm run X» های مستندات/CI/اسکریپت‌ها در package.json تعریف شده‌اند
 *   INF-02  package-lock.json هست و با package.json هم‌خوان است
 *   INF-03  vps-backup.sh رمز را export می‌کند و همه‌ی اسکریپت‌های bash از نظر نحو سالم‌اند
 *   INF-04  ACME_EMAIL در compose اجباری است و install-vps.sh آن را اعتبارسنجی می‌کند
 *   INF-06  هر پوشه‌ای که برنامه در storage می‌سازد در FILE_DIRS بک‌آپ هست
 *   INF-07/13  .dockerignore/.gitignore پوشه‌های تست، رازها و backups را بیرون نگه می‌دارند
 *   INF-08  همه‌ی سرویس‌های compose لاگ چرخشی دارند و app سقف حافظه دارد
 *   INF-10  بک‌آپ دیتابیس با -Fc گرفته می‌شود
 *   INF-11  همه‌ی ARGهای Dockerfile در compose پاس داده می‌شوند
 *
 * خروجی: کد ۰ اگر همه‌چیز سالم باشد، وگرنه ۱ همراه با فهرست خطاها.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(join(root, p), "utf8");
const problems = [];
const fail = (id, msg) => problems.push(`${id}: ${msg}`);
const walk = (dir, accept, out = []) => {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) walk(rel, accept, out);
    else if (accept(rel)) out.push(rel);
  }
  return out;
};

/* ── INF-01: اسکریپت‌های npm ── */
const pkg = JSON.parse(read("package.json"));
const scripts = pkg.scripts ?? {};
for (const must of ["dev", "build", "start", "test", "backup", "restore", "plugin:keygen", "plugin:sign", "plugin:verify", "test:e2e", "test:qa", "infra:check"]) {
  if (!scripts[must]) fail("INF-01", `اسکریپت «${must}» در package.json نیست`);
}
const builtin = new Set(["test", "start", "stop", "restart", "install", "ci", "exec", "pkg", "run", "ls"]);
const refFiles = [
  "README.md",
  ...walk("docs", (f) => f.endsWith(".md")),
  ...walk(".github", (f) => /\.ya?ml$/.test(f)),
  ...walk("scripts", (f) => /\.(sh|ts|mjs)$/.test(f)),
  ...walk("qa", (f) => /\.ts$/.test(f)),
  ...walk("tests", (f) => /\.ts$/.test(f)),
  ...walk("src", (f) => /\.(ts|tsx)$/.test(f)),
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.prod.yml",
].filter((f) => existsSync(join(root, f)));
for (const f of refFiles) {
  if (f === "scripts/check-infra.mjs") continue;
  const txt = read(f);
  for (const m of txt.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
    const name = m[1].replace(/:+$/, ""); // «npm run qa:<لایه>» ← qa
    if (!scripts[name] && !builtin.has(name)) fail("INF-01", `${f}: «npm run ${name}» تعریف نشده است`);
  }
}

/* ── INF-02: lockfile ── */
if (!existsSync(join(root, "package-lock.json"))) {
  fail("INF-02", "package-lock.json وجود ندارد (npm install --package-lock-only)");
} else {
  const lock = JSON.parse(read("package-lock.json"));
  const rootPkg = lock.packages?.[""] ?? {};
  for (const key of ["dependencies", "devDependencies"]) {
    const a = pkg[key] ?? {};
    const b = rootPkg[key] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (a[name] !== b[name]) fail("INF-02", `package-lock.json با package.json هم‌خوان نیست: ${key}.${name} (${a[name] ?? "—"} ≠ ${b[name] ?? "—"})؛ دوباره «npm install» بزنید`);
    }
  }
  const bad = Object.entries(lock.packages ?? {}).filter(([k, v]) => k && !v.link && !v.resolved && !v.inBundle).length;
  if (bad > 0) fail("INF-02", `${bad} بسته در lock آدرس resolved ندارد`);
}
if (/package-lock\.json/.test(read(".gitignore"))) fail("INF-02", "package-lock.json در .gitignore است");

/* ── INF-03: اسکریپت‌های bash ── */
const sh = walk("scripts", (f) => f.endsWith(".sh"));
for (const f of sh) {
  const r = spawnSync("bash", ["-n", join(root, f)], { encoding: "utf8" });
  if (r.status !== 0) fail("INF-03", `${f}: خطای نحو bash — ${(r.stderr || "").trim()}`);
  // بیت اجرایی هنگام zip/آپلود از دست می‌رود؛ پس هیچ فراخوانیِ واقعی نباید به آن تکیه کند (همه‌جا «bash scripts/x.sh»)
  const code = read(f).split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  if (/(^|&&|;|\|\|)\s*\.\/scripts\/[\w-]+\.sh/m.test(code)) fail("INF-03", `${f}: اسکریپت مستقیم با ./scripts/… اجرا شده؛ به‌جایش «bash scripts/…» (بیت اجرایی تضمین‌شده نیست)`);
}
const backupSh = read("scripts/vps-backup.sh");
if (!/^export BACKUP_PASSPHRASE\b/m.test(backupSh)) fail("INF-03", "vps-backup.sh باید BACKUP_PASSPHRASE را export کند (openssl -pass env: در غیر این‌صورت آن را نمی‌بیند)");
if (!/pg_dump[^\n]*-Fc/.test(backupSh)) fail("INF-10", "vps-backup.sh باید pg_dump را با -Fc اجرا کند");
if (!/need_cmd openssl/.test(backupSh) || !/rsync/.test(backupSh)) fail("INF-12", "vps-backup.sh باید وجود ابزارها (openssl/rsync) را پیش از اجرا بررسی کند");
const lock0 = /flock/.test(backupSh);
if (!lock0) fail("INF-03", "vps-backup.sh باید از اجرای هم‌زمان جلوگیری کند (flock)");

/* ── INF-04: ایمیل ACME ── */
const prod = read("docker-compose.prod.yml");
if (!/ACME_EMAIL:\s*"?\$\{ACME_EMAIL:\?/.test(prod)) fail("INF-04", "docker-compose.prod.yml: ACME_EMAIL باید با ${ACME_EMAIL:?…} اجباری باشد");
const inst = read("scripts/install-vps.sh");
if (!/is_email/.test(inst) || !/ایمیل لازم است/.test(inst)) fail("INF-04", "install-vps.sh باید ایمیل را اجباری و اعتبارسنجی کند");

/* ── INF-06: پوشه‌های storage در بک‌آپ ── */
const types = read("src/modules/backup/core/types.ts");
const fileDirs = new Set([...(/FILE_DIRS\s*=\s*\[([^\]]*)\]/.exec(types)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
const NOT_BACKED_UP = new Set(["backups", "releases", "updates"]); // عمداً (docs/GLM-INFRA-AUDIT-FA.md)
const seen = new Set();
for (const f of walk("src", (p) => /\.(ts|tsx)$/.test(p))) {
  const txt = read(f);
  for (const m of txt.matchAll(/(?:STORAGE_DIR|storageDir|"storage")\s*,\s*"([a-z][a-z0-9_-]*)"/g)) seen.add(m[1]);
}
for (const d of seen) {
  if (!fileDirs.has(d) && !NOT_BACKED_UP.has(d) && !/\.(txt|json|lock|pub)$/.test(d)) fail("INF-06", `storage/${d} در FILE_DIRS بک‌آپ نیست (src/modules/backup/core/types.ts)`);
}
for (const d of ["sources", "landing", "branding"]) if (!fileDirs.has(d)) fail("INF-06", `FILE_DIRS باید «${d}» را شامل شود`);

/* ── INF-07 / INF-13: ignore ها ── */
const lines = (f) => new Set(read(f).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
const di = lines(".dockerignore");
const gi = lines(".gitignore");
for (const must of ["e2e", "qa", "tests", "docs", "simulator", "backups", ".env", "release-keys", "storage", ".git", "node_modules"]) {
  if (!di.has(must)) fail("INF-07/13", `.dockerignore باید «${must}» را داشته باشد`);
}
for (const must of ["backups/", ".env", "release-keys/", "storage", "node_modules"]) {
  if (!gi.has(must)) fail("INF-13", `.gitignore باید «${must}» را داشته باشد`);
}

/* ── INF-08 / INF-11: compose ── */
const dockerfile = read("Dockerfile");
const args = [...dockerfile.matchAll(/^ARG\s+([A-Z_]+)/gm)].map((m) => m[1]);
for (const f of ["docker-compose.yml", "docker-compose.prod.yml"]) {
  const txt = read(f);
  for (const a of args) {
    if (["ALLOW_UNLOCKED_INSTALL"].includes(a)) continue; // عمداً فقط دستی (--build-arg)
    if (!new RegExp(`^\\s+${a}:`, "m").test(txt)) fail("INF-11", `${f}: build-arg «${a}» (تعریف‌شده در Dockerfile) به build پاس داده نمی‌شود`);
  }
  try {
    const yaml = createRequire(import.meta.url)("js-yaml");
    const doc = yaml.load(txt);
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      if (!svc.logging?.options?.["max-size"]) fail("INF-08", `${f}: سرویس ${name} لاگ چرخشی (max-size) ندارد`);
    }
    if (!doc.services?.app?.mem_limit) fail("INF-08", `${f}: سرویس app سقف حافظه (mem_limit) ندارد`);
  } catch (e) {
    if (e?.code !== "MODULE_NOT_FOUND") fail("INF-08", `${f}: YAML نامعتبر — ${e.message}`);
    else if (!/max-size/.test(txt) || !/mem_limit/.test(txt)) fail("INF-08", `${f}: logging/mem_limit پیدا نشد`);
  }
}
if (!/npm ci/.test(dockerfile)) fail("INF-02", "Dockerfile باید با npm ci نصب کند");

/* ── گزارش ── */
if (problems.length) {
  console.error(`\n✗ ${problems.length} مشکل زیرساختی:\n`);
  for (const p of problems) console.error("  • " + p);
  console.error("");
  process.exit(1);
}
console.log(`✓ infra check: ${Object.keys(scripts).length} اسکریپت npm، ${sh.length} اسکریپت bash، ${fileDirs.size} پوشه‌ی بک‌آپ، ${refFiles.length} فایل مرجع — همه سالم`);

