/**
 * جعبه‌ابزار مشترک لایه‌های QA: زمینه‌ی مرورگر با IP یکتا (برای محدودیت نرخ)، نگهبان خطا، دسترسی فقط‌خواندنی به DB
 * و ثبت معیارها برای گزارش نهایی.
 */
import fs from "node:fs";
import path from "node:path";
import { test as base, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";
import { AUTH, BASE, DB_URL, REPORT_DIR } from "./env";

export { expect, AUTH, BASE };

/* ───────── دیتابیس ───────── */
let pool: Pool | undefined;
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  pool ??= new Pool({ connectionString: DB_URL, max: 2 });
  return (await pool.query(text, params)).rows as T[];
}

/* ───────── IP یکتا برای هر زمینه (TRUSTED_PROXY_HOPS=1) ───────── */
let seq = 0;
const ipBase = 30 + (process.pid % 200);
export function nextIp(): string {
  const n = ++seq;
  return `10.${ipBase}.${Math.floor(n / 250)}.${(n % 250) + 1}`;
}

export type Device = "desktop" | "tablet" | "mobile";
export const VIEWPORTS: Record<Device, { width: number; height: number; isMobile: boolean; hasTouch: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  tablet: { width: 768, height: 1024, isMobile: false, hasTouch: true },
  mobile: { width: 375, height: 740, isMobile: true, hasTouch: true },
};

/* ───────── نگهبان خطای مرورگر/سرور ───────── */
const crashes: string[] = [];
const serverErrors: string[] = [];
function guard(page: Page) {
  page.on("pageerror", (e) => crashes.push(`${page.url()} → ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

export const test = base.extend<{ guard: void }>({
  guard: [
    async ({}, use) => {
      crashes.length = 0;
      serverErrors.length = 0;
      await use();
      expect(crashes, "استثنای جاوااسکریپت در مرورگر").toEqual([]);
      expect(serverErrors, "پاسخ خطای ۵xx از سرور").toEqual([]);
    },
    { auto: true },
  ],
});

export interface CtxOpts {
  auth?: string;
  device?: Device;
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
}

export async function newContext(browser: Browser, opts: CtxOpts = {}): Promise<BrowserContext> {
  const vp = VIEWPORTS[opts.device ?? "desktop"];
  const ctx = await browser.newContext({
    baseURL: BASE,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    storageState: opts.auth && fs.existsSync(opts.auth) ? opts.auth : undefined,
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    colorScheme: opts.colorScheme ?? "light",
    reducedMotion: opts.reducedMotion === false ? "no-preference" : "reduce",
    serviceWorkers: "block", // سرویس‌ورکر نباید نتیجه‌ی آزمون‌ها را تغییر دهد؛ خودش جداگانه آزموده می‌شود
    extraHTTPHeaders: { "x-forwarded-for": nextIp() },
  });
  ctx.on("page", guard);
  return ctx;
}

export async function newPage(browser: Browser, opts: CtxOpts = {}) {
  const ctx = await newContext(browser, opts);
  const page = await ctx.newPage();
  return { ctx, page };
}

/** کلاینت HTTP بدون مرورگر (برای DAST، قرارداد API و دود) با IP یکتا */
export async function newApi(opts: { auth?: string; headers?: Record<string, string>; ip?: string } = {}): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: BASE,
    storageState: opts.auth && fs.existsSync(opts.auth) ? opts.auth : undefined,
    extraHTTPHeaders: { "x-forwarded-for": opts.ip ?? nextIp(), ...opts.headers },
    ignoreHTTPSErrors: true,
  });
}

/* ───────── ثبت معیار برای گزارش ───────── */
export function recordMetric(layer: string, row: Record<string, unknown>) {
  fs.mkdirSync(path.join(REPORT_DIR, "data"), { recursive: true });
  fs.appendFileSync(path.join(REPORT_DIR, "data", `${layer}.jsonl`), JSON.stringify(row) + "\n");
}

/* ───────── ابزارهای کوچک ───────── */
export const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export const toEn = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));

/** در حالت آزمایشی کد تأیید در صفحه نمایش داده می‌شود (همان کدی که ایمیل می‌شد) */
export async function readDevCode(page: Page, pattern: RegExp = /کد شما\s*([۰-۹0-9]{5,6})/): Promise<string> {
  const box = page.getByText(/حالت آزمایشی/).first();
  await expect(box).toBeVisible();
  const m = pattern.exec((await box.textContent()) ?? "");
  if (!m) throw new Error("کد آزمایشی در صفحه پیدا نشد");
  return toEn(m[1]);
}
