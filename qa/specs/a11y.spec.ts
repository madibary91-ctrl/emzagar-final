/**
 * ۱) تست دسترس‌پذیری (Accessibility) — axe-core با قواعد WCAG 2.0/2.1/2.2 سطح A و AA
 *  - همه‌ی صفحه‌های qa/routes.ts (عمومی، کاربر، مدیر، پلتفرم) در دسکتاپ و حالت روشن
 *  - صفحه‌های حیاتی/بصری روی موبایل (۳۷۵px)
 *  - صفحه‌های کلیدی در تم تاریک
 * معیار: هر تخلف «جدی» یا «بحرانی» = شکست؛ تخلف‌های متوسط/جزئی در گزارش به‌عنوان هشدار ثبت می‌شوند.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { AUTH, expect, newPage, recordMetric, test, type Device } from "../lib/kit";
import { PAGES, resolvePath, type PageDef } from "../routes";
import { requireState } from "../lib/state";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** تمام بخش‌های صفحه (و iframeها) را یک‌بار پیمایش می‌کند تا انیمیشن‌های «ظاهرشدن هنگام اسکرول» تمام شوند؛
 *  وگرنه axe المانِ نیمه‌شفاف در میانه‌ی انیمیشن را اشتباهاً ضعیف‌کنتراست می‌بیند. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  for (const frame of page.frames()) {
    await frame
      .evaluate(async () => {
        const step = Math.max(300, window.innerHeight * 0.8);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      })
      .catch(() => undefined);
  }
  await page.waitForTimeout(700); // اسکلت بارگذاری و انیمیشن‌های ورودی تمام شود
}

async function scan(def: PageDef, device: Device, theme: "light" | "dark", browser: import("@playwright/test").Browser) {
  const s = requireState();
  const { ctx, page } = await newPage(browser, { auth: def.auth === "none" ? undefined : AUTH[def.auth], device, colorScheme: theme });
  const res = await page.goto(resolvePath(def, s));
  expect(res?.status(), "کد پاسخ").toBeLessThan(400);
  await settle(page);
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const hard = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const soft = result.violations.filter((v) => !(v.impact === "serious" || v.impact === "critical"));
  recordMetric("a11y", { page: def.name, device, theme, violations: result.violations.length, rules: result.violations.map((v) => `${v.id}(${v.impact})`).join(", ") || "—" });
  for (const v of soft) test.info().annotations.push({ type: "warning", description: `${def.name}/${device}/${theme}: ${v.id} (${v.impact}) × ${v.nodes.length} — ${v.help}` });
  await ctx.close();
  const msg = hard
    .map((v) => `• ${v.id} [${v.impact}] ${v.help}\n  ${v.helpUrl}\n` + v.nodes.slice(0, 4).map((n) => `    - ${n.target.join(" ")}\n      ${(n.failureSummary ?? "").replace(/\n/g, " ").slice(0, 220)}`).join("\n"))
    .join("\n");
  expect(hard, `تخلف دسترس‌پذیری در ${def.name} (${device}/${theme}):\n${msg}`).toHaveLength(0);
}

test.describe("دسکتاپ — حالت روشن", () => {
  for (const def of PAGES) test(`[A1] ${def.name}`, async ({ browser }) => scan(def, "desktop", "light", browser));
});

test.describe("موبایل", () => {
  for (const def of PAGES.filter((p) => p.critical || p.visual)) test(`[A2] ${def.name}`, async ({ browser }) => scan(def, "mobile", "light", browser));
});

test.describe("تم تاریک", () => {
  for (const def of PAGES.filter((p) => p.dark)) test(`[A3] ${def.name}`, async ({ browser }) => scan(def, "desktop", "dark", browser));
});

test("[A4] ناوبری با صفحه‌کلید: پیوند «پرش به محتوا» و ترتیب فوکوس در پنل", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin");
  await settle(page);
  await page.keyboard.press("Tab");
  const first = page.locator(":focus");
  await expect(first).toHaveAttribute("href", "#main-content");
  expect(await page.locator("#main-content").count(), "هدف پیوند پرش وجود دارد").toBe(1);
  // فوکوس باید قابل‌دیدن باشد (outline یا box-shadow)
  const visible = await first.evaluate((el) => {
    const cs = getComputedStyle(el);
    return (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
  });
  expect(visible, "نشانگر فوکوس دیده نمی‌شود").toBe(true);
  await ctx.close();
});

test("[A5] فرم‌های ورود و ثبت‌نام: هر فیلد برچسب دارد و خطا با role=alert اعلام می‌شود", async ({ browser }) => {
  const { ctx, page } = await newPage(browser);
  for (const p of ["/login", "/register"]) {
    await page.goto(p);
    const bad = await page.$$eval("input:not([type=hidden]):not([type=submit]), select, textarea", (els) =>
      els.filter((e) => !(e as HTMLInputElement).labels?.length && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby")).map((e) => e.outerHTML.slice(0, 120)),
    );
    expect(bad, `فیلد بدون برچسب در ${p}`).toEqual([]);
  }
  await page.goto("/login");
  await page.locator("#email").fill("nobody-a11y@example.com");
  await page.locator("#password").fill("WrongPass123");
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await ctx.close();
});
