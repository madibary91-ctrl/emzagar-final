/**
 * تنظیمات مشترک همه‌ی لایه‌های «آزمون کیفیت» (QA).
 * همه‌چیز با متغیر محیطی قابل‌تغییر است تا همین آزمون‌ها روی هر سرور آماده (staging) هم اجرا شوند.
 */
import path from "node:path";

export const ROOT = process.cwd();
export const PORT = Number(process.env.QA_PORT) || 3200;
export const BASE = (process.env.QA_BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
export const SIM_PORT = Number(process.env.QA_SIM_PORT) || 4210;
export const ADMIN_DB = process.env.QA_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
export const DB_NAME = "emz_qa";
export const DB_URL = process.env.QA_DATABASE_URL ?? ADMIN_DB.replace(/\/[^/]*$/, `/${DB_NAME}`);
export const STORAGE_DIR = path.resolve(ROOT, ".qa-storage");
export const STATE_DIR = path.resolve(ROOT, "qa/.state");
export const REPORT_DIR = path.resolve(ROOT, "qa/report");
export const STATE_FILE = path.join(STATE_DIR, "state.json");
export const CRON_SECRET = "qa-cron-secret-0123456789";

export const AUTH = {
  admin: path.join(STATE_DIR, "admin-auth.json"),
  user: path.join(STATE_DIR, "user-auth.json"),
};

/** حساب‌هایی که مرحله‌ی آماده‌سازی می‌سازد */
export const ADMIN = {
  email: "qa-admin@example.com",
  password: "QaAdmin12345x",
  name: "مدیر کیفیت",
  mobile: "09120000001",
  workspace: "فضای کیفیت",
};
export const USER = {
  email: "qa-user@example.com",
  password: "QaUser12345x",
  name: "کاربر کیفیت",
  mobile: "09121112222",
  workspace: "فروشگاه کیفیت",
};

/** هیچ لایه‌ای نباید از این مقدارها فراتر برود (بودجه‌ی عملکرد؛ با متغیر محیطی قابل‌تنظیم برای CI کندتر) */
export const BUDGET = {
  ttfbMs: Number(process.env.QA_BUDGET_TTFB_MS) || 800,
  fcpMs: Number(process.env.QA_BUDGET_FCP_MS) || 2500,
  lcpMs: Number(process.env.QA_BUDGET_LCP_MS) || 3500,
  cls: Number(process.env.QA_BUDGET_CLS) || 0.1,
  jsKb: Number(process.env.QA_BUDGET_JS_KB) || 450, // حجم فشرده‌ی JS هر صفحه‌ی عمومی
  requests: Number(process.env.QA_BUDGET_REQUESTS) || 60,
  domNodes: Number(process.env.QA_BUDGET_DOM_NODES) || 1800,
};
