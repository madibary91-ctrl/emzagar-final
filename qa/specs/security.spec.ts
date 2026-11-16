/**
 * ۲) تست امنیت پویا (DAST) — حمله‌ی کنترل‌شده به برنامه‌ی در حال اجرا (بدون ابزار بیرونی و بدون هاست واقعی)
 *  هدرها و کوکی‌ها · احراز هویت/مجوز (کشف خودکار همه‌ی APIها) · IDOR و جداسازی فضاهای کاری · XSS بازتابی و ذخیره‌شده
 *  تزریق SQL/مسیر (path traversal) و ورودی مخرب (بدون ۵xx و بدون نشت) · فایل‌های حساس · Open Redirect · CORS/CSRF
 *  Brute-force و شمارش حساب · نشست (دستکاری، ابطال پس از خروج) · آپلود فایل مخرب
 * معیار: هر ۵xx، نشت اطلاعات داخلی، یا دسترسی غیرمجاز = شکست. موارد «هشدار» (بهبود پیشنهادی) در گزارش ثبت می‌شوند.
 */
import fs from "node:fs";
import path from "node:path";
import { AUTH, BASE, expect, newApi, newPage, sql, test } from "../lib/kit";
import { ADMIN, STATE_DIR, USER } from "../lib/env";
import { requireState } from "../lib/state";
import { PAGES, resolvePath } from "../routes";

const warn = (description: string) => test.info().annotations.push({ type: "warning", description });
const LEAK = /(\bat\s+\S+\s+\(|node_modules|SQLSTATE|syntax error at|duplicate key value|relation "\w+" does not exist|ECONNREFUSED|\/app\/src|root:x:0)/i;
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "route.ts") out.push("/" + path.relative("src/app", path.dirname(p)).split(path.sep).join("/"));
  }
  return out;
};

/* ───────── ۱) هدرها و کوکی‌ها ───────── */
test("[D1] هدرهای امنیتی روی همه‌ی صفحه‌ها (و بدون نشت نسخه‌ی سرور)", async () => {
  const s = requireState();
  for (const def of PAGES) {
    const api = await newApi({ auth: def.auth === "none" ? undefined : AUTH[def.auth] });
    const r = await api.get(resolvePath(def, s), { maxRedirects: 0 });
    const h = r.headers();
    const where = `${def.name} (${r.status()})`;
    expect(h["x-content-type-options"], `nosniff ${where}`).toBe("nosniff");
    expect(h["referrer-policy"], `referrer-policy ${where}`).toBeTruthy();
    expect(h["strict-transport-security"], `hsts ${where}`).toMatch(/max-age=\d{6,}/);
    expect(h["permissions-policy"], `permissions-policy ${where}`).toBeTruthy();
    expect(h["x-powered-by"], `x-powered-by ${where}`).toBeUndefined();
    expect(h["server"] ?? "", `نسخه‌ی سرور ${where}`).not.toMatch(/\d+\.\d+/);
    if (!def.route.startsWith("/embed") && def.route !== "/landing-preview") {
      expect(`${h["x-frame-options"] ?? ""} ${h["content-security-policy"] ?? ""}`, `ضد Clickjacking ${where}`).toMatch(/DENY|SAMEORIGIN|frame-ancestors/i);
    }
    await api.dispose();
  }
  const home = await (await newApi()).get("/");
  if (!/script-src/.test(home.headers()["content-security-policy"] ?? "")) warn("CSP فاقد script-src است (فقط frame-ancestors/base-uri). پیشنهاد: CSP مبتنی بر nonce برای کاهش اثر XSS");
});

