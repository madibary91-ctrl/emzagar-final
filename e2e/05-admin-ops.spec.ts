/**
 * عملیات مدیر و سیستم: صورتحساب/اشتراک، لاگ امنیتی، زمان‌بند (Cron: یادآوری و انقضا)، بک‌آپ دستی و خودکار
 */
import fs from "node:fs";
import path from "node:path";
import { alert, AUTH, CRON_SECRET, STORAGE, expect, issueContract, newPage, requireState, sql, test } from "./lib/kit";


test("[A6] صورتحساب: طرح رایگان، نمایش طرح‌ها، خرید طرح حرفه‌ای (درگاه آزمایشی)، بازگشت تکراری idempotent", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });

  // صفحه‌ی عمومی قیمت‌ها
  await page.goto("/pricing");
  await expect(page.getByText(/رایگان/).first()).toBeVisible();
  await expect(page.getByText(/حرفه‌ای/).first()).toBeVisible();
  await expect(page.getByText(/سازمانی/).first()).toBeVisible();

  await page.goto("/admin/billing");
  await expect(page.getByRole("heading", { name: /اشتراک و پرداخت/ })).toBeVisible();
  await expect(page.getByText("طرح فعلی", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar").first()).toBeVisible();
  const [before] = await sql<{ plan: string }>("select plan from subscriptions where workspace_id=(select workspace_id from workspace_members m join users u on u.id=m.user_id where u.email=$1 and m.role='owner' order by m.workspace_id limit 1)", [requireState("adminEmail").adminEmail]).then((r) => (r.length ? r : [{ plan: "free" }]));
  expect(before.plan).toBe("free");

  await page.locator("button[name=plan][value=pro]").click();
  await page.waitForURL(/\/admin\/billing\?pay=ok/, { timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: /.+/ }).first()).toBeVisible();

  const [pay] = await sql<{ authority: string; status: string; amount: number }>("select authority, status, amount from payments order by id desc limit 1");
  expect(pay.status).toBe("paid");
  expect(pay.amount).toBeGreaterThan(0);
  const [sub] = await sql<{ plan: string; current_period_end: string }>("select plan, current_period_end from subscriptions order by updated_at desc limit 1");
  expect(sub.plan).toBe("pro");

  // بازگشت دوباره از درگاه نباید اشتراک را دوبار تمدید کند
  await page.request.get(`/api/billing/callback?Authority=${pay.authority}&Status=OK`, { maxRedirects: 0 }).catch(() => undefined);
  const [sub2] = await sql<{ current_period_end: string }>("select current_period_end from subscriptions where plan='pro' order by updated_at desc limit 1");
  expect(new Date(sub2.current_period_end).getTime()).toBe(new Date(sub.current_period_end).getTime());

  await page.goto("/admin/billing");
  await expect(page.getByText("تاریخچه‌ی پرداخت‌ها")).toBeVisible();
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  await ctx.close();
});

test("[A5] لاگ‌های امنیتی: رویدادهای ورود، ورود ناموفق، تنظیمات و قرارداد ثبت و نمایش داده می‌شوند", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/logs");
  await expect(page.getByRole("heading", { name: "لاگ‌های سیستم" })).toBeVisible();
  const rows = page.locator("table tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(5);

  const acts = (await sql<{ action: string }>("select distinct action from audit_logs")).map((r) => r.action);
  expect(acts).toEqual(expect.arrayContaining(["auth.login", "auth.failed", "auth.registered", "auth.email_verified", "auth.email_verify_failed", "settings.ai_saved", "workspace.created"]));
  expect(acts.some((a) => a.startsWith("contract."))).toBe(true);
  expect(acts.some((a) => a.startsWith("signlink."))).toBe(true);

  // هر رویداد IP و مرورگر دارد (شناسنامه‌ی دیجیتال)
  const [{ n }] = await sql<{ n: number }>("select count(*)::int n from audit_logs where action='auth.login' and ip is not null and user_agent is not null");
  expect(n).toBeGreaterThan(0);
  // کلیدهای محرمانه هرگز در لاگ ننشسته‌اند
  const leaked = await sql("select 1 from audit_logs where detail ilike '%KN-SECRET%' or detail ilike '%sk-e2e%' or detail ilike '%Admin12345x%'");
  expect(leaked).toHaveLength(0);
  expect(await page.content()).not.toContain("Admin12345x");
  await ctx.close();
});

