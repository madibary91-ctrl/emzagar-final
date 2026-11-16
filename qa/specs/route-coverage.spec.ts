/**
 * نگهبان پوشش: هر page.tsx و هر route.ts جدید باید در فهرست QA باشد؛
 * بدین‌ترتیب یک صفحه یا API تازه هرگز بدون دسترس‌پذیری/امنیت/قرارداد منتشر نمی‌شود.
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { REGISTRY } from "../contracts/registry";
import { COVERAGE_EXCLUDES, PAGES } from "../routes";

const APP = path.resolve("src/app");

function walk(dir: string, name: "page.tsx" | "route.ts", out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, name, out);
    else if (e.name === name) {
      const rel = path.relative(APP, path.dirname(p)).split(path.sep).filter((s) => !/^\(.*\)$/.test(s)).join("/");
      out.push("/" + rel);
    }
  }
  return out;
}

test("[R1] همه‌ی صفحه‌ها (page.tsx) در qa/routes.ts پوشش دارند", () => {
  const known = new Set([...PAGES.map((p) => p.route), ...Object.keys(COVERAGE_EXCLUDES)]);
  const missing = walk(APP, "page.tsx").filter((r) => !known.has(r));
  expect(missing, "صفحه‌هایی که به qa/routes.ts اضافه نشده‌اند").toEqual([]);
});

test("[R2] همه‌ی APIها (route.ts) قرارداد دارند", () => {
  const known = new Set(REGISTRY.map((c) => c.route));
  const missing = walk(APP, "route.ts").filter((r) => r !== "/" && !known.has(r) && !["/robots.txt", "/sitemap.xml"].includes(r));
  expect(missing, "APIهایی که در qa/contracts/registry.ts نیستند").toEqual([]);
});

test("[R3] ورودی‌های PAGES یکتا هستند", () => {
  const names = PAGES.map((p) => p.name);
  expect(new Set(names).size).toBe(names.length);
});