test("[D2] کوکی نشست: HttpOnly و SameSite؛ Secure روی HTTPS", async () => {
  for (const f of [AUTH.admin, AUTH.user]) {
    const cookies = (JSON.parse(fs.readFileSync(f, "utf8")) as { cookies: { name: string; httpOnly: boolean; secure: boolean; sameSite: string }[] }).cookies;
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.httpOnly, `${c.name} باید HttpOnly باشد`).toBe(true);
      expect(["Lax", "Strict"], `${c.name} SameSite`).toContain(c.sameSite);
      if (BASE.startsWith("https")) expect(c.secure, `${c.name} باید Secure باشد`).toBe(true);
      else warn(`کوکی ${c.name} روی HTTP، Secure نیست (روی HTTPS واقعی فعال می‌شود؛ آزمون را روی staging با https اجرا کنید)`);
    }
  }
});

/* ───────── ۲) احراز هویت و مجوز ───────── */
test("[D3] صفحه‌های محافظت‌شده بدون ورود هیچ داده‌ای نشت نمی‌دهند", async () => {
  const s = requireState();
  for (const def of PAGES.filter((p) => p.auth !== "none" && p.route !== "/embed/dashboard")) {
    const api = await newApi();
    const r = await api.get(resolvePath(def, s), { maxRedirects: 0 });
    const body = await r.text();
    const redirected = [302, 303, 307, 308].includes(r.status()) && (r.headers()["location"] ?? "").includes("/login");
    const metaRedirect = r.status() === 200 && /\/login/.test(body);
    expect(redirected || metaRedirect, `${def.name} باید به ورود هدایت کند (${r.status()})`).toBe(true);
    for (const secret of [ADMIN.email, USER.email, "AMZ-2026", "تعهدنامه محرمانگی"]) expect(body, `نشت «${secret}» در ${def.name}`).not.toContain(secret);
    await api.dispose();
  }
});

test("[D4] کاربر عادی به بخش مدیر کل پلتفرم راه ندارد", async ({ browser }) => {
  const s = requireState();
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  const adm = await newPage(browser, { auth: AUTH.admin });
  for (const def of PAGES.filter((p) => p.route.startsWith("/platform") && p.name !== "platform-vendor")) {
    const url = resolvePath(def, s);
    await adm.page.goto(url);
    const adminH1 = ((await adm.page.locator("h1").first().textContent()) ?? "").trim();
    expect(adminH1, `مدیر کل باید عنوان صفحه‌ی ${def.name} را ببیند`).not.toBe("");
    const r = await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(500); // ریدایرکت استریمی Next پس از load کامل می‌شود
    const leaked = (await page.locator("body").innerText()).includes(adminH1) && /\/platform/.test(page.url());
    expect(r!.status() >= 400 || !leaked, `${def.name}: کاربر عادی نباید محتوای مدیر کل را ببیند (${r!.status()} ${page.url()})`).toBe(true);
  }
  await adm.ctx.close();
  await ctx.close();
});

test("[D5] کشف خودکار: همه‌ی مسیرهای API بدون ورود، هیچ داده‌ای نمی‌دهند و ۵xx نمی‌شوند", async () => {
  const s = requireState();
  const PUBLIC = /^\/(api\/(health|wordpress\/plugin|brand\/logo|landing\/image|billing\/callback|license|updates|platform\/releases|v1\/connect\/(register|complete)|sign\/)|connect\/sso)/;
  const api = await newApi();
  const bad: string[] = [];
  for (const route of walk("src/app").filter((r) => r.startsWith("/api") || r === "/connect/sso")) {
    const url = route.replace(/\[(token|hash)\]/g, "a".repeat(43)).replace(/\[[^\]]+\]/g, "1").replace("/1/pdf", `/${s.contractId}/pdf`);
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      const r = await api.fetch(url, { method, data: method === "GET" ? undefined : {}, maxRedirects: 0, headers: { "content-type": "application/json" } });
      const st = r.status();
      if (st >= 500) bad.push(`${method} ${url} → ${st}`);
      else if (!PUBLIC.test(route) && st >= 200 && st < 300) bad.push(`${method} ${url} → ${st} (بدون ورود نباید ۲xx باشد)`);
      if (st >= 400) expect(await r.text(), `نشت در ${method} ${url}`).not.toMatch(LEAK);
    }
  }
  expect(bad).toEqual([]);
});

