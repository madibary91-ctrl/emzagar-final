/**
 * پنل کاربر (۲): مشخصات حساب، رمز عبور، دستگاه‌های متصل، خروجی داده‌های شخصی و حذف حساب
 * (این فایل عمداً آخر اجرا می‌شود چون حساب را حذف می‌کند)
 */
import { alert, AUTH, expect, login, newPage, readState, requireState, saveState, sql, test } from "./lib/kit";


const form = (page: import("@playwright/test").Page, inputSel: string) => page.locator("form", { has: page.locator(inputSel) });

test("[B5] ویرایش مشخصات: نام، و تغییر موبایل فقط با رمز فعلی", async ({ browser }) => {
  const { userEmail, userPass } = requireState("userEmail", "userPass");
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "حساب من" })).toBeVisible();
  await expect(page.locator("#acc-email")).toBeDisabled().catch(async () => expect(page.locator("#acc-email")).toHaveAttribute("readonly", ""));

  await page.locator("#acc-name").fill("کاربر ویرایش‌شده");
  await form(page, "#acc-name").locator("button").last().click();
  await expect(page.getByRole("status").filter({ hasText: /ذخیره|به‌روز/ }).first()).toBeVisible();
  expect((await sql<{ name: string }>("select name from users where email=$1", [userEmail]))[0].name).toBe("کاربر ویرایش‌شده");

  // تغییر موبایل بدون رمز → خطا
  await page.locator("#acc-mobile").fill("09129998888");
  await form(page, "#acc-name").locator("button").last().click();
  await expect(alert(page).first()).toBeVisible();
  expect((await sql<{ mobile: string }>("select mobile from users where email=$1", [userEmail]))[0].mobile).toBe("09121112222");

  // با رمز درست
  await page.locator("#acc-mobile-pw").fill(userPass);
  await form(page, "#acc-name").locator("button").last().click();
  await expect.poll(async () => (await sql<{ mobile: string }>("select mobile from users where email=$1", [userEmail]))[0].mobile).toBe("09129998888");
  await ctx.close();
});

test("[B5] دستگاه‌های متصل: نشست دوم دیده می‌شود، با «بستن نشست» و «خروج از همه» باطل می‌شود", async ({ browser }) => {
  const { userEmail, userPass } = requireState("userEmail", "userPass");
  const main = await newPage(browser, { auth: AUTH.user });
  const second = await newPage(browser); // «گوشی»
  await login(second.page, userEmail, userPass);
  await expect(second.page).toHaveURL(/\/admin/);

  await main.page.goto("/account");
  const items = main.page.locator("li", { hasText: "IP:" });
  await expect(items).toHaveCount(2);
  await expect(main.page.getByText("این دستگاه")).toBeVisible();
  await main.page.getByRole("button", { name: "بستن نشست" }).first().click();
  await expect(items).toHaveCount(1);
  await second.page.goto("/admin");
  await expect(second.page).toHaveURL(/\/login/);

  // دوباره وارد می‌شود و این بار «خروج از همه‌ی دستگاه‌های دیگر»
  await login(second.page, userEmail, userPass);
  await expect(second.page).toHaveURL(/\/admin/);
  await main.page.reload();
  await main.page.getByRole("button", { name: "خروج از همه‌ی دستگاه‌های دیگر" }).click();
  await second.page.goto("/admin");
  await expect(second.page).toHaveURL(/\/login/);
  await second.ctx.close();
  await main.ctx.close();
});

