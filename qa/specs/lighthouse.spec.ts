/**
 * Lighthouse روی Chromium مجموعه‌ی Playwright (بدون Chrome نصب‌شده‌ی جدا و بدون اینترنت).
 * آستانه‌ها: سئو و دسترس‌پذیری ≥ ۹۰ ، بهترین‌روش‌ها ≥ ۸۰ ، عملکرد موبایل (شبیه‌سازی کندی شبکه) ≥ ۶۵ و دسکتاپ ≥ ۸۵.
 * عملکرد در سندباکس‌ها پرنوسان است؛ بودجه‌ی دقیق‌تر در perf-seo.spec.ts با اندازه‌گیری واقعی سنجیده می‌شود.
 */
import { chromium } from "@playwright/test";
import { BASE, expect, recordMetric, test } from "../lib/kit";

const PORT = 9333;
const PAGES = [
  { name: "home", path: "/", form: "mobile" },
  { name: "pricing", path: "/pricing", form: "mobile" },
  { name: "register", path: "/register", form: "mobile" },
  { name: "login", path: "/login", form: "mobile" },
  { name: "home", path: "/", form: "desktop" },
] as const;
const MIN = { seo: 90, accessibility: 90, "best-practices": 80 } as const;

test.describe.configure({ mode: "serial" });

for (const p of PAGES) {
  test(`[L1] ${p.name} (${p.form})`, async () => {
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${PORT}`, "--no-sandbox"] });
    try {
      const mod = (await import("lighthouse")) as unknown as { default: (url: string, flags: Record<string, unknown>, config?: Record<string, unknown>) => Promise<{ lhr: LHR } | undefined> };
      const desktop = p.form === "desktop";
      const settings = {
        onlyCategories: ["performance", "seo", "accessibility", "best-practices"],
        formFactor: p.form,
        screenEmulation: desktop ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false } : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
        throttling: desktop ? { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 } : undefined,
        disableStorageReset: false,
      };
      const out = await mod.default(`${BASE}${p.path}`, { port: PORT, output: "json", logLevel: "error", extraHeaders: { "x-forwarded-for": "10.77.0.1" } }, { extends: "lighthouse:default", settings });
      const lhr = out?.lhr;
      expect(lhr, "Lighthouse نتیجه نداد").toBeTruthy();
      const score = (k: string) => Math.round((lhr!.categories[k]?.score ?? 0) * 100);
      const row = { page: p.name, form: p.form, performance: score("performance"), seo: score("seo"), accessibility: score("accessibility"), bestPractices: score("best-practices") };
      recordMetric("lighthouse", row);
      const failing = Object.values(lhr!.audits).filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "manual" && a.scoreDisplayMode !== "notApplicable");
      for (const a of failing) test.info().annotations.push({ type: "warning", description: `${p.name}/${p.form}: ${a.id} (${Math.round((a.score ?? 0) * 100)}) — ${a.title}` });
      const fails = failing.map((a) => `${a.id}=${Math.round((a.score ?? 0) * 100)}`).join(", ");
      expect.soft(row.seo, `سئو — ممیزی‌های ناموفق: ${fails}`).toBeGreaterThanOrEqual(MIN.seo);
      expect.soft(row.accessibility, `دسترس‌پذیری — ${fails}`).toBeGreaterThanOrEqual(MIN.accessibility);
      expect.soft(row.bestPractices, `بهترین‌روش‌ها — ${fails}`).toBeGreaterThanOrEqual(MIN["best-practices"]);
      expect.soft(row.performance, `عملکرد — ${fails}`).toBeGreaterThanOrEqual(desktop ? 85 : 65);
    } finally {
      await browser.close();
    }
  });
}

interface LHR {
  categories: Record<string, { score: number | null }>;
  audits: Record<string, { id: string; title: string; score: number | null; scoreDisplayMode: string }>;
}