/* ───────── ۳) IDOR و جداسازی ───────── */
test("[D6] IDOR: کاربر به قرارداد/فایل/CSV فضای کاری دیگر دسترسی ندارد و وجود/عدم‌وجود قابل‌تشخیص نیست", async ({ browser }) => {
  const s = requireState();
  const [foreign] = await sql<{ id: number; title: string }>("select id, title from contracts where workspace_id=$1 and customer_id<>$2 and status='signed' limit 1", [s.workspaceId, s.userId]);
  expect(foreign, "داده‌ی نمونه‌ی قرارداد امضاشده‌ی دیگران لازم است").toBeTruthy();
  const user = await newApi({ auth: AUTH.user });
  const probe = async (p: string) => (await user.get(p, { maxRedirects: 0 })).status();
  const missing = 99999999;
  for (const tpl of [(id: number) => `/api/contracts/${id}/pdf`, (id: number) => `/api/contracts/${id}/signature/1`, (id: number) => `/api/contracts/${id}/attachments/1`, (id: number) => `/api/contracts/${id}/amendments/1/pdf`]) {
    const a = await probe(tpl(foreign.id));
    const b = await probe(tpl(missing));
    expect([401, 403, 404], `قرارداد دیگران ${tpl(foreign.id)}`).toContain(a);
    expect(a, `پاسخ قرارداد دیگران با قرارداد ناموجود فرق دارد (افشای وجود) ${tpl(foreign.id)}`).toBe(b);
  }
  const csv = await (await user.get("/api/admin/export")).text();
  expect(csv, "CSV کاربر نباید قراردادهای فضای دیگر را شامل شود").not.toContain(foreign.title);
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto(`/contracts/${foreign.id}`);
  await expect(page.locator("body")).not.toContainText(foreign.title);
  await ctx.close();
});

/* ───────── ۴) XSS ───────── */
const XSS = ['"><svg/onload=alert(1337)>', "<script>alert(1337)</script>", "'-alert(1337)-'", "javascript:alert(1337)"];
test("[D7] XSS بازتابی: پارامترهای URL هرگز بدون escape در HTML برنمی‌گردند و اسکریپتی اجرا نمی‌شود", async ({ browser }) => {
  const paths = ["/login?next=", "/login?reset=", "/login?sso=", "/register?ref=", "/pricing?plan=", "/verify?hash=", "/verify-email?email=", "/forgot?email=", "/pricing?q="];
  const { ctx, page } = await newPage(browser);
  let fired = 0;
  page.on("dialog", async (d) => { fired++; await d.dismiss(); });
  const api = await newApi();
  for (const p of paths) for (const x of XSS) {
    const url = p + encodeURIComponent(x);
    const html = await (await api.get(url)).text();
    expect(html, `بازتاب بدون escape در ${p}`).not.toContain("<svg/onload=alert(1337)>");
    expect(html, `بازتاب بدون escape در ${p}`).not.toContain("<script>alert(1337)</script>");
    await page.goto(url).catch(() => undefined); // برخی مسیرها عمداً هدایت می‌شوند
  }
  expect(fired, "نباید هیچ دیالوگ جاوااسکریپتی باز شود").toBe(0);
  await ctx.close();
});

