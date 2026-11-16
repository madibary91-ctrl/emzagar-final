/**
 * آمادگی تجاری: داده‌ی نمونه، راهنمای تعاملی، سرویس‌های هوش مصنوعی، سئو و لایسنس
 */
import { AUTH, expect, newPage, sql, test } from "./lib/kit";

test("[C1] راهنمای تعاملی: اجرای دستی، رد کردن، ماندگاری و اجرای دوباره از صفحه‌ی داده‌های نمونه", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin");
  await expect(page.getByTestId("tour-card")).toHaveCount(0); // ربات تست: اجرای خودکار خاموش است
  await page.getByTestId("tour-help").click();
  const card = page.getByTestId("tour-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading")).toContainText("خوش آمدید");
  await page.getByTestId("tour-next").click();
  await expect(card.getByRole("heading")).toBeVisible();
  await page.getByTestId("tour-prev").click();
  await expect(card.getByRole("heading")).toContainText("خوش آمدید");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  const prefs = await sql<{ value: string }>("select value from user_prefs where key='admin_tour' order by updated_at desc limit 1");
  expect(prefs[0]?.value).toBe("dismissed");

  await page.goto("/admin/demo");
  await page.getByTestId("tour-restart").click();
  await expect(page.getByTestId("tour-card")).toBeVisible();
  await page.getByTestId("tour-skip").click();
  await expect(page.getByTestId("tour-card")).toHaveCount(0);
  await ctx.close();
});

test("[C2] داده‌های نمونه: ساخت با یک دکمه و پاک‌سازی کامل با تأیید", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/demo");
  await page.getByTestId("demo-seed").click();
  await expect(page.getByRole("status").filter({ hasText: "داده‌های نمونه ساخته شد" })).toBeVisible({ timeout: 30_000 });
  const [seeded] = await sql<{ n: number }>("select count(*)::int n from demo_records where entity='contract'");
  expect(seeded.n).toBeGreaterThanOrEqual(10);
  await page.goto("/admin");
  await expect(page.getByText("طراحی وب‌سایت شرکتی آریا").first()).toBeVisible();

  await page.goto("/admin/demo");
  await page.getByTestId("demo-clear").click();
  await page.getByRole("dialog").getByRole("button", { name: "بله، پاک شود" }).click();
  await expect(page.getByRole("status").filter({ hasText: /پاک شد/ })).toBeVisible({ timeout: 30_000 });
  const [left] = await sql<{ n: number }>("select count(*)::int n from demo_records");
  expect(left.n).toBe(0);
  await ctx.close();
});

test("[C3] تنظیمات هوش مصنوعی: انتخاب سرویس دلخواه و تغییر راهنمای کلید", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/settings");
  const select = page.locator("#ai_provider");
  await expect(select).toBeVisible();
  for (const label of ["OpenAI (ChatGPT)", "Google Gemini", "Anthropic Claude", "GapGPT"]) await expect(select.locator("option", { hasText: label })).toHaveCount(1);
  await select.selectOption("anthropic");
  await expect(page.locator("#ai_api_key")).toHaveAttribute("placeholder", /sk-ant/);
  await ctx.close();
});

test("[C4] سئو: robots، sitemap، canonical، JSON-LD و noindex برای پنل", async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  const robots = await page.request.get("/robots.txt");
  expect(robots.ok()).toBe(true);
  const txt = await robots.text();
  expect(txt).toMatch(/Sitemap:/i);
  expect(txt).toMatch(/Disallow: \/admin/);
  const sm = await page.request.get("/sitemap.xml");
  expect(sm.ok()).toBe(true);
  expect(await sm.text()).toContain("<urlset");

  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  expect(await page.locator('script[type="application/ld+json"]').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator("h1")).toHaveCount(1);
  await ctx.close();

  const admin = await newPage(browser, { auth: AUTH.admin });
  await admin.page.goto("/admin");
  await expect(admin.page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await admin.ctx.close();
});

test("[C5] لایسنس و به‌روزرسانی: صفحه‌ی مدیر کل و وضعیت فعال‌نشده", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/platform/license");
  await expect(page.getByRole("heading", { name: "لایسنس و به‌روزرسانی" })).toBeVisible();
  await expect(page.getByTestId("license-state")).toContainText("فعال‌نشده");
  await expect(page.getByTestId("current-version")).toContainText(/\d+\.\d+\.\d+/);
  await page.locator("#license_key").fill("bad-key");
  await page.getByTestId("license-activate").click();
  await expect(page.getByRole("alert").filter({ hasText: /قالب کلید/ })).toBeVisible();
  await ctx.close();
});
