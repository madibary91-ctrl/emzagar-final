/**
 * پیکربندی لایه‌های QA (جدا از e2e/ که «داستان کامل کاربر» را می‌آزماید).
 * معمولاً از طریق `npm run qa` / `npm run qa:<لایه>` اجرا می‌شود؛ scripts/qa.ts دیتابیس، شبیه‌ساز و سرور را می‌سازد.
 *
 * لایه‌ها (پروژه‌ها): setup · smoke · contract · a11y · perf-seo · lighthouse · visual · security
 * (آزمون بار با autocannon در qa/load/run.ts اجرا می‌شود.)
 */
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { BASE } from "./lib/env";

const dir = (p: string) => path.join(__dirname, p);

export default defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.003, animations: "disabled", caret: "hide", scale: "css" },
  },
  outputDir: dir("report/artifacts"),
  snapshotPathTemplate: dir("visual/__baselines__/{arg}{ext}"),
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "setup", testMatch: /setup\/.*\.setup\.ts/ },
    { name: "smoke", testMatch: /specs\/(smoke|route-coverage)\.spec\.ts/ },
    { name: "contract", testMatch: /specs\/contract\.spec\.ts/ },
    { name: "a11y", testMatch: /specs\/a11y\.spec\.ts/, timeout: 180_000 },
    { name: "perf-seo", testMatch: /specs\/perf-seo\.spec\.ts/, timeout: 180_000 },
    { name: "lighthouse", testMatch: /specs\/lighthouse\.spec\.ts/, timeout: 300_000 },
    { name: "visual", testMatch: /specs\/visual\.spec\.ts/, timeout: 180_000 },
    { name: "security", testMatch: /specs\/security.*\.spec\.ts/, timeout: 180_000 },
  ],
});
