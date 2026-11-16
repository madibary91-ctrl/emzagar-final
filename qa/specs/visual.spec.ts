/**
 * ۵) رگرسیون بصری — مقایسه‌ی پیکسلی هر صفحه با عکس مرجع (qa/visual/__baselines__)
 * پایداری: انیمیشن خاموش، قلم محلی Vazirmatn، ساعت مرورگر ثابت، و پوشاندن (mask) هر المانی که عدد/تاریخ دارد
 * در صفحه‌های واردشده (داده‌ی نمونه با تاریخ نسبی ساخته می‌شود). چیدمان، رنگ، قلم و فاصله‌ها همچنان سنجیده می‌شوند.
 * به‌روزرسانی عمدی: `npm run qa:visual:update` و بازبینی تفاوت تصاویر در git.
 */
import type { Page } from "@playwright/test";
import { AUTH, expect, newPage, test, type Device } from "../lib/kit";
import { PAGES, resolvePath, type PageDef } from "../routes";
import { requireState } from "../lib/state";

const FROZEN = new Date("2026-01-15T09:00:00+03:30");
const MOBILE = new Set(["home", "pricing", "login", "register", "dashboard", "sign-invalid"]);
const DARK = new Set(["home", "login"]);

async function prepare(page: Page) {
  await page.clock.install({ time: FROZEN }); // ساعت مرورگر از لحظه‌ی ثابت شروع می‌شود (تاریخ‌های سمت کلاینت پایدارند)
}

async function stabilize(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important} ::-webkit-scrollbar{display:none}" });
  await page.waitForTimeout(500);
}

async function shot(browser: import("@playwright/test").Browser, def: PageDef, device: Device, theme: "light" | "dark") {
  const { ctx, page } = await newPage(browser, { auth: def.auth === "none" ? undefined : AUTH[def.auth], device, colorScheme: theme });
  await prepare(page);
  const res = await page.goto(resolvePath(def, requireState()));
  expect(res?.status()).toBeLessThan(400);
  await stabilize(page);
  const mask = def.auth === "none" ? [] : [page.locator(':text-matches("[0-9۰-۹]{2,}")'), page.locator("time")];
  await expect(page).toHaveScreenshot(`${def.name}-${device}${theme === "dark" ? "-dark" : ""}.png`, { fullPage: true, mask, maskColor: "#8b8b8b" });
  await ctx.close();
}

test.describe("دسکتاپ", () => {
  for (const def of PAGES.filter((p) => p.visual)) test(`[V1] ${def.name}`, async ({ browser }) => shot(browser, def, "desktop", "light"));
});
test.describe("موبایل", () => {
  for (const def of PAGES.filter((p) => p.visual && MOBILE.has(p.name))) test(`[V2] ${def.name}`, async ({ browser }) => shot(browser, def, "mobile", "light"));
});
test.describe("تم تاریک", () => {
  for (const def of PAGES.filter((p) => p.visual && DARK.has(p.name))) test(`[V3] ${def.name}`, async ({ browser }) => shot(browser, def, "desktop", "dark"));
});
