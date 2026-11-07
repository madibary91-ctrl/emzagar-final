import path from "node:path";
import { defineConfig } from "vitest/config";

// آزمون‌ها روی یک دیتابیس جداگانه‌ی PostgreSQL (emz_test) اجرا می‌شوند؛ هرگز روی دیتابیس واقعی نه.
const TEST_DB = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/emz_test";

// globalSetup در پردازه‌ی اصلی اجرا می‌شود و test.env را نمی‌بیند
process.env.TEST_DATABASE_URL ??= TEST_DB;

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DB,
      TEST_DATABASE_URL: TEST_DB,
      SESSION_SECRET: "vitest-secret-0123456789-abcdefghijklmnop",
      STORAGE_DIR: path.resolve(import.meta.dirname, ".test-storage"),
      ALLOW_DEV_OTP: "1",
      SKIP_EMAIL_DOMAIN_CHECK: "1",
      REQUIRE_EMAIL_VERIFICATION: "1",
      PDF_FONT_DIR: path.resolve(import.meta.dirname, "assets/fonts"),
      APP_URL: "http://localhost:3000",
    },
  },
});
