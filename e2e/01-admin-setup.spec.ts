/**
 * بخش اول — پنل مدیر (۱): نصب‌کننده‌ی وب، ورود، داشبورد، تنظیمات و قالب قرارداد
 * مثل یک مدیر واقعی روی دیتابیس «خالی» شروع می‌کنیم.
 */
import { alert, AUTH, BASE, expect, login, makePng, newPage, readState, requireState, saveState, sql, stamp, test } from "./lib/kit";


const KAVENEGAR_KEY = "KN-SECRET-KEY-1234567890";
const AI_KEY = "sk-e2e-secret-key-1234567890";

/** فیلدهای نصب‌کننده برچسب متصل ندارند؛ از «برچسب ← کنترل بعدی» پیدا می‌شوند */
const wizardField = (page: import("@playwright/test").Page, label: string) =>
  page.locator(`xpath=//label[normalize-space()="${label}"]/following-sibling::*[1]/descendant-or-self::input[1]`);

test("[A1] نصب‌کننده‌ی وب روی دیتابیس خالی؛ ورود خودکار مدیر؛ داشبورد", async ({ browser }) => {
  const s = stamp();
  const adminEmail = `admin-${s}@example.com`;
  const adminPass = "Admin12345x";
  saveState({ stamp: s, adminEmail, adminPass, adminName: "مدیر آزمون", workspace: "فضای آزمون" });
  const { ctx, page } = await newPage(browser);

  // پیش از نصب: همه‌ی صفحه‌ها به نصب‌کننده هدایت و APIها 503 می‌شوند، ولی سلامت‌سنج کار می‌کند
  await page.goto("/login");
  await expect(page).toHaveURL(/\/install/);
  expect((await page.request.get("/api/v1/stats")).status()).toBe(503);
  expect((await page.request.get("/api/health")).ok()).toBe(true);

  await page.getByRole("button", { name: /شروع نصب/ }).click();
  await wizardField(page, "نام سایت یا کسب‌وکار").fill("فضای آزمون");
  await wizardField(page, "نام و نام‌خانوادگی شما").fill("مدیر آزمون");
  await wizardField(page, "ایمیل").fill(adminEmail);
  await wizardField(page, "موبایل").fill("09120000001");
  await wizardField(page, "رمز عبور").fill(adminPass);
  await wizardField(page, "تکرار رمز عبور").fill(adminPass);
  await page.getByRole("button", { name: /نصب را شروع کن/ }).click();
  await expect(page.getByText("نصب با موفقیت انجام شد")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("link", { name: /ورود به پنل مدیریت/ }).click();
  await expect(page).toHaveURL(/\/admin/);

  // داشبورد
  await expect(page.getByRole("heading", { name: "قراردادهای صادر شده" })).toBeVisible();
  await expect(page.locator('a[href="/admin/templates"]').first()).toBeAttached();
  await expect(page.locator('a[href="/admin/settings"]').first()).toBeAttached();
  await expect(page.locator('a[href="/platform"]').first()).toBeAttached(); // اولین کاربر = مدیر کل پلتفرم
  await expect(page.getByRole("link", { name: /خروجی CSV/ })).toBeVisible();

  const [row] = await sql<{ role: string; email_verified_at: string | null }>("select role, email_verified_at from users where email=$1", [adminEmail]);
  expect(row.role).toBe("admin");
  expect(row.email_verified_at).not.toBeNull();
  await ctx.storageState({ path: AUTH.admin });
  await ctx.close();
});

test("[A1] خروج، رمز اشتباه رد می‌شود، ورود دوباره با رمز درست", async ({ browser }) => {
  const { adminEmail, adminPass } = requireState("adminEmail", "adminPass");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin");
  await page.getByRole("button", { name: "خروج از حساب" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/login/); // صفحه‌ی محافظت‌شده بدون نشست

  await login(page, adminEmail, "WrongPass123");
  await expect(alert(page)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await login(page, adminEmail, adminPass);
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole("heading", { name: "قراردادهای صادر شده" })).toBeVisible();
  await ctx.storageState({ path: AUTH.admin });
  await ctx.close();

  const acts = (await sql<{ action: string }>("select distinct action from audit_logs")).map((r) => r.action);
  expect(acts).toContain("auth.login");
});

test("[A3] تنظیمات: پیامک (کلید رمزنگاری‌شده)، SMTP و آدرس سایت", async ({ browser }) => {
  const { adminEmail } = requireState("adminEmail");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "تنظیمات" })).toBeVisible();
  await page.locator("input[name=site_name]").fill("امضاگیر آزمون");
  await page.locator("input[name=admin_email]").fill(adminEmail);
  await page.locator("input[name=app_url]").fill(BASE);
  // حالت آزمایشی نگه داشته می‌شود تا هیچ پیامک واقعی (و هزینه‌ای) ارسال نشود؛ ولی کلید پنل واقعی وارد می‌شود
  await page.locator("select[name=sms_provider]").selectOption("log");
  await page.locator("input[name=kavenegar_api_key]").fill(KAVENEGAR_KEY);
  await page.locator("input[name=kavenegar_template]").fill("verify");
  await page.getByRole("button", { name: "ذخیره تنظیمات" }).click();
  await expect(page.getByText("تنظیمات ذخیره شد.")).toBeVisible();

  const [row] = await sql<{ value: string }>("select value from workspace_settings where key='kavenegar_api_key'");
  expect(row.value).not.toContain(KAVENEGAR_KEY); // رمزنگاری در دیتابیس
  expect(row.value.length).toBeGreaterThan(20);

  await page.reload();
  expect(await page.content()).not.toContain(KAVENEGAR_KEY); // هرگز به مرورگر برنمی‌گردد
  await expect(page.locator("input[name=kavenegar_api_key]")).toHaveAttribute("placeholder", /••••••/);
  await expect(page.locator("input[name=site_name]")).toHaveValue("امضاگیر آزمون");

  // آدرس سایت نامعتبر باید رد شود
  await page.locator("input[name=app_url]").fill("javascript:alert(1)");
  await page.getByRole("button", { name: "ذخیره تنظیمات" }).click();
  await expect(alert(page).first()).toBeVisible();
  await ctx.close();
});

