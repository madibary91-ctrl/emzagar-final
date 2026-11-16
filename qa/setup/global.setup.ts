/**
 * مرحله‌ی آماده‌سازی (یک‌بار پیش از همه‌ی لایه‌ها): مثل یک مشتری واقعی روی دیتابیس «خالی»
 *   نصب‌کننده‌ی وب ← ثبت‌نام کاربر ← کلید API ← صدور قرارداد (+ پیش‌نویس) ← تیکت ← داده‌ی نمونه
 * خروجی: qa/.state/state.json و نشست‌های ذخیره‌شده‌ی مدیر و کاربر.
 */
import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";
import { ADMIN, AUTH, BASE, STATE_DIR, USER } from "../lib/env";
import { newPage, readDevCode, sql } from "../lib/kit";
import { saveState } from "../lib/state";

setup.setTimeout(240_000);

const wizardField = (page: import("@playwright/test").Page, label: string) =>
  page.locator(`xpath=//label[normalize-space()="${label}"]/following-sibling::*[1]/descendant-or-self::input[1]`);

setup("نصب، ثبت‌نام و داده‌ی پایه", async ({ browser }) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  /* ۱) نصب‌کننده‌ی وب */
  {
    const { ctx, page } = await newPage(browser);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/install/);
    await page.getByRole("button", { name: /شروع نصب/ }).click();
    await wizardField(page, "نام سایت یا کسب‌وکار").fill(ADMIN.workspace);
    await wizardField(page, "نام و نام‌خانوادگی شما").fill(ADMIN.name);
    await wizardField(page, "ایمیل").fill(ADMIN.email);
    await wizardField(page, "موبایل").fill(ADMIN.mobile);
    await wizardField(page, "رمز عبور").fill(ADMIN.password);
    await wizardField(page, "تکرار رمز عبور").fill(ADMIN.password);
    await page.getByRole("button", { name: /نصب را شروع کن/ }).click();
    await expect(page.getByText("نصب با موفقیت انجام شد")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("link", { name: /ورود به پنل مدیریت/ }).click();
    await expect(page).toHaveURL(/\/admin/);
    await ctx.storageState({ path: AUTH.admin });
    await ctx.close();
  }

  /* ۲) ثبت‌نام کاربر عادی (با کد آزمایشی ایمیل) */
  {
    const { ctx, page } = await newPage(browser);
    await page.goto("/register");
    await page.getByLabel("نام کسب‌وکار / فروشگاه").fill(USER.workspace);
    await page.getByLabel("نام و نام خانوادگی شما").fill(USER.name);
    await page.getByLabel("ایمیل", { exact: true }).fill(USER.email);
    await page.getByLabel("موبایل").fill(USER.mobile);
    await page.getByLabel("رمز عبور").fill(USER.password);
    await page.getByRole("button", { name: "ساخت فضای کاری" }).click();
    await page.waitForURL(/\/verify-email/);
    await page.locator("#code").fill(await readDevCode(page));
    await page.getByRole("button", { name: "تأیید ایمیل و ورود" }).click();
    await page.waitForURL((u) => !/\/verify-email/.test(u.pathname));
    await ctx.storageState({ path: AUTH.user });
    await ctx.close();
  }

  /* ۳) کلید API از پنل */
  let apiKey = "";
  {
    const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
    await page.goto("/admin/api");
    await page.getByPlaceholder(/نام کلید/).fill("کلید آزمون کیفیت");
    await page.getByRole("button", { name: "ساخت کلید" }).click();
    const code = page.getByRole("status").locator("code");
    await expect(code).toBeVisible();
    apiKey = ((await code.textContent()) ?? "").trim();
    expect(apiKey).toMatch(/^emz_[a-f0-9]{48}$/);
    await ctx.close();
  }

  /* ۴) قرارداد و پیش‌نویس از طریق API (همان مسیر افزونه‌ی وردپرس) */
  const hdr = { Authorization: `Bearer ${apiKey}`, "x-forwarded-for": "10.250.0.1" };
  const tpl = await fetch(`${BASE}/api/v1/templates`, { headers: hdr }).then((r) => r.json() as Promise<{ items?: { id: number }[]; templates?: { id: number }[] }>);
  const templateId = (tpl.items ?? tpl.templates ?? [])[0]?.id;
  expect(templateId, "حداقل یک قالب نمونه باید پس از نصب وجود داشته باشد").toBeTruthy();
  const issue = async (draft: boolean) => {
    const r = await fetch(`${BASE}/api/v1/contracts`, {
      method: "POST",
      headers: { ...hdr, "content-type": "application/json" },
      body: JSON.stringify({ templateId, draft, customer: { name: USER.name, email: USER.email, mobile: USER.mobile } }),
    });
    expect(r.status).toBe(201);
    return (await r.json()) as { id: number; signUrl: string | null; shortUrl: string | null };
  };
  const issued = await issue(false);
  const draft = await issue(true);
  const signToken = /\/sign\/([A-Za-z0-9_-]+)/.exec(issued.signUrl ?? "")?.[1] ?? "";
  expect(signToken.length).toBeGreaterThan(20);
  // وقتی لینک امضای اختصاصی هست، API همان را برمی‌گرداند؛ کد لینک کوتاه از دیتابیس خوانده می‌شود
  const [sl] = await sql<{ code: string }>("select code from short_links where contract_id=$1 limit 1", [issued.id]);
  const shortCode = sl?.code ?? "";
  expect(shortCode, "لینک کوتاه قرارداد باید ساخته شده باشد").not.toBe("");

  /* ۵) تیکت پشتیبانی توسط کاربر */
  let ticketId = 0;
  {
    const { ctx, page } = await newPage(browser, { auth: AUTH.user });
    await page.goto("/support/new");
    await page.locator("#subject").fill("تیکت نمونه‌ی آزمون کیفیت");
    await page.locator("#body").fill("این یک تیکت خودکار برای آزمون‌های کیفیت است و نیازی به پاسخ ندارد.");
    await page.getByRole("button", { name: "ثبت تیکت" }).click();
    await page.waitForURL(/\/support\/\d+/);
    ticketId = Number(/\/support\/(\d+)/.exec(page.url())?.[1]);
    await ctx.close();
  }

  /* ۶) داده‌ی نمونه (جدول‌ها و نمودارها پر باشند) */
  {
    const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
    await page.goto("/admin/demo");
    await page.getByTestId("demo-seed").click();
    await expect(page.getByRole("status").filter({ hasText: "داده‌های نمونه ساخته شد" })).toBeVisible({ timeout: 60_000 });
    await ctx.close();
  }

  const [u] = await sql<{ id: number }>("select id from users where email=$1", [USER.email]);
  const [a] = await sql<{ id: number }>("select id from users where email=$1", [ADMIN.email]);
  const [c] = await sql<{ workspace_id: number }>("select workspace_id from contracts where id=$1", [issued.id]);
  saveState({
    ready: true,
    apiKey,
    templateId,
    contractId: issued.id,
    draftContractId: draft.id,
    signToken,
    signUrl: issued.signUrl ?? "",
    shortCode,
    ticketId,
    userId: u.id,
    adminId: a.id,
    workspaceId: c.workspace_id,
  });
});