test("[D8] XSS ذخیره‌شده: عنوان/نام مشتری از API و تیکت پشتیبانی در پنل مدیر و کاربر escape می‌شوند", async ({ browser }) => {
  const s = requireState();
  const mark = `xss${Date.now()}`;
  const payload = `<img src=x onerror="window.__xss='${mark}'">`;
  const key = await newApi({ headers: { Authorization: `Bearer ${s.apiKey}`, "content-type": "application/json" } });
  const r = await key.post("/api/v1/contracts", { data: { templateId: s.templateId, title: payload, customer: { name: payload, email: USER.email, mobile: USER.mobile } } });
  expect(r.status()).toBeLessThan(500);
  const created = r.status() === 201 ? ((await r.json()) as { id: number }).id : 0;

  const user = await newPage(browser, { auth: AUTH.user });
  await user.page.goto("/support/new");
  await user.page.locator("#subject").fill(payload);
  await user.page.locator("#body").fill(`${payload} متن تیکت آزمون امنیت`);
  await user.page.getByRole("button", { name: "ثبت تیکت" }).click();
  await user.page.waitForURL(/\/support\/\d+/);
  const ticketId = Number(/\/support\/(\d+)/.exec(user.page.url())?.[1]);
  const views: [Awaited<ReturnType<typeof newPage>>, string][] = [[user, `/support/${ticketId}`], [user, "/dashboard"], [user, created ? `/contracts/${created}` : "/dashboard"]];
  const admin = await newPage(browser, { auth: AUTH.admin });
  views.push([admin, "/admin"], [admin, "/admin/customers"], [admin, `/platform/tickets/${ticketId}`], [admin, "/platform/tickets"], [admin, "/admin/logs"]);
  for (const [{ page }, url] of views) {
    await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    expect(await page.evaluate(() => (window as unknown as { __xss?: string }).__xss), `اسکریپت ذخیره‌شده در ${url} اجرا شد`).toBeUndefined();
    expect(await page.locator("img[onerror]").count(), `المان img با onerror در ${url}`).toBe(0);
  }
  await user.ctx.close();
  await admin.ctx.close();
});

/* ───────── ۵) تزریق و ورودی مخرب ───────── */
test("[D9] تزریق SQL / path traversal / null-byte: بدون ۵xx، بدون نشت، بدون خواندن فایل", async () => {
  const s = requireState();
  const evil = ["' OR '1'='1", "1; DROP TABLE users;--", "' UNION SELECT NULL,NULL--", "../../../../etc/passwd", "..%2f..%2f..%2f.env", "%2e%2e%2f%2e%2e%2fetc%2fpasswd", "a%00b", "\\..\\..\\windows\\win.ini", "x".repeat(6000), "${7*7}{{7*7}}"];
  const key = await newApi({ headers: { Authorization: `Bearer ${s.apiKey}` } });
  const admin = await newApi({ auth: AUTH.admin });
  const anon = await newApi();
  const failures: string[] = [];
  const check = async (label: string, call: () => Promise<import("@playwright/test").APIResponse>) => {
    const r = await call().catch((e) => { failures.push(`${label} → خطای اتصال ${e}`); return null; });
    if (!r) return;
    const body = await r.text().catch(() => "");
    if (r.status() >= 500) failures.push(`${label} → ${r.status()}`);
    if (LEAK.test(body)) failures.push(`${label} → نشت اطلاعات داخلی`);
    if (/DATABASE_URL|SESSION_SECRET|\[core\]/.test(body)) failures.push(`${label} → نشت رمز/پیکربندی`);
  };
  for (const e of evil) {
    const q = encodeURIComponent(e);
    await check(`v1/contracts?email`, () => key.get(`/api/v1/contracts?email=${q}`));
    await check(`v1/contracts?status`, () => key.get(`/api/v1/contracts?status=${q}`));
    await check(`v1/contracts/[id]`, () => key.get(`/api/v1/contracts/${q}`));
    await check(`admin/search`, () => admin.get(`/api/admin/search?q=${q}`));
    await check(`verify/[hash]`, () => anon.get(`/verify/${q}`));
    await check(`sign/[token]`, () => anon.get(`/sign/${q}`));
    await check(`s/[code]`, () => anon.get(`/s/${q}`, { maxRedirects: 0 }));
    await check(`landing/image`, () => anon.get(`/api/landing/image/${q}`));
    await check(`sign/[token]/pdf`, () => anon.get(`/api/sign/${q}/pdf`));
  }
  for (const [name, num] of [["limit", "-1"], ["limit", "abc"], ["page", "99999999999999999999"], ["page", "1e309"], ["limit", "NaN"]] as const) await check(`v1/contracts?${name}=${num}`, () => key.get(`/api/v1/contracts?${name}=${num}`));
  expect(failures).toEqual([]);
});

