/**
 * ۳) تست عملکرد و سئو برای صفحه‌های عمومی و لندینگ
 *  عملکرد: در Chromium واقعی با کش سرد؛ TTFB، FCP، LCP، CLS، حجم JS (فشرده)، تعداد درخواست و اندازه‌ی DOM در برابر بودجه (qa/lib/env.ts)
 *  سئو: lang/dir، title، description، h1، canonical، robots/noindex، Open Graph، JSON-LD، alt تصاویر، لینک‌های داخلی،
 *       هم‌خوانی robots.txt با sitemap.xml، manifest/آیکون‌ها، فشرده‌سازی و کش دارایی‌های ثابت
 */
import type { Browser, Page } from "@playwright/test";
import { AUTH, BASE, expect, newApi, newPage, recordMetric, test } from "../lib/kit";
import { BUDGET } from "../lib/env";
import { PAGES, resolvePath } from "../routes";
import { requireState } from "../lib/state";

const PERF_PAGES = PAGES.filter((p) => ["home", "pricing", "register", "login", "verify"].includes(p.name));
const SEO_PUBLIC = PAGES.filter((p) => p.auth === "none" && ["home", "pricing", "login", "register", "forgot", "verify"].includes(p.name));

const INIT = `
window.__m = { lcp: 0, cls: 0 };
new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
`;

async function measure(browser: Browser, path: string) {
  const { ctx, page } = await newPage(browser, { reducedMotion: false });
  await page.addInitScript(INIT);
  await page.goto(path, { waitUntil: "load" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    const w = window as unknown as { __m: { lcp: number; cls: number } };
    return {
      ttfb: nav.responseStart - nav.startTime,
      fcp,
      lcp: w.__m.lcp,
      cls: w.__m.cls,
      jsBytes: res.filter((r) => /\.js(\?|$)/.test(r.name)).reduce((a, r) => a + (r.encodedBodySize || r.transferSize || 0), 0),
      requests: res.length + 1,
      dom: document.getElementsByTagName("*").length,
    };
  });
  await ctx.close();
  return m;
}

test.describe("عملکرد (کش سرد، بهترین از ۲ اجرا)", () => {
  for (const def of PERF_PAGES) {
    test(`[P1] ${def.name} در بودجه است`, async ({ browser }) => {
      const a = await measure(browser, resolvePath(def, requireState()));
      const b = await measure(browser, resolvePath(def, requireState()));
      const best = { ttfb: Math.min(a.ttfb, b.ttfb), fcp: Math.min(a.fcp, b.fcp), lcp: Math.min(a.lcp, b.lcp), cls: Math.min(a.cls, b.cls), jsBytes: Math.min(a.jsBytes, b.jsBytes), requests: Math.min(a.requests, b.requests), dom: Math.min(a.dom, b.dom) };
      recordMetric("perf", { page: def.name, ttfb: Math.round(best.ttfb), fcp: Math.round(best.fcp), lcp: Math.round(best.lcp), cls: best.cls.toFixed(3), jsKb: Math.round(best.jsBytes / 1024), requests: best.requests, dom: best.dom });
      expect.soft(best.ttfb, "TTFB (ms)").toBeLessThan(BUDGET.ttfbMs);
      expect.soft(best.fcp, "FCP (ms)").toBeLessThan(BUDGET.fcpMs);
      expect.soft(best.lcp, "LCP (ms)").toBeLessThan(BUDGET.lcpMs);
      expect.soft(best.cls, "CLS").toBeLessThan(BUDGET.cls);
      expect.soft(best.jsBytes / 1024, "حجم JS فشرده (KB)").toBeLessThan(BUDGET.jsKb);
      expect.soft(best.requests, "تعداد درخواست").toBeLessThan(BUDGET.requests);
      expect.soft(best.dom, "تعداد المان DOM").toBeLessThan(BUDGET.domNodes);
    });
  }

  test("[P2] فشرده‌سازی و کش: HTML فشرده، فایل‌های ثابت immutable، API بدون کش", async () => {
    const api = await newApi({ headers: { "accept-encoding": "gzip, br" } });
    const html = await api.get("/");
    expect(["gzip", "br", "zstd"], "فشرده‌سازی HTML").toContain(html.headers()["content-encoding"]);
    const body = await html.text();
    const js = /\/_next\/static\/[^"']+\.js/.exec(body)?.[0];
    expect(js, "یک فایل JS ثابت در HTML").toBeTruthy();
    const asset = await api.get(js!);
    expect(asset.headers()["cache-control"]).toMatch(/immutable/);
    expect(["gzip", "br", "zstd"], "فشرده‌سازی JS").toContain(asset.headers()["content-encoding"]);
    expect((await api.get("/api/health")).headers()["cache-control"] ?? "no-store").not.toMatch(/max-age=[1-9]/);
    const map = await api.get(js! + ".map");
    expect(map.status(), "source map نباید در production عمومی باشد").toBe(404);
  });

  test("[P3] پاسخ سرور سریع و پایدار: ۲۰ درخواست متوالی به صفحه‌ی اصلی، میانه زیر ۳۰۰ms", async () => {
    const api = await newApi();
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const r = await api.get("/");
      await r.body();
      expect(r.status()).toBe(200);
      times.push(performance.now() - t);
    }
    times.sort((x, y) => x - y);
    recordMetric("perf", { page: "home (۲۰ درخواست متوالی، میانه)", ttfb: Math.round(times[10]), fcp: "—", lcp: "—", cls: "—", jsKb: "—", requests: 20, dom: "—" });
    expect(times[10], "میانه‌ی زمان پاسخ (ms)").toBeLessThan(300);
  });
});