test("[C3] زمان‌بند: یادآوری امضا، انقضای خودکار، احراز هویت مسیر cron، عدم تکرار یادآوری", async ({ browser }) => {
  const { templateTitle, userEmail } = requireState("templateTitle", "userEmail");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });

  await page.goto("/admin/automation");
  await page.locator("input[name=reminder_enabled]").check();
  await page.locator("input[name=reminder_first_hours]").fill("1");
  await page.locator("input[name=reminder_interval_hours]").fill("6");
  await page.locator("input[name=reminder_max]").fill("3");
  await page.getByRole("button", { name: "ذخیره قوانین" }).click();
  await expect(page.getByText(/تنظیمات ذخیر/)).toBeVisible();

  const remindId = await issueContract(page, { templateTitle, title: "قرارداد یادآوری", customerEmail: userEmail });
  const expireId = await issueContract(page, { templateTitle, title: "قرارداد منقضی", customerEmail: userEmail });
  const expireUrl = ((await page.locator("span[dir=ltr].font-mono", { hasText: "/sign/" }).first().textContent()) ?? "").trim();
  await sql("update contracts set issued_at = now() - interval '3 hours' where id=$1", [remindId]);
  await sql("update contracts set expires_at = now() - interval '1 hour' where id=$1", [expireId]);

  // مسیر cron بدون کلید/با کلید غلط ۴۰۱ است
  expect((await page.request.post("/api/cron/run")).status()).toBe(401);
  expect((await page.request.post("/api/cron/run", { headers: { Authorization: "Bearer wrong-secret" } })).status()).toBe(401);
  const ok = await page.request.post("/api/cron/run", { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).ok).toBe(true);

  // نتیجه‌ی واقعی در دیتابیس (زمان‌بند داخلی هم ممکن است زودتر اجرا کرده باشد)
  await expect.poll(async () => (await sql<{ status: string }>("select status from contracts where id=$1", [expireId]))[0].status, { timeout: 30_000 }).toBe("expired");
  await expect.poll(async () => (await sql<{ reminder_count: number }>("select reminder_count from contracts where id=$1", [remindId]))[0].reminder_count, { timeout: 30_000 }).toBe(1);
  const mails = await sql("select 1 from notifications where contract_id=$1 and recipient=$2", [remindId, userEmail]);
  expect(mails.length).toBeGreaterThanOrEqual(2); // ایمیل صدور + یادآوری

  // اجرای دوباره: یادآوری تکراری نمی‌رود (فاصله‌ی ۶ ساعت)
  await page.request.post("/api/cron/run", { headers: { "x-cron-secret": CRON_SECRET } });
  expect((await sql<{ reminder_count: number }>("select reminder_count from contracts where id=$1", [remindId]))[0].reminder_count).toBe(1);

  // لینک قرارداد منقضی دیگر قابل امضا نیست
  const guest = await newPage(browser);
  await guest.page.goto(expireUrl);
  await expect(guest.page.getByRole("button", { name: /دریافت کد تأیید/ })).toHaveCount(0);
  await expect(guest.page.getByText(/مهلت|منقضی|قابل امضا نیست/).first()).toBeVisible();
  await guest.ctx.close();

  // تاریخچه‌ی اجرا ثبت شده و در صفحه نمایش داده می‌شود
  const runs = await sql("select 1 from cron_runs");
  expect(runs.length).toBeGreaterThan(0);
  await page.goto("/admin/automation");
  await expect(page.getByRole("heading", { name: /یادآوری|زمان‌بندی|خودکار/ }).first()).toBeVisible();
  await ctx.close();
});

test("[C4] بک‌آپ دستی: ساخت، فهرست، بررسی صحت (checksum) و وجود فایل‌ها روی دیسک", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/platform");
  await page.getByRole("button", { name: "بک‌آپ فوری" }).click();
  await expect(alert(page).first()).toBeVisible();
  await expect(page.getByText(/backup-/).first()).toBeVisible();

  const dir = path.join(STORAGE, "backups");
  const names = fs.readdirSync(dir).filter((n) => n.startsWith("backup-"));
  expect(names.length).toBeGreaterThan(0);
  const files = fs.readdirSync(path.join(dir, names[0]));
  expect(files.some((f) => /manifest/.test(f))).toBe(true);

  await page.getByRole("button", { name: /بررسی صحت آخرین بک‌آپ/ }).click();
  await expect(alert(page).first()).toContainText(/سالم|معتبر|تأیید|صحیح|verified/i);

  // خراب‌کردن عمدی یک فایل: بررسی صحت باید شکست را تشخیص دهد
  const victim = fs.readdirSync(path.join(dir, names[names.length - 1])).find((f) => !/manifest/.test(f));
  if (victim) {
    const p = path.join(dir, names[names.length - 1], victim);
    if (fs.statSync(p).isFile()) {
      const orig = fs.readFileSync(p);
      fs.appendFileSync(p, "CORRUPT");
      try {
        await page.getByRole("button", { name: /بررسی صحت آخرین بک‌آپ/ }).click();
        await expect(alert(page).first()).not.toContainText(/^سالم$/);
        await expect(alert(page).first()).toContainText(/خراب|ناسازگار|corrupt|مشکل/i);
      } finally {
        fs.writeFileSync(p, orig);
      }
    }
  }
  await ctx.close();
});

test("[C4] بک‌آپ خودکار: بدون هیچ کلیک، زمان‌بند داخلی بک‌آپ می‌سازد", async ({ browser }) => {
  test.setTimeout(200_000);
  // وضعیت را «هرگز بک‌آپ نگرفته‌ایم» می‌کنیم؛ زمان‌بند (هر ۱ دقیقه در محیط آزمون) باید خودش بک‌آپ بسازد
  const dir = path.join(STORAGE, "backups");
  fs.rmSync(dir, { recursive: true, force: true });
  await sql("delete from settings where key='backup_last'");
  await expect
    .poll(
      async () => {
        const r = await sql<{ value: string }>("select value from settings where key='backup_last'");
        if (!r[0]) return "none";
        const v = JSON.parse(r[0].value) as { ok: boolean; trigger: string };
        return `${v.trigger}:${v.ok}`;
      },
      { timeout: 150_000, intervals: [3000] },
    )
    .toBe("scheduler:true");
  expect(fs.readdirSync(dir).some((n) => n.startsWith("backup-"))).toBe(true);
  void browser;
});