test("[A3] تنظیمات هوش مصنوعی: کلید ماسک‌شده، رمزنگاری، رد آدرس داخلی (SSRF)، تست اتصال", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/settings");

  // آدرس داخلی/غیر HTTPS رد می‌شود
  await page.locator("#ai_api_key").fill(AI_KEY);
  await page.getByText("تنظیمات پیشرفته").click(); // <details>
  await page.locator("#ai_base_url").fill("http://127.0.0.1:8080/v1");
  await page.getByRole("button", { name: "ذخیره‌ی تنظیمات هوش مصنوعی" }).click();
  await expect(alert(page).filter({ hasText: /آدرس/ }).first()).toBeVisible();

  // آدرس‌های داخلی دیگر هم (localhost، IP متادیتای ابری) رد می‌شوند
  for (const bad of ["https://localhost/v1", "https://169.254.169.254/latest", "https://10.0.0.5/v1"]) {
    await page.locator("#ai_base_url").fill(bad);
    await page.getByRole("button", { name: "ذخیره‌ی تنظیمات هوش مصنوعی" }).click();
    await expect(alert(page).filter({ hasText: /آدرس/ }).first()).toBeVisible();
  }
  await page.locator("#ai_base_url").fill(""); // پیش‌فرض سرویس
  await page.locator("#ai_model").fill("gpt-4o-mini");
  // نمایش/پنهان‌کردن کلید
  await expect(page.locator("#ai_api_key")).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "نمایش کلید" }).click();
  await expect(page.locator("#ai_api_key")).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "پنهان کردن کلید" }).click();
  await page.getByRole("button", { name: "ذخیره‌ی تنظیمات هوش مصنوعی" }).click();
  await expect(page.getByText("تنظیمات هوش مصنوعی ذخیره شد.")).toBeVisible();

  const [row] = await sql<{ value: string }>("select value from workspace_settings where key='ai_api_key'");
  expect(row.value).not.toContain(AI_KEY);
  await page.reload();
  expect(await page.content()).not.toContain(AI_KEY);

  // «تست اتصال» با سرویس ساختگی باید یک نتیجه‌ی کنترل‌شده بدهد (نه کرش)
  await page.getByRole("button", { name: /تست اتصال/ }).click();
  await expect(page.locator("[role=alert],[role=status]").filter({ hasText: /نامعتبر|پاسخ|شناسایی|خطا|ناموفق|مجاز|اتصال/ }).first()).toBeVisible({ timeout: 40_000 });
  await ctx.close();

  const acts = (await sql<{ action: string }>("select distinct action from audit_logs")).map((r) => r.action);
  expect(acts).toContain("settings.ai_saved");
});