test("[D10] بدنه‌ی مخرب به API صدور: JSON خراب، null-byte، بدنه‌ی بسیار بزرگ، نوع نادرست — هرگز ۵xx", async () => {
  const s = requireState();
  const api = await newApi({ headers: { Authorization: `Bearer ${s.apiKey}` } });
  const ok = { templateId: s.templateId, draft: true, customer: { name: "مشتری امنیت", email: "qa-fuzz@example.com", mobile: "09127778888" } };
  const cases: [string, string, string][] = [
    ["JSON خراب", "{bad json", "application/json"],
    ["آرایه به‌جای شیء", "[1,2,3]", "application/json"],
    ["null", "null", "application/json"],
    ["نوع text/plain", JSON.stringify(ok), "text/plain"],
    ["null-byte در عنوان", JSON.stringify({ ...ok, title: "عنوان\u0000مخرب" }), "application/json"],
    ["null-byte در نام", JSON.stringify({ ...ok, customer: { ...ok.customer, name: "نام\u0000" } }), "application/json"],
    ["عنوان ۲ مگابایتی", JSON.stringify({ ...ok, title: "ا".repeat(2_000_000) }), "application/json"],
    ["templateId رشته‌ی SQL", JSON.stringify({ ...ok, templateId: "1; select pg_sleep(5)" }), "application/json"],
    ["templateId شناور", JSON.stringify({ ...ok, templateId: 1.5 }), "application/json"],
    ["customer=null", JSON.stringify({ ...ok, customer: null }), "application/json"],
    ["expiryDays نامعتبر", JSON.stringify({ ...ok, expiryDays: "x'; --" }), "application/json"],
    ["تو در تو عمیق", "[".repeat(5000) + "]".repeat(5000), "application/json"],
  ];
  const failures: string[] = [];
  for (const [name, data, ct] of cases) {
    const r = await api.post("/api/v1/contracts", { data, headers: { "content-type": ct } });
    const body = await r.text();
    if (r.status() >= 500) failures.push(`${name} → ${r.status()}: ${body.slice(0, 120)}`);
    if (LEAK.test(body)) failures.push(`${name} → نشت اطلاعات داخلی`);
  }
  expect(failures, "ورودی مخرب نباید ۵xx بدهد؛ باید ۴xx کنترل‌شده باشد").toEqual([]);
});

test("[D11] فایل‌ها و مسیرهای حساس در دسترس نیستند (env، git، سورس، بک‌آپ، source map)", async () => {
  const api = await newApi();
  const paths = ["/.env", "/.env.local", "/.git/config", "/.git/HEAD", "/package.json", "/package-lock.json", "/next.config.ts", "/tsconfig.json", "/docker-compose.yml", "/Dockerfile", "/src/db/schema.ts", "/src/lib/config.ts", "/storage/installed.lock", "/storage/config.json", "/.qa-storage/installed.lock", "/backup.sql", "/backups/", "/.next/BUILD_ID", "/_next/../.env", "/%2e%2e/.env", "/api/../.env", "/wp-admin/", "/phpmyadmin/", "/server-status", "/.DS_Store"];
  const bad: string[] = [];
  for (const p of paths) {
    const r = await api.get(p, { maxRedirects: 0 });
    const body = await r.text();
    if (r.status() === 200 && !/<html/i.test(body.slice(0, 200))) bad.push(`${p} → 200 (${body.slice(0, 60).replace(/\n/g, " ")})`);
    if (/DATABASE_URL|SESSION_SECRET|\[core\]|"dependencies"|drizzle-orm/.test(body)) bad.push(`${p} → نشت محتوای حساس`);
  }
  expect(bad).toEqual([]);
});

