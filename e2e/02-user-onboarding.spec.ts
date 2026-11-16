/**
 * بخش دوم — پنل کاربر (۱): ثبت‌نام، تأیید ایمیل، ورود و داشبورد
 */
import { alert, AUTH, confirmEmail, expect, login, newPage, register, requireState, saveState, sql, test } from "./lib/kit";


test("[B1] ثبت‌نام کاربر جدید ← رد کد اشتباه ← تأیید ایمیل ← ورود خودکار", async ({ browser }) => {
  const { stamp } = requireState("stamp");
  const email = `user-${stamp}@example.com`;
  const password = "User12345x";
  saveState({ userEmail: email, userPass: password, userName: "کاربر آزمون", userMobile: "09121112222" });
  const { ctx, page } = await newPage(browser);

  // اعتبارسنجی فرم: موبایل نامعتبر
  await page.goto("/register");
  await page.getByLabel("نام کسب‌وکار / فروشگاه").fill("فروشگاه کاربر");
  await page.getByLabel("نام و نام خانوادگی شما").fill("کاربر آزمون");
  await page.getByLabel("ایمیل", { exact: true }).fill(email);
  await page.getByLabel("موبایل").fill("12345");
  await page.getByLabel("رمز عبور").fill(password);
  await page.getByRole("button", { name: "ساخت فضای کاری" }).click();
  await expect(alert(page)).toContainText("موبایل");

  await register(page, { workspaceName: "فروشگاه کاربر", name: "کاربر آزمون", email, mobile: "09121112222", password });

  // تا تأیید ایمیل هیچ نشستی ساخته نمی‌شود
  const probe = await page.request.get("/admin");
  expect(await probe.text()).not.toContain("قراردادهای صادر شده");

  // کد اشتباه رد می‌شود
  await page.locator("#code").fill("000000");
  await page.getByRole("button", { name: "تأیید ایمیل و ورود" }).click();
  await expect(alert(page).first()).toBeVisible();
  expect(page.url()).toContain("/verify-email");

  await confirmEmail(page);
  await expect(page).toHaveURL(/\/admin/);

  const [u] = await sql<{ role: string; email_verified_at: string | null }>("select role,email_verified_at from users where email=$1", [email]);
  expect(u.role).toBe("user"); // فقط اولین کاربر (نصب‌کننده) مدیر کل است
  expect(u.email_verified_at).not.toBeNull();
  const acts = (await sql<{ action: string }>("select distinct action from audit_logs")).map((r) => r.action);
  expect(acts).toEqual(expect.arrayContaining(["auth.registered", "auth.email_verified"]));

  // ثبت‌نام دوباره با همان ایمیل رد می‌شود
  const other = await newPage(browser);
  await other.page.goto("/register");
  await other.page.getByLabel("نام کسب‌وکار / فروشگاه").fill("تکراری");
  await other.page.getByLabel("نام و نام خانوادگی شما").fill("تکراری");
  await other.page.getByLabel("ایمیل", { exact: true }).fill(email);
  await other.page.getByLabel("موبایل").fill("09125556666");
  await other.page.getByLabel("رمز عبور").fill(password);
  await other.page.getByRole("button", { name: "ساخت فضای کاری" }).click();
  await expect(alert(other.page)).toContainText("قبلاً ثبت‌نام");
  await other.ctx.close();

  await ctx.storageState({ path: AUTH.user });
  await ctx.close();
});

test("[B1] خروج و ورود با ایمیل/رمز؛ کاربر عادی به بخش مدیر کل دسترسی ندارد", async ({ browser }) => {
  const { userEmail, userPass } = requireState("userEmail", "userPass");
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/admin");
  await page.getByRole("button", { name: "خروج از حساب" }).click();
  await expect(page).toHaveURL(/\/login/);
  await login(page, userEmail, userPass);
  await expect(page).toHaveURL(/\/admin/);

  await page.goto("/platform");
  await expect(page.getByRole("heading", { name: "مدیریت پلتفرم" })).toHaveCount(0);
  await page.goto("/platform/tickets");
  await expect(page.getByRole("heading", { name: "مدیریت تیکت‌ها" })).toHaveCount(0);
  await ctx.storageState({ path: AUTH.user });
  await ctx.close();
});

test("[B2] داشبورد کاربر پیش از دریافت قرارداد: حالت خالی و ناوبری", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "قراردادهای من" })).toBeVisible();
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "اعلان‌ها" })).toBeVisible();
  await ctx.close();
});
