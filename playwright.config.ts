import { defineConfig } from "@playwright/test";

/**
 * پیکربندی آزمون‌های مرورگری (E2E). معمولاً از طریق `node scripts/e2e.mjs` اجرا می‌شود
 * که دیتابیس آزمایشی و سرور تولیدی را می‌سازد؛ برای اجرای دستی E2E_BASE_URL را بدهید.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  // آزمون‌ها یک «داستان» پیوسته‌اند (ثبت‌نام ← صدور ← امضا ← …)؛ پس ترتیبی و تک‌پردازه
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: "e2e/report/artifacts",
  reporter: [["list"], ["json", { outputFile: "e2e/report/results.json" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
  },
});
