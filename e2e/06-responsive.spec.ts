/**
 * [C2] بازبینی ریسپانسیو: همه‌ی صفحه‌های عمومی، مدیر و کاربر در سه اندازه‌ی نمایش (موبایل ۳۶۰، تبلت ۷۶۸، دسکتاپ ۱۴۴۰)
 * معیارها: بدون اسکرول افقی، بدون عنصر بیرون‌زده از لبه، جهت RTL و زبان فارسی، بدون استثنای JS یا خطای ۵xx، دارای عنوان صفحه (h1)
 * از هر صفحه یک تصویر در e2e/report/screenshots/<دستگاه>/ ذخیره می‌شود تا با چشم هم بازبینی شود.
 */
import fs from "node:fs";
import path from "node:path";
import { AUTH, REPORT_DIR, expect, horizontalOverflow, newContext, readState, test, VIEWPORTS, type Device } from "./lib/kit";


type Target = { name: string; url: string; role: "public" | "admin" | "user"; h1?: boolean };

function targets(): Target[] {
  const s = readState();
  const id = s.contractId ?? 1;
  const hash = s.docHash ?? "0".repeat(64);
  return [
    { name: "home", url: "/", role: "public" },
    { name: "login", url: "/login", role: "public", h1: true },
    { name: "register", url: "/register", role: "public", h1: true },
    { name: "forgot", url: "/forgot", role: "public", h1: true },
    { name: "pricing", url: "/pricing", role: "public", h1: true },
    { name: "verify", url: "/verify", role: "public" },
    { name: "verify-hash", url: `/verify/${hash}`, role: "public" },
    { name: "sign-invalid", url: "/sign/invalid-token-for-layout-check", role: "public" },
    { name: "not-found", url: "/this-page-does-not-exist", role: "public" },
    { name: "admin-dashboard", url: "/admin", role: "admin", h1: true },
    { name: "admin-new", url: "/admin/new", role: "admin" },
    { name: "admin-templates", url: "/admin/templates", role: "admin", h1: true },
    { name: "admin-template-edit", url: "/admin/templates/new", role: "admin" },
    { name: "admin-customers", url: "/admin/customers", role: "admin" },
    { name: "admin-settings", url: "/admin/settings", role: "admin", h1: true },
    { name: "admin-branding", url: "/admin/branding", role: "admin", h1: true },
    { name: "admin-automation", url: "/admin/automation", role: "admin" },
    { name: "admin-billing", url: "/admin/billing", role: "admin", h1: true },
    { name: "admin-logs", url: "/admin/logs", role: "admin", h1: true },
    { name: "admin-insights", url: "/admin/insights", role: "admin" },
    { name: "admin-risk", url: "/admin/risk", role: "admin" },
    { name: "admin-renewals", url: "/admin/renewals", role: "admin" },
    { name: "admin-reports", url: "/admin/reports", role: "admin" },
    { name: "admin-team", url: "/admin/team", role: "admin" },
    { name: "admin-webhooks", url: "/admin/webhooks", role: "admin" },
    { name: "admin-api", url: "/admin/api", role: "admin" },
    { name: "admin-products", url: "/admin/products", role: "admin" },
    { name: "admin-wordpress", url: "/admin/wordpress", role: "admin" },
    { name: "admin-landing", url: "/admin/landing", role: "admin" },
    { name: "contract", url: `/contracts/${id}`, role: "admin" },
    { name: "contract-print", url: `/contracts/${id}/print`, role: "admin" },
    { name: "platform", url: "/platform", role: "admin", h1: true },
    { name: "platform-tickets", url: "/platform/tickets", role: "admin", h1: true },
    { name: "notifications", url: "/notifications", role: "admin", h1: true },
    { name: "account", url: "/account", role: "admin", h1: true },
    { name: "user-dashboard", url: "/dashboard", role: "user", h1: true },
    { name: "user-contract", url: `/contracts/${id}`, role: "user" },
    { name: "user-support", url: "/support", role: "user", h1: true },
    { name: "user-support-new", url: "/support/new", role: "user", h1: true },
    { name: "user-notifications", url: "/notifications", role: "user", h1: true },
    { name: "user-account", url: "/account", role: "user", h1: true },
  ];
}

for (const device of ["mobile", "tablet", "desktop"] as Device[]) {
  test(`[C2] ریسپانسیو — ${device} (${VIEWPORTS[device].width}px): همه‌ی صفحه‌ها`, async ({ browser }) => {
    test.setTimeout(600_000);
    const shots = path.join(REPORT_DIR, "screenshots", device);
    fs.mkdirSync(shots, { recursive: true });
    const ctxs = {
      public: await newContext(browser, { device }),
      admin: await newContext(browser, { device, auth: AUTH.admin }),
      user: await newContext(browser, { device, auth: AUTH.user }),
    };
    const pages = { public: await ctxs.public.newPage(), admin: await ctxs.admin.newPage(), user: await ctxs.user.newPage() };

    for (const t of targets()) {
      const page = pages[t.role];
      const res = await page.goto(t.url, { waitUntil: "load" });
      await page.waitForTimeout(250);
      const where = `${device} ${t.url}`;
      if (t.name !== "not-found" && t.name !== "sign-invalid") expect.soft(res?.status() ?? 0, `${where}: وضعیت HTTP`).toBeLessThan(400);
      if (t.role !== "public") expect.soft(page.url(), `${where}: به صفحه‌ی ورود پرتاب نشود`).not.toMatch(/\/login(\?|$)/);

      const html = await page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir || getComputedStyle(document.documentElement).direction, viewport: !!document.querySelector('meta[name="viewport"]') }));
      expect.soft(html.lang, `${where}: lang`).toMatch(/^fa/);
      expect.soft(html.dir, `${where}: dir`).toBe("rtl");
      expect.soft(html.viewport, `${where}: meta viewport`).toBe(true);

      const ov = await horizontalOverflow(page);
      expect.soft(ov.overflow, `${where}: اسکرول افقی ${ov.overflow}px — ${ov.offenders.join(" | ")}`).toBeLessThanOrEqual(1);
      if (t.h1) expect.soft(await page.locator("h1").count(), `${where}: h1`).toBeGreaterThan(0);

      await page.screenshot({ path: path.join(shots, `${t.name}.png`) });
    }

    // منوی ناوبری در موبایل/تبلت باز می‌شود و خودش سرریز ندارد
    if (device !== "desktop") {
      const page = pages.admin;
      await page.goto("/admin");
      const menu = page.getByRole("button", { name: /منو|ناوبری|باز کردن/ }).first();
      if (await menu.count()) {
        await menu.click();
        await page.waitForTimeout(300);
        const ov = await horizontalOverflow(page);
        expect.soft(ov.overflow, `${device}: سرریز با منوی باز — ${ov.offenders.join(" | ")}`).toBeLessThanOrEqual(1);
        await page.screenshot({ path: path.join(shots, "admin-menu-open.png") });
      }
    }

    // اهداف لمسی کوچک در موبایل (هشدار — در گزارش ثبت می‌شود)
    if (device === "mobile") {
      const page = pages.admin;
      await page.goto("/admin/settings");
      const tiny = await page.evaluate(() =>
        Array.from(document.querySelectorAll("button, a[href], input:not([type=hidden]), select")).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.height < 28 || r.width < 28) && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only");
        }).length,
      );
      test.info().annotations.push({ type: "tap-targets", description: `${tiny} کنترل کوچک‌تر از ۲۸px در /admin/settings` });
    }
    for (const c of Object.values(ctxs)) await c.close();
  });
}