/* ───────── سئو ───────── */
interface Seo {
  lang: string | null; dir: string | null; title: string; description: string | null; h1: number; canonical: string | null; robots: string | null;
  viewport: string | null; og: Record<string, string>; twitterCard: string | null; jsonLd: string[]; imgNoAlt: number; emptyLinks: number; unsafeBlank: number; hrefs: string[];
}

async function readSeo(page: Page): Promise<Seo> {
  return page.evaluate(() => {
    const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? null;
    const og: Record<string, string> = {};
    document.querySelectorAll('meta[property^="og:"]').forEach((m) => (og[m.getAttribute("property")!] = m.getAttribute("content") ?? ""));
    const links = [...document.querySelectorAll("a[href]")] as HTMLAnchorElement[];
    return {
      lang: document.documentElement.getAttribute("lang"),
      dir: document.documentElement.getAttribute("dir"),
      title: document.title,
      description: meta("description"),
      h1: document.querySelectorAll("h1").length,
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
      robots: meta("robots"),
      viewport: meta("viewport"),
      og,
      twitterCard: meta("twitter:card"),
      jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? ""),
      imgNoAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
      emptyLinks: links.filter((a) => !(a.textContent ?? "").trim() && !a.getAttribute("aria-label") && !a.querySelector("img[alt]:not([alt=''])")).length,
      unsafeBlank: links.filter((a) => a.target === "_blank" && !/noopener/.test(a.rel)).length,
      hrefs: links.map((a) => a.getAttribute("href") ?? ""),
    };
  });
}

test.describe("سئو — صفحه‌های عمومی", () => {
  const titles = new Map<string, string>();
  for (const def of SEO_PUBLIC) {
    test(`[E1] ${def.name}: متادیتا، ساختار و نشانه‌گذاری`, async ({ browser }) => {
      const { ctx, page } = await newPage(browser);
      const res = await page.goto(resolvePath(def, requireState()));
      const s = await readSeo(page);
      const headerRobots = res?.headers()["x-robots-tag"] ?? "";
      expect(s.lang, "lang").toBe("fa");
      expect(s.dir, "dir").toBe("rtl");
      expect(s.viewport, "viewport").toContain("width=device-width");
      expect(s.title.length, "title").toBeGreaterThan(3);
      expect(s.title.length, "طول title").toBeLessThanOrEqual(80);
      expect(s.imgNoAlt, "تصویر بدون alt").toBe(0);
      expect(s.emptyLinks, "لینک بدون متن/برچسب").toBe(0);
      expect(s.unsafeBlank, "target=_blank بدون rel=noopener").toBe(0);
      expect(s.og["og:title"], "og:title").toBeTruthy();
      expect(s.og["og:locale"], "og:locale").toBe("fa_IR");
      expect(s.twitterCard, "twitter:card").toBeTruthy();
      if (def.indexable) {
        expect(s.description, "meta description").toBeTruthy();
        expect(s.description!.length, "طول description").toBeGreaterThanOrEqual(50);
        expect(s.description!.length, "طول description").toBeLessThanOrEqual(200);
        expect(s.h1, "دقیقاً یک h1").toBe(1);
        expect(s.canonical, "canonical").toBeTruthy();
        expect(new URL(s.canonical!, BASE).pathname.replace(/\/$/, "") || "/").toBe(new URL(page.url()).pathname.replace(/\/$/, "") || "/");
        expect(`${s.robots ?? ""} ${headerRobots}`, "صفحه‌ی قابل‌ایندکس نباید noindex باشد").not.toMatch(/noindex/);
        expect(titles.get(s.title), `title تکراری با ${titles.get(s.title)}`).toBeUndefined();
        titles.set(s.title, def.name);
      } else {
        expect(`${s.robots ?? ""} ${headerRobots}`, "صفحه‌ی غیرعمومی باید noindex باشد").toMatch(/noindex/);
      }
      await ctx.close();
    });
  }

  test("[E2] لندینگ: JSON-LD معتبر (Organization/WebSite…) و یک h1", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await page.goto("/");
    const s = await readSeo(page);
    expect(s.jsonLd.length).toBeGreaterThanOrEqual(1);
    for (const raw of s.jsonLd) {
      const data = JSON.parse(raw) as { "@context"?: string; "@type"?: string; "@graph"?: unknown[] };
      expect(JSON.stringify(data)).toContain("schema.org");
      expect(raw, "JSON-LD باید در <script> امن باشد").not.toContain("</script");
    }
    expect(s.h1).toBe(1);
    await ctx.close();
  });

  test("[E3] صفحه‌های خصوصی (پنل، حساب، مدیر، پشتیبانی) noindex هستند", async ({ browser }) => {
    const s = requireState();
    for (const def of PAGES.filter((p) => p.auth !== "none" && p.route !== "/embed/dashboard")) {
      const { ctx, page } = await newPage(browser, { auth: AUTH[def.auth as "admin" | "user"] });
      const res = await page.goto(resolvePath(def, s));
      const robots = (await page.locator('meta[name="robots"]').getAttribute("content").catch(() => null)) ?? "";
      expect(`${robots} ${res?.headers()["x-robots-tag"] ?? ""}`, `${def.name} باید noindex باشد`).toMatch(/noindex/);
      await ctx.close();
    }
  });

  test("[E4] صفحه‌ی ۴۰۴ کد درست دارد و ایندکس نمی‌شود", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    const res = await page.goto("/nothing-here-qa");
    expect(res?.status()).toBe(404);
    const robots = (await page.locator('meta[name="robots"]').getAttribute("content").catch(() => null)) ?? "";
    expect(robots).toMatch(/noindex/);
    await ctx.close();
  });
});

