/**
 * بخش هشتم — واکنش «رابط کاربری واقعی» به اتفاقات سرویس‌های بیرونی (با شبیه‌ساز، بدون اینترنت و هزینه)
 *   [S1] پرداخت (زرین‌پال): قطعی، انصراف، حمله‌ی Status=OK جعلی، قطعی هنگام تایید + بازیابی خودکار
 *   [S2] هوش مصنوعی (GapGPT): محدودیت نرخ، خروجی مخرب XSS (بدون mock مرورگر)، موفقیت
 * این آزمون‌ها فقط وقتی اجرا می‌شوند که E2E_SIM_URL تنظیم شده باشد (scripts/e2e.ts خودکار انجامش می‌دهد).
 */
import { alert, allowServerErrors, AUTH, CRON_SECRET, expect, newPage, sql, test } from "./lib/kit";
import { needSim, sim } from "./lib/sim";

test.describe.configure({ mode: "serial" });
test.skip(!sim, "شبیه‌ساز فعال نیست (E2E_SIM_URL)");

test.beforeEach(async () => {
  const s = needSim();
  await s.reset();
  await s.settings({ startPay: "auto" });
});
test.afterAll(async () => {
  await sim?.reset();
});

test("[S1] پرداخت: قطعی درگاه، انصراف، OK جعلی بدون پرداخت و قطعی هنگام تایید با بازیابی خودکار", async ({ browser }) => {
  const s = needSim();
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  const paymentCount = async () => (await sql<{ n: number }>("select count(*)::int as n from payments"))[0].n;
  const lastPayment = async () => (await sql<{ status: string; error: string | null }>("select status, error from payments order by id desc limit 1"))[0];
  const planNow = async () => (await sql<{ plan: string }>("select plan from subscriptions order by updated_at desc limit 1"))[0]?.plan;
  const buy = async () => {
    await page.goto("/admin/billing");
    await page.locator("button[name=plan][value=business]").click();
  };
  const planBefore = await (async () => {
    await page.goto("/admin/billing");
    return planNow();
  })();

  // ۱) قطعی کامل درگاه: پیام فارسی، هیچ تراکنشی ثبت نمی‌شود، اشتراک تغییر نمی‌کند
  await s.scenario("zarinpal", "service_down");
  const n0 = await paymentCount();
  await buy();
  await expect(alert(page).first()).toContainText("درگاه پرداخت پاسخ نداد");
  expect(await paymentCount()).toBe(n0);

  // ۲) انصراف کاربر در صفحه‌ی بانک
  await s.scenario("zarinpal", "user_cancel");
  await buy();
  await page.waitForURL(/\/admin\/billing\?pay=error/);
  await expect(page.getByText(/لغو|ناموفق/).first()).toBeVisible();
  expect((await lastPayment()).status).toBe("failed");

  // ۳) حمله: بازگشت با Status=OK بدون پرداخت واقعی ← verify رد می‌شود
  await s.scenario("zarinpal", "fake_ok_unpaid");
  await buy();
  await page.waitForURL(/\/admin\/billing\?pay=error/);
  expect((await lastPayment()).status).toBe("failed");
  expect(await planNow()).toBe(planBefore);

  // ۴) پرداخت واقعاً انجام شد ولی درگاه هنگام تایید قطع بود ← نه «ناموفق»، بلکه «در حال بررسی»
  await s.scenario("zarinpal", "success");
  await s.queue("zarinpal", ["success", "verify@service_down"]);
  await buy();
  await page.waitForURL(/\/admin\/billing\?pay=error/);
  await expect(page.getByText(/در حال بررسی/).first()).toBeVisible();
  const pending = await lastPayment();
  expect(pending.status).toBe("pending");
  expect(pending.error).toContain("verify_pending");
  expect(await planNow()).toBe(planBefore);

  // ۵) درگاه برگشت؛ کرون/زمان‌بند تراکنش معلق را تایید و اشتراک را فعال می‌کند
  const cron = await page.request.post("/api/cron/run", { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  expect(cron.ok()).toBeTruthy();
  await expect.poll(async () => (await lastPayment()).status, { timeout: 15_000 }).toBe("paid");
  expect(await planNow()).toBe("business");

  // ردپای شبیه‌ساز: verify دو بار صدا زده شد (یک بار شکست، یک بار موفق)
  const verifies = await s.requests({ service: "zarinpal", phase: "verify" });
  expect(verifies.some((v) => v.status === 503)).toBe(true);
  expect(verifies.some((v) => v.status === 200)).toBe(true);
  await ctx.close();
});

test("[S2] هوش مصنوعی: محدودیت نرخ، خروجی مخرب (XSS) و موفقیت — بدون mock در مرورگر", async ({ browser }) => {
  const s = needSim();
  allowServerErrors.value = true; // مسیر /api/ai/contract در خطای سرویس عمداً 502 می‌دهد
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  const popups: string[] = [];
  page.on("dialog", (d) => {
    popups.push(d.message());
    void d.dismiss();
  });

  await page.goto("/admin/templates/new");
  await page.getByRole("button", { name: /نوشتن با هوش مصنوعی/ }).click();
  const dialog = page.getByRole("dialog", { name: "دستیار هوش مصنوعی" });
  await expect(dialog).toBeVisible();
  await dialog.locator("#ai-prompt").fill("قرارداد خدمات پشتیبانی نرم‌افزار با پرداخت ماهانه");
  const generate = () => dialog.getByRole("button", { name: /تولید (متن|دوباره)/ }).click();

  // ۱) محدودیت نرخ سرویس ← پیام فارسی، بدون نتیجه
  await s.scenario("gapgpt", "rate_limit");
  await generate();
  await expect(dialog.getByRole("alert")).toContainText("محدودیت نرخ");

  // ۲) قطع اتصال
  await s.scenario("gapgpt", "network_error");
  await generate();
  await expect(dialog.getByRole("alert")).toContainText("ارتباط با سرویس هوش مصنوعی برقرار نشد");

  // ۳) خروجی مخرب مدل: باید پاک‌سازی شود (نتیجه با dangerouslySetInnerHTML نمایش داده می‌شود!)
  await s.scenario("gapgpt", "xss_payload");
  await generate();
  await expect(dialog.getByText("قرارداد آزمایشی امنیت")).toBeVisible();
  const html = await dialog.locator(".contract-body").innerHTML();
  expect(html).not.toMatch(/<script|onerror|onclick|javascript:|<iframe|<style/i);
  await page.waitForTimeout(300);
  expect(popups, "هیچ کدی از خروجی مدل نباید در مرورگر اجرا شود").toEqual([]);

  // ۴) موفقیت و درج در ویرایشگر
  await s.scenario("gapgpt", "success");
  await generate();
  await expect(dialog.getByText("ماده ۱").first()).toBeVisible();
  await dialog.getByRole("button", { name: "جایگزینی متن ویرایشگر" }).click();
  await expect(page.locator("[contenteditable=true]").first()).toContainText("ماده ۱");

  // خطاها سهمیه‌ی AI را مصرف نکرده‌اند: فقط ۲ تولید موفق (XSS پاک‌سازی‌شده + موفقیت)
  const gens = await sql<{ status: string }>("select status from ai_generations where prompt like 'قرارداد خدمات پشتیبانی%'");
  expect(gens.filter((g) => g.status === "ok")).toHaveLength(2);
  expect(gens.filter((g) => g.status === "failed")).toHaveLength(2);
  await ctx.close();
});
