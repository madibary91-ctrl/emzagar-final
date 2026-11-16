/**
 * تیکت پشتیبانی: کاربر ثبت می‌کند ← مدیر کل پاسخ می‌دهد (یادداشت داخلی + پاسخ عمومی + بستن) ← کاربر می‌بیند و دوباره باز می‌کند
 */
import { AUTH, expect, newPage, readState, requireState, saveState, sql, test } from "./lib/kit";


test("[B6] کاربر تیکت پشتیبانی جدید ثبت می‌کند (با اعتبارسنجی)", async ({ browser }) => {
  const { stamp } = requireState("stamp");
  const subject = `خطا در ارسال پیامک تأیید ${stamp}`;
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/support");
  await expect(page.getByRole("heading", { name: "پشتیبانی" })).toBeVisible();
  await page.goto("/support/new");
  await expect(page.getByRole("heading", { name: "ثبت تیکت جدید" })).toBeVisible();

  // موضوع کوتاه توسط اعتبارسنجی مرورگر/سرور رد می‌شود
  await page.locator("#subject").fill("ab");
  await page.locator("#body").fill("کوتاه");
  await page.locator("form button").last().click();
  await expect(page).toHaveURL(/\/support\/new/);

  await page.locator("#subject").fill(subject);
  await page.locator("#category").selectOption({ index: 1 });
  await page.locator("#priority").selectOption({ index: 2 });
  await page.locator("#body").fill("پس از ثبت قرارداد، کد پیامکی برای امضاکننده ارسال نمی‌شود. لطفاً بررسی کنید.");
  await page.locator("form button").last().click();
  await page.waitForURL(/\/support\/\d+/);
  const id = Number(/\/support\/(\d+)/.exec(page.url())![1]);
  await expect(page.getByRole("heading", { name: subject })).toBeVisible();
  saveState({ ticketId: id, ticketSubject: subject });

  const [t] = await sql<{ status: string; number: string }>("select status, number from tickets where id=$1", [id]);
  expect(t.status).toBe("open");
  await ctx.close();
});

test("[A7] مدیر کل: تیکت را در صندوق می‌بیند، یادداشت داخلی و پاسخ عمومی می‌دهد و می‌بندد", async ({ browser }) => {
  const { ticketId, ticketSubject } = requireState("ticketId", "ticketSubject");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/platform");
  await expect(page.getByRole("heading", { name: "مدیریت پلتفرم" })).toBeVisible();
  await page.goto("/platform/tickets");
  await expect(page.getByRole("heading", { name: "مدیریت تیکت‌ها" })).toBeVisible();
  await page.getByText(ticketSubject).first().click();
  await expect(page).toHaveURL(new RegExp(`/platform/tickets/${ticketId}`));

  // یادداشت داخلی (برای کاربر نمایش داده نمی‌شود)
  await page.locator("#staff-reply").fill("یادداشت داخلی محرمانه: لاگ پیامک را بررسی کنید");
  await page.locator("input[name=internal]").check();
  await page.getByRole("button", { name: /ارسال \/ ثبت/ }).click();
  await expect(page.getByText("ثبت شد.")).toBeVisible();

  // پاسخ عمومی + بستن
  await page.locator("#staff-reply").fill("سلام، پنل پیامک شما در حالت آزمایشی بود؛ تنظیم شد و مشکل برطرف شد.");
  await page.locator("input[name=internal]").uncheck();
  await page.locator("#new-status").selectOption("closed");
  await page.getByRole("button", { name: /ارسال \/ ثبت/ }).click();
  await expect(page.getByText("ثبت شد.")).toBeVisible();

  await expect.poll(async () => (await sql<{ status: string }>("select status from tickets where id=$1", [ticketId]))[0].status).toBe("closed");
  await ctx.close();
});

test("[B6] کاربر پاسخ را می‌بیند (بدون یادداشت داخلی)، اعلان می‌گیرد و تیکت را دوباره باز می‌کند", async ({ browser }) => {
  const { ticketId, ticketSubject } = requireState("ticketId", "ticketSubject");
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto(`/support/${ticketId}`);
  await expect(page.getByRole("heading", { name: ticketSubject })).toBeVisible();
  await expect(page.getByText("مشکل برطرف شد")).toBeVisible();
  await expect(page.getByText("یادداشت داخلی محرمانه")).toHaveCount(0);
  expect(await page.content()).not.toContain("یادداشت داخلی محرمانه");

  const n = await sql("select 1 from user_notifications un join users u on u.id=un.user_id where u.email=$1", [readState().userEmail]);
  expect(n.length).toBeGreaterThan(0);

  await page.locator("#reply").fill("ممنون، اما هنوز یک مورد باقی مانده است.");
  await page.getByRole("button", { name: "ارسال" }).click();
  await expect.poll(async () => (await sql<{ status: string }>("select status from tickets where id=$1", [ticketId]))[0].status).not.toBe("closed");

  // کاربر دیگر به تیکت این کاربر دسترسی ندارد
  const other = await newPage(browser, { auth: AUTH.admin });
  const r = await other.page.goto(`/support/${ticketId}`);
  expect(r?.status()).not.toBe(500);
  await expect(other.page.getByText("یادداشت داخلی محرمانه")).toHaveCount(0);
  await other.ctx.close();
  await ctx.close();
});
