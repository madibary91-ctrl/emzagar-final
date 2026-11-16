#!/usr/bin/env node
/**
 * DB-05 — این اسکریپت دیگر فایلی «تولید» نمی‌کند.
 *
 * `src/modules/install/schema-sql.ts` اکنون در لحظه از `src/db/schema.ts` محاسبه می‌شود (src/db/ddl.ts)؛
 * پس هیچ مرحله‌ی دستیِ قابل‌فراموشی وجود ندارد. این اسکریپت فقط «راستی‌آزمایی» می‌کند (برای CI):
 * هر جدول/ستون که `drizzle-kit export` از schema.ts می‌بیند باید در DDL نصب‌کننده هم باشد.
 *
 *   node scripts/gen-schema-sql.mjs        (یا: npm run db:check)
 */
import { execSync } from "node:child_process";

const raw = execSync("npx drizzle-kit export --sql", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const { SCHEMA_PLAN } = await import("tsx/esm/api").then(async (t) => t.tsImport("../src/modules/install/schema-sql.ts", import.meta.url));

const ours = new Set(SCHEMA_PLAN.tables.map((s) => /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(s)?.[1]));
const alters = new Set(SCHEMA_PLAN.columns.map((s) => /ALTER TABLE "([^"]+)" ADD COLUMN IF NOT EXISTS "([^"]+)"/.exec(s)?.slice(1, 3).join(".")));
const problems = [];
for (const st of raw.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
  const m = /^CREATE TABLE "([^"]+)"/i.exec(st);
  if (!m) continue;
  if (!ours.has(m[1])) problems.push(`جدول ${m[1]} در DDL نصب‌کننده نیست`);
  for (const line of st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")).split(/,\s*\n/)) {
    const col = /^\s*"([^"]+)"/.exec(line)?.[1];
    if (col && !/PRIMARY KEY/i.test(line) && !alters.has(`${m[1]}.${col}`)) problems.push(`ستون ${m[1]}.${col} در DDL نصب‌کننده نیست`);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`✓ DDL نصب‌کننده با schema.ts همگام است (${ours.size} جدول، ${SCHEMA_PLAN.foreignKeys.length} Foreign Key، ${SCHEMA_PLAN.indexes.length} ایندکس)`);
