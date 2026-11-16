/**
 * بخش سیزدهم — تقویم شمسی در فرم‌ها (JalaliDatePicker)
 * کاربر همه‌چیز را شمسی می‌بیند و تایپ می‌کند؛ مقدار ارسالی به سرور همچنان میلادی ISO است.
 * نمونه‌ی زنده: فیلتر تاریخ در فهرست قراردادها (/admin).
 */
import fs from "node:fs";
import { AUTH, expect, newPage, test } from "./lib/kit";

test("[D1] تقویم شمسی: انتخاب با ماوس، تایپ مستقیم، اعتبارسنجی و ارسال به‌صورت میلادی", async ({ browser }) => {
  test.skip(!fs.existsSync(AUTH.admin), "نشست مدیر (آزمون‌های ۰۱) موجود نیست");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin");
  await page.getByText("فیلترهای پیشرفته").click();

  const from = page.locator("#f-from");
  const to = page.locator("#f-to");
  const fromIso = page.locator("input[type=hidden][name=from]");
  const toIso = page.locator("input[type=hidden][name=to]");
  const pop = page.getByTestId("jdp-popover");

  // انتخاب با ماوس: سال و ماه از فهرست، روز از شبکه
  await page.getByRole("button", { name: "باز کردن تقویم شمسی" }).first().click();
  await expect(pop).toBeVisible();
  await pop.getByLabel("سال").selectOption("1405");
  await pop.getByLabel("ماه").selectOption("2");
  await expect(pop.locator('button[data-date="1405/02/31"]')).toBeVisible(); // اردیبهشت ۳۱ روز
  await expect(pop.locator('button[data-date="1405/02/32"]')).toHaveCount(0);
  await pop.locator('button[data-date="1405/02/15"]').click();
  await expect(pop).toBeHidden();
  await expect(from).toHaveValue("۱۴۰۵/۰۲/۱۵");
  await expect(fromIso).toHaveValue("2026-05-05");

  // تایپ مستقیم با ارقام لاتین و فارسی
  await from.fill("1405/03/01");
  await expect(fromIso).toHaveValue("2026-05-22");
  await from.fill("۱۴۰۵/۰۲/۱۵");
  await expect(fromIso).toHaveValue("2026-05-05");

  // ورودی نامعتبر: مقدار خالی می‌رود و فیلد خطا می‌گیرد (اسفند ۳۰ در سال غیرکبیسه ۱۴۰۴ وجود ندارد)
  await from.fill("1404/12/30");
  await expect(fromIso).toHaveValue("");
  await expect(from).toHaveAttribute("aria-invalid", "true");
  await from.fill("1403/12/30"); // کبیسه
  await expect(fromIso).toHaveValue("2025-03-20");
  await expect(from).not.toHaveAttribute("aria-invalid", "true");

  // صفحه‌کلید: Alt+↓ باز می‌کند، فلش‌ها روز را جابه‌جا می‌کنند (RTL: ← = روز بعد)، Enter انتخاب، Esc می‌بندد
  await from.fill("1405/02/15");
  await from.press("Alt+ArrowDown");
  await expect(pop).toBeVisible();
  await expect(pop.locator('button[data-date="1405/02/15"]')).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(pop.locator('button[data-date="1405/02/16"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(pop.locator('button[data-date="1405/02/23"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pop).toBeHidden();
  await expect(fromIso).toHaveValue("2026-05-13");
  await from.press("Alt+ArrowDown");
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(from).toBeFocused();

  // «امروز» و «پاک کردن»
  await page.getByRole("button", { name: "باز کردن تقویم شمسی" }).nth(1).click();
  await pop.getByRole("button", { name: "امروز" }).click();
  await expect(toIso).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await page.getByRole("button", { name: "باز کردن تقویم شمسی" }).nth(1).click();
  await pop.getByRole("button", { name: "پاک کردن" }).click();
  await expect(toIso).toHaveValue("");
  await expect(to).toHaveValue("");

  // ارسال فرم: پارامترهای URL میلادی‌اند و پس از بارگذاری دوباره به شمسی نمایش داده می‌شوند
  await from.fill("1405/02/15");
  await to.fill("1405/02/20");
  await page.getByRole("button", { name: "اعمال", exact: true }).click();
  await expect(page).toHaveURL(/from=2026-05-05/);
  await expect(page).toHaveURL(/to=2026-05-10/);
  await expect(page.locator("#f-from")).toHaveValue("۱۴۰۵/۰۲/۱۵");
  await expect(page.locator("#f-to")).toHaveValue("۱۴۰۵/۰۲/۲۰");
  await ctx.close();
});

test("[D1] تقویم شمسی: در موبایل داخل صفحه جا می‌شود و بدون سرریز افقی است", async ({ browser }) => {
  test.skip(!fs.existsSync(AUTH.admin), "نشست مدیر (آزمون‌های ۰۱) موجود نیست");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin, device: "mobile" });
  await page.goto("/admin?from=2026-05-05");
  await page.getByText("فیلترهای پیشرفته").click();
  await page.getByRole("button", { name: "باز کردن تقویم شمسی" }).first().click();
  const pop = page.getByTestId("jdp-popover");
  await expect(pop).toBeVisible();
  const box = (await pop.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  await ctx.close();
});