test("[A3] برندینگ: نام، شعار، لوگو، رنگ‌ها؛ حالت تاریک/روشن پایدار می‌ماند", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/branding");
  await page.locator("input[name=site_name]").fill("امضاگیر آزمون");
  await page.locator("input[name=brand_tagline]").fill("امضای مطمئن");
  await page.locator("input[name=logo]").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: makePng(96, 96) });
  await page.locator("input[name=brand_primary]").fill("#0b3d2e");
  await page.locator("input[name=brand_accent]").fill("#7ce3b0");
  await page.locator("select[name=brand_theme]").selectOption("light");
  await page.getByRole("button", { name: "ذخیره برندینگ" }).click();
  await expect(page.getByText(/برندینگ ذخیره شد/)).toBeVisible();

  await page.goto("/admin");
  expect((await page.content()).toLowerCase()).toContain("0b3d2e");
  await expect(page.locator('img[src*="/api/brand/logo"]').first()).toBeAttached();
  const logo = await page.request.get("/api/brand/logo");
  expect(logo.ok()).toBe(true);
  expect(logo.headers()["content-type"]).toContain("image/");

  // تاریک/روشن
  const toggle = page.getByRole("button", { name: "تغییر حالت تاریک/روشن" }).first();
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await toggle.click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before);
  const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bgAfter).not.toBe(bgBefore);
  const chosen = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(chosen);
  await toggle.click(); // بازگشت به حالت قبل
  await ctx.close();
});

test("[A2] قالب قرارداد: متن، متغیر، فیلد پویا (کد ملی/نشانی) و ذخیره", async ({ browser }) => {
  const s = readState().stamp ?? stamp();
  const title = `قالب خدمات ${s}`;
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/templates/new");
  await page.locator("input[name=title]").fill(title);
  await page.locator("input[name=description]").fill("قالب آزمون خودکار با فیلدهای پویا");
  const editor = page.locator("[contenteditable=true]").first();
  await editor.click();
  await page.keyboard.type("این قرارداد میان طرفین بسته می‌شود. نام طرف دوم: ");
  await page.getByRole("button", { name: /^\[[A-Za-z_]+\]$/ }).first().click();
  await page.keyboard.type(" — کد ملی: ");
  await page.locator('button[title^="{{field:national_id"]').click();
  await page.keyboard.type(" — نشانی: ");
  await page.locator('button[title^="{{field:address"]').click();
  await page.keyboard.type(" — موضوع: خدمات مشاوره و پشتیبانی به مدت یک سال.");
  await page.getByRole("button", { name: "ذخیره قالب" }).click();
  await expect(page).toHaveURL(/\/admin\/templates(\?|$)/);
  await expect(page.getByText(title)).toBeVisible();

  const [t] = await sql<{ body: string }>("select body from templates where title=$1", [title]);
  expect(t.body).toContain("{{field:national_id");
  expect(t.body).toContain("{{field:address");
  saveState({ templateTitle: title });
  await ctx.close();
});

test("[A2] دستیار هوش مصنوعی در ویرایشگر (پاسخ سرویس شبیه‌سازی می‌شود)", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  // سرویس AI بیرونی در آزمون خودکار فراخوانی نمی‌شود؛ مسیر API در مرورگر شبیه‌سازی می‌شود
  await page.route("**/api/ai/contract", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = JSON.parse(route.request().postData() ?? "{}") as { prompt?: string };
    expect(body.prompt).toContain("خدمات");
    await route.fulfill({ json: { ok: true, html: "<h2>مفاد قرارداد هوش مصنوعی</h2><p>طرفین متعهد به انجام تعهدات خود طبق این سند هستند و هرگونه اختلاف از راه مذاکره حل می‌شود.</p>", remaining: 39 } });
  });
  await page.goto("/admin/templates/new");
  await page.getByRole("button", { name: /نوشتن با هوش مصنوعی/ }).click();
  const dialog = page.getByRole("dialog", { name: "دستیار هوش مصنوعی" });
  await expect(dialog).toBeVisible();
  await dialog.locator("#ai-prompt").fill("قرارداد خدمات مشاوره‌ی یک ساله با پرداخت ماهانه");
  await dialog.getByRole("button", { name: "تولید متن" }).click();
  await expect(dialog.getByText("مفاد قرارداد هوش مصنوعی")).toBeVisible();
  await dialog.getByRole("button", { name: "جایگزینی متن ویرایشگر" }).click();
  await expect(page.locator("[contenteditable=true]").first()).toContainText("مفاد قرارداد هوش مصنوعی");

  const title = `قالب هوشمند ${readState().stamp}`;
  await page.locator("input[name=title]").fill(title);
  await page.getByRole("button", { name: "ذخیره قالب" }).click();
  await expect(page.getByText(title)).toBeVisible();
  await ctx.close();
});