test("[B5] تغییر رمز: اعتبارسنجی، موفقیت، ابطال نشست‌های دیگر و ورود با رمز جدید", async ({ browser }) => {
  const { userEmail, userPass } = requireState("userEmail", "userPass");
  const newPass = "NewPass456y";
  const main = await newPage(browser, { auth: AUTH.user });
  const other = await newPage(browser);
  await login(other.page, userEmail, userPass);
  await expect(other.page).toHaveURL(/\/admin/);

  await main.page.goto("/account");
  const f = form(main.page, "#pw-cur");
  const submit = f.locator("button").last();
  // رمز فعلی غلط
  await main.page.locator("#pw-cur").fill("WrongOld123");
  await main.page.locator("#pw-new").fill(newPass);
  await main.page.locator("#pw-confirm").fill(newPass);
  await submit.click();
  await expect(alert(main.page).first()).toBeVisible();
  // تکرار نامتطابق
  await main.page.locator("#pw-cur").fill(userPass);
  await main.page.locator("#pw-confirm").fill("Different789z");
  await submit.click();
  await expect(alert(main.page).first()).toBeVisible();
  // رمز ضعیف (مرورگر minLength را اعمال می‌کند؛ پس طول کافی ولی بدون عدد)
  await main.page.locator("#pw-new").fill("onlyletters");
  await main.page.locator("#pw-confirm").fill("onlyletters");
  await submit.click();
  await expect(alert(main.page).first()).toBeVisible();
  // درست
  await main.page.locator("#pw-new").fill(newPass);
  await main.page.locator("#pw-confirm").fill(newPass);
  await submit.click();
  await expect(main.page.getByRole("status").filter({ hasText: /رمز|تغییر/ }).first()).toBeVisible();
  saveState({ userNewPass: newPass });

  // نشست دیگر باطل شده و ایمیل هشدار رفته است
  await other.page.goto("/admin");
  await expect(other.page).toHaveURL(/\/login/);
  const alerts = await sql("select 1 from notifications where recipient=$1 and subject ilike '%رمز%'", [userEmail]);
  expect(alerts.length).toBeGreaterThan(0);
  await other.ctx.close();
  await main.ctx.close();

  // رمز قدیمی دیگر کار نمی‌کند، رمز جدید کار می‌کند
  const fresh = await newPage(browser);
  await login(fresh.page, userEmail, userPass);
  await expect(alert(fresh.page)).toBeVisible();
  await login(fresh.page, userEmail, newPass);
  await expect(fresh.page).toHaveURL(/\/admin/);
  await fresh.ctx.storageState({ path: AUTH.user });
  await fresh.ctx.close();
});

test("[B7] خروجی داده‌های شخصی (JSON) کامل است و رمز/هش رمز ندارد", async ({ browser }) => {
  const { userEmail } = requireState("userEmail");
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/account");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /دانلود همه‌ی داده‌های من/ }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.json$/);

  const r = await page.request.get("/api/account/export");
  expect(r.status()).toBe(200);
  const text = await r.text();
  const data = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(data).length).toBeGreaterThan(2);
  expect(text).toContain(userEmail);
  expect(text).toContain("کاربر ویرایش‌شده");
  expect(text).not.toMatch(/passwordHash|password_hash|scrypt\$|NewPass456y|User12345x/i);

  // بدون ورود، خروجی داده در دسترس نیست
  const anon = await newPage(browser);
  const denied = await anon.page.request.get("/api/account/export", { maxRedirects: 0 });
  expect([401, 403, 302, 307]).toContain(denied.status());
  await anon.ctx.close();
  await ctx.close();
});

test("[B7] حذف حساب: عبارت و رمز اشتباه رد می‌شود؛ با اطلاعات درست حساب پاک و ورود ناممکن می‌شود", async ({ browser }) => {
  const { userEmail, userNewPass } = requireState("userEmail", "userNewPass");
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/account");
  const phrase = (await page.locator("#del-confirm").getAttribute("placeholder")) ?? "حذف حساب من";
  const del = form(page, "#del-pw").locator("button").last();

  await page.locator("#del-pw").fill(userNewPass);
  await page.locator("#del-confirm").fill("عبارت اشتباه");
  await del.click();
  await expect(alert(page).first()).toBeVisible();

  await page.locator("#del-pw").fill("WrongPass000");
  await page.locator("#del-confirm").fill(phrase);
  await del.click();
  await expect(alert(page).first()).toBeVisible();
  expect(await sql("select 1 from users where email=$1", [userEmail])).toHaveLength(1);

  await page.locator("#del-pw").fill(userNewPass);
  await page.locator("#del-confirm").fill(phrase);
  await del.click();
  await page.waitForURL(/\/login\?deleted=1/, { timeout: 30_000 });
  await expect(page.getByText(/حذف شد|حذف/).first()).toBeVisible();
  expect(await sql("select 1 from users where email=$1", [userEmail])).toHaveLength(0);

  await login(page, userEmail, userNewPass);
  await expect(alert(page)).toBeVisible();
  expect(page.url()).toContain("/login");
  const stillThere = await sql("select 1 from users where email=$1", [readState().adminEmail]);
  expect(stillThere).toHaveLength(1); // حساب مدیر دست‌نخورده است
  await ctx.close();
});