test.describe("سئو — فایل‌های فنی", () => {
  test("[E5] robots.txt و sitemap.xml هم‌خوان‌اند: هر آدرس نقشه‌ی سایت 200، قابل‌ایندکس و مجاز در robots است", async () => {
    const api = await newApi();
    const robots = await (await api.get("/robots.txt")).text();
    expect(robots).toMatch(/User-agent: \*/i);
    expect(robots).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/i);
    const disallow = [...robots.matchAll(/^Disallow:\s*(\S+)/gim)].map((m) => m[1]);
    expect(disallow).toEqual(expect.arrayContaining(["/admin", "/api/", "/sign"]));
    const xml = await (await api.get("/sitemap.xml")).text();
    expect(xml).toContain("<urlset");
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls).size, "آدرس تکراری در sitemap").toBe(urls.length);
    for (const u of urls) {
      const p = new URL(u).pathname;
      expect(disallow.some((d) => p.startsWith(d) && d !== "/"), `${p} در sitemap هست ولی در robots مسدود است`).toBe(false);
      const r = await api.get(p, { maxRedirects: 0 });
      expect(r.status(), `${p} در sitemap باید 200 باشد`).toBe(200);
    }
  });

  test("[E6] manifest معتبر و آیکون‌ها با اندازه‌ی اعلام‌شده برابرند", async () => {
    const api = await newApi();
    const m = (await (await api.get("/manifest.webmanifest")).json()) as { name: string; short_name: string; start_url: string; display: string; lang: string; icons: { src: string; sizes: string; purpose?: string }[] };
    expect(m.name && m.short_name && m.start_url).toBeTruthy();
    expect(m.display).toBe("standalone");
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const i of m.icons) {
      const buf = await (await api.get(i.src)).body();
      expect(buf.subarray(1, 4).toString(), "PNG").toBe("PNG");
      expect(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, `اندازه‌ی ${i.src}`).toBe(i.sizes);
    }
    const apple = await (await api.get("/icons/apple-touch-icon.png")).body();
    expect(apple.readUInt32BE(16)).toBe(180);
  });

  test("[E7] تصویر اشتراک‌گذاری (opengraph-image) PNG معتبر ۱۲۰۰×۶۳۰ است", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    await page.goto("/");
    const href = await page.locator('meta[property="og:image"]').getAttribute("content");
    expect(href, "og:image").toBeTruthy();
    const api = await newApi();
    const r = await api.get(new URL(href!, BASE).pathname);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
    const buf = await r.body();
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 630]);
    await ctx.close();
  });

  test("[E8] لینک‌های داخلی صفحه‌ی اصلی و قیمت‌ها شکسته نیستند", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    const api = await newApi();
    const seen = new Set<string>();
    for (const start of ["/", "/pricing"]) {
      await page.goto(start);
      for (const h of (await readSeo(page)).hrefs) {
        if (!h || h.startsWith("#") || /^(mailto|tel|javascript):/.test(h)) continue;
        const u = new URL(h, BASE);
        if (u.origin !== new URL(BASE).origin || seen.has(u.pathname)) continue;
        seen.add(u.pathname);
        const r = await api.get(u.pathname + u.search);
        expect(r.status(), `لینک شکسته ${u.pathname} در ${start}`).toBeLessThan(400);
      }
    }
    expect(seen.size).toBeGreaterThan(2);
    await ctx.close();
  });
});