/* ───────── ۶) Redirect، CORS، CSRF ───────── */
test("[D12] Open Redirect: پارامتر next و بازگشت درگاه هرگز به دامنه‌ی بیرونی نمی‌روند", async ({ browser }) => {
  const own = new URL(BASE).host;
  for (const next of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    const { ctx, page } = await newPage(browser);
    await page.goto(`/login?next=${encodeURIComponent(next)}`);
    await page.locator("#email").fill(USER.email);
    await page.locator("#password").fill(USER.password);
    await page.getByRole("button", { name: "ورود", exact: true }).click();
    await page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20_000 });
    expect(new URL(page.url()).host, `next=${next} به دامنه‌ی بیرونی رفت`).toBe(own);
    await ctx.close();
  }
  const api = await newApi();
  const r = await api.get("/api/billing/callback?Authority=x&Status=OK&order=1&redirect=https://evil.example&next=https://evil.example", { maxRedirects: 0 });
  const loc = r.headers()["location"] ?? "";
  expect(loc === "" || loc.startsWith("/") || new URL(loc, BASE).host === own, `Location=${loc}`).toBe(true);
});

test("[D13] CORS و CSRF: مبدأ بیگانه اجازه‌ی خواندن نمی‌گیرد؛ API کلید-محور با Origin مخرب امن است", async () => {
  const s = requireState();
  const evil = "https://evil.example";
  const key = await newApi({ headers: { Authorization: `Bearer ${s.apiKey}`, Origin: evil } });
  for (const p of ["/api/v1/stats", "/api/v1/contracts", "/api/health"]) {
    const r = await key.get(p);
    const acao = r.headers()["access-control-allow-origin"];
    expect(acao === undefined || (acao !== "*" && acao !== evil), `CORS باز در ${p}: ${acao}`).toBe(true);
    expect(r.headers()["access-control-allow-credentials"] ?? "false").not.toBe("true");
  }
  const pre = await (await newApi()).fetch("/api/v1/contracts", { method: "OPTIONS", headers: { Origin: evil, "Access-Control-Request-Method": "POST" } });
  expect(pre.headers()["access-control-allow-origin"] ?? "").not.toMatch(/evil|\*/);
  const admin = await newApi({ auth: AUTH.admin, headers: { Origin: evil } });
  const post = await admin.post("/api/notifications", { data: {} });
  if (post.status() === 200) warn("POST با کوکی نشست و Origin بیگانه پذیرفته شد؛ فقط SameSite=Lax جلوی CSRF را می‌گیرد. پیشنهاد: بررسی هدر Origin در مسیرهای تغییردهنده‌ی API");
  const methods = await (await newApi()).fetch("/api/health", { method: "DELETE" });
  expect([404, 405]).toContain(methods.status());
});

/* ───────── ۷) Brute-force، شمارش حساب، نشست ───────── */
test("[D14] ورود: محدودیت تلاش (۸ تلاش/ایمیل) و پیام یکسان برای ایمیل ناشناس و رمز اشتباه", async ({ browser }) => {
  const attempt = async (page: import("@playwright/test").Page, email: string, pass: string) => {
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(pass);
    await page.getByRole("button", { name: "ورود", exact: true }).click();
    const alert = page.locator('p[role="alert"]');
    await expect(alert).toBeVisible();
    return ((await alert.textContent()) ?? "").trim();
  };
  const { ctx, page } = await newPage(browser);
  const unknown = await attempt(page, `nobody-${Date.now()}@example.com`, "WrongPass123");
  const known = await attempt(page, USER.email, "WrongPass123");
  expect(known, "پیام ایمیل ناشناس و رمز اشتباه باید یکسان باشد (جلوگیری از شمارش حساب‌ها)").toBe(unknown);
  const victim = `brute-${Date.now()}@example.com`;
  let locked = 0;
  for (let i = 1; i <= 11; i++) {
    const msg = await attempt(page, victim, `Wrong${i}Pass123`);
    if (/زیاد/.test(msg)) { locked = i; break; }
  }
  expect(locked, "پس از چند تلاش ناموفق باید قفل موقت فعال شود").toBeGreaterThan(0);
  expect(locked, "قفل نباید دیرتر از ۱۰ تلاش فعال شود").toBeLessThanOrEqual(10);
  await ctx.close();
});

