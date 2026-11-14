/**
 * ۷) تست دود (Smoke) — سریع‌ترین پاسخ به «آیا محصول زنده و سالم است؟»
 * مسیرهای حیاتی: سلامت، صفحه‌های عمومی، ورود واقعی، پنل مدیر/کاربر، لینک امضا، API، دارایی‌های ثابت.
 * (فقط خواندنی به‌جز یک ورود/خروج؛ روی هر سرور آماده قابل اجراست.)
 */
import { AUTH, BASE, expect, newApi, newPage, test } from "../lib/kit";
import { ADMIN } from "../lib/env";
import { PAGES, resolvePath } from "../routes";
import { readState, type QaState } from "../lib/state";

const state = () => readState() as QaState;

test.describe("سلامت و دارایی‌های ثابت", () => {
  test("[S1] /api/health سالم است و دیتابیس جواب می‌دهد", async () => {
    const api = await newApi();
    const r = await api.get("/api/health");
    expect(r.status()).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("[S2] manifest، آیکون‌های PWA، سرویس‌ورکر، robots و sitemap در دسترس‌اند", async () => {
    const api = await newApi();
    const manifest = await api.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    const m = (await manifest.json()) as { icons: { src: string }[]; start_url: string };
    expect(m.start_url).toBeTruthy();
    for (const icon of m.icons) {
      const r = await api.get(icon.src);
      expect(r.status(), `آیکون ${icon.src}`).toBe(200);
      expect(r.headers()["content-type"]).toContain("image/png");
    }
    for (const p of ["/icons/apple-touch-icon.png", "/offline.html", "/robots.txt", "/sitemap.xml"]) expect((await api.get(p)).status(), p).toBe(200);
    const sw = await api.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(sw.headers()["content-type"]).toContain("javascript");
    expect(sw.headers()["cache-control"]).toContain("no-cache");
  });

  test("[S3] مسیر ناموجود ۴۰۴ می‌دهد (نه ۲۰۰ و نه ۵۰۰)", async () => {
    const api = await newApi();
    expect((await api.get("/this-route-does-not-exist")).status()).toBe(404);
  });
});

test.describe("صفحه‌های حیاتی", () => {
  for (const def of PAGES.filter((p) => p.critical)) {
    test(`[S4] ${def.name}: باز می‌شود، محتوا دارد و خطای جاوااسکریپت ندارد`, async ({ browser }) => {
      const { ctx, page } = await newPage(browser, { auth: def.auth === "none" ? undefined : AUTH[def.auth] });
      const res = await page.goto(resolvePath(def, state()));
      expect(res?.status(), "کد پاسخ").toBeLessThan(400);
      expect(page.url(), "نباید به نصب‌کننده هدایت شود").not.toMatch(/\/install(\?|$)/);
      if (def.auth !== "none") expect(page.url(), "نشست معتبر نباید به ورود هدایت شود").not.toMatch(/\/login(\?|$)/);
      await expect(page.locator("main, [role=main], body").first()).toBeVisible();
      expect((await page.locator("h1, h2").count()), "حداقل یک تیتر").toBeGreaterThan(0);
      await ctx.close();
    });
  }
});

test.describe("دسترسی", () => {
  test("[S5] صفحه‌های محافظت‌شده بدون ورود به /login می‌روند", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    for (const p of ["/dashboard", "/admin", "/account", `/contracts/${state().contractId}`, "/platform"]) {
      await page.goto(p);
      await expect(page, p).toHaveURL(/\/login/);
    }
    await ctx.close();
  });

  test("[S6] APIهای محافظت‌شده بدون ورود/کلید ۴۰۱ یا ۴۰۳ می‌دهند", async () => {
    const api = await newApi();
    for (const p of ["/api/v1/stats", "/api/v1/contracts", "/api/notifications", "/api/account/export", `/api/contracts/${state().contractId}/pdf`]) {
      expect([401, 403], p).toContain((await api.get(p)).status());
    }
  });

  test("[S7] API با کلید معتبر کار می‌کند", async () => {
    const api = await newApi({ headers: { Authorization: `Bearer ${state().apiKey}` } });
    const r = await api.get("/api/v1/stats");
    expect(r.status()).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });
});

test.describe("مسیر حیاتی کاربر", () => {
  test("[S8] ورود واقعی مدیر ← داشبورد ← خروج", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await page.goto("/login");
    await page.locator("#email").fill(ADMIN.email);
    await page.locator("#password").fill(ADMIN.password);
    await page.getByRole("button", { name: "ورود", exact: true }).click();
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByRole("heading", { name: "قراردادهای صادر شده" })).toBeVisible();
    await page.getByRole("button", { name: "خروج از حساب" }).click();
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();
  });

  test("[S9] لینک امضای معتبر باز می‌شود و لینک نامعتبر صفحه‌ی خطای کنترل‌شده دارد", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    const ok = await page.goto(`/sign/${state().signToken}`);
    expect(ok?.status()).toBe(200);
    expect(ok?.headers()["cache-control"]).toContain("no-store");
    expect(ok?.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.locator("body")).not.toContainText("نامعتبر");
    await page.goto(`/sign/${"a".repeat(43)}`);
    await expect(page.locator("body")).toContainText("نامعتبر");
    await ctx.close();
  });

  test("[S10] لینک کوتاه قرارداد هدایت می‌شود و استعلام اصالت هش ناموجود خطا نمی‌دهد", async () => {
    const api = await newApi();
    const r = await api.get(`/s/${state().shortCode}`, { maxRedirects: 0 });
    expect([200, 302, 303, 307, 308]).toContain(r.status());
    expect((await api.get(`/verify/${"0".repeat(64)}`)).status()).toBe(200);
  });
});

test("[S11] پایه‌ی آزمون: آدرس هدف", () => {
  expect(BASE).toMatch(/^https?:\/\//);
});