test("[D15] نشست: کوکی دستکاری‌شده بی‌اثر است و نشست پس از «خروج» در سمت سرور باطل می‌شود", async ({ browser }) => {
  const st = JSON.parse(fs.readFileSync(AUTH.user, "utf8")) as { cookies: { name: string; value: string }[] };
  const tampered = JSON.parse(JSON.stringify(st)) as typeof st;
  for (const c of tampered.cookies) if (c.name === "amz_session") c.value = c.value.slice(0, -4) + (c.value.endsWith("AAAA") ? "BBBB" : "AAAA");
  const tFile = path.join(STATE_DIR, "tampered-auth.json");
  fs.writeFileSync(tFile, JSON.stringify(tampered));
  const t = await newApi({ auth: tFile });
  expect((await t.get("/api/notifications")).status(), "کوکی دستکاری‌شده").toBe(401);
  expect((await t.get("/dashboard", { maxRedirects: 0 })).status(), "صفحه با کوکی دستکاری‌شده").toBeLessThan(500);

  // ورود تازه، ذخیره‌ی کوکی، خروج، و بازپخش کوکی قدیمی
  const { ctx, page } = await newPage(browser);
  await page.goto("/login");
  await page.locator("#email").fill(USER.email);
  await page.locator("#password").fill(USER.password);
  await page.getByRole("button", { name: "ورود", exact: true }).click();
  await page.waitForURL((u) => !/\/login/.test(u.pathname));
  const saved = path.join(STATE_DIR, "replay-auth.json");
  await ctx.storageState({ path: saved });
  const before = await newApi({ auth: saved });
  expect((await before.get("/api/notifications")).status(), "نشست تازه معتبر است").toBe(200);
  await page.getByRole("button", { name: "خروج از حساب" }).click();
  await expect(page).toHaveURL(/\/login/);
  const after = await newApi({ auth: saved });
  expect((await after.get("/api/notifications")).status(), "بازپخش نشست پس از خروج باید رد شود").toBe(401);
  await ctx.close();
});

/* ───────── ۸) آپلود مخرب ───────── */
test("[D16] آپلود تصویر لندینگ: SVG/HTML/اجرایی مخرب رد می‌شود و نام فایل مسیر نمی‌پیماید", async () => {
  const admin = await newApi({ auth: AUTH.admin });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
  const up = (name: string, mimeType: string, buffer: Buffer) => admin.post("/api/landing/upload", { multipart: { file: { name, mimeType, buffer } } });
  const good = await up("ok.png", "image/png", png);
  expect(good.status(), "آپلود PNG معتبر باید کار کند (و فیلد درست باشد)").toBe(200);
  const reject = async (label: string, r: import("@playwright/test").APIResponse) => {
    expect(r.status(), `${label} باید رد شود`).toBeGreaterThanOrEqual(400);
    expect(r.status(), `${label} نباید ۵xx باشد`).toBeLessThan(500);
  };
  await reject("SVG با اسکریپت", await up("x.svg", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>')));
  await reject("HTML با نوع png", await up("x.png", "image/png", Buffer.from("<html><script>alert(1)</script></html>")));
  await reject("اجرایی با نوع jpeg", await up("x.jpg", "image/jpeg", Buffer.from("MZ\x90\x00\x03\x00\x00\x00 fake exe")));
  await reject("حجم بسیار زیاد", await up("big.png", "image/png", Buffer.concat([png, Buffer.alloc(12 * 1024 * 1024)])));
  const trav = await up("../../../../tmp/evil.png", "image/png", png);
  expect(trav.status()).toBeLessThan(500);
  if (trav.status() === 200) {
    const j = (await trav.json()) as { url?: string };
    expect(j.url ?? "", "نام ذخیره‌شده نباید مسیر بیرونی بسازد").not.toMatch(/\.\.|\/tmp\//);
  }
});
