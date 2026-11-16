/**
 * بخش دوازدهم — مرزهای دسترسی و امنیت پنل (نقش‌محور / چندمستاجری)
 *
 * بازیگران (همه با ثبت‌نام واقعی از رابط کاربری ساخته می‌شوند):
 *   فضای کاری «الف»: مالک الف، مدیر الف (admin)، کارشناس فروش (member)، ناظر (viewer)، مشتری (client)
 *   فضای کاری «ب»  : مالک ب، کارشناس فروش ب
 *   مدیر کل پلتفرم : همان مدیر نصب‌کننده (AUTH.admin از آزمون‌های قبلی؛ فقط برای «کنترل مثبت»)
 *
 * «کارشناس فروش» در مدل نقش‌های امضاگیر = «عضو» (member): صدور قرارداد/قالب/مشتری آری؛
 * تنظیمات، امور مالی، حذف/لغو و مدیریت تیم خیر. («ناظر» فقط مشاهده می‌کند.)
 *
 * هر سناریو هم رابط (ریدایرکت، 403/404، نبودن دکمه) و هم وضعیت واقعی دیتابیس را می‌سنجد، و حمله‌ی بدون رابط
 * را با بازپخش Server Action واقعی با نشست کاربر کم‌دسترسی تقلید می‌کند.
 */
import fs from "node:fs";
import { request as pwRequest } from "@playwright/test";
import { alert, AUTH, BASE, expect, newContext, newPage, sql, test } from "./lib/kit";
import {
  captureForm,
  createPersona,
  expectApiDenied,
  expectBlocked,
  hasNav,
  memberRow,
  placeInWorkspace,
  replayAction,
  seedWorkspace,
  type Persona,
  type Seed,
} from "./lib/rbac";

type Cast = Record<"ownerA" | "adminA" | "sales" | "viewer" | "client" | "ownerB" | "salesB", Persona>;
let cast: Cast;
let seedA: Seed;
let seedB: Seed;
let wsA = 0;
let wsB = 0;

const DENIED = /\/admin\?denied=1/;
const FINANCE_AND_SETTINGS = ["/admin/billing", "/admin/billing/invoices", "/admin/wallet", "/admin/settings", "/admin/api", "/admin/webhooks", "/admin/branding", "/admin/kyc", "/admin/automation", "/admin/messengers", "/admin/woocommerce", "/admin/wordpress"];
const PLATFORM_PAGES = ["/platform", "/platform/finance", "/platform/plans", "/platform/tickets", "/platform/health", "/platform/kyc", "/platform/commerce", "/platform/license", "/platform/vendor", "/platform/identity", "/platform/messengers", "/platform/chat", "/admin/landing"];
const PLATFORM_APIS: [string, "GET" | "POST" | "PUT"][] = [["/api/platform/health", "GET"], ["/api/platform/health", "POST"], ["/api/platform/health/export", "GET"], ["/api/platform/releases", "PUT"]];

test.describe.serial("[R] امنیت نقش‌محور و جداسازی فضاهای کاری", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000);
    const mk = (key: keyof Cast, name: string, ws: string) => createPersona(browser, key, name, ws);
    cast = {
      ownerA: await mk("ownerA", "مالک الف", "شرکت الف"),
      adminA: await mk("adminA", "مدیر الف", "فضای مدیر الف"),
      sales: await mk("sales", "کارشناس فروش الف", "فضای فروش الف"),
      viewer: await mk("viewer", "ناظر الف", "فضای ناظر الف"),
      client: await mk("client", "مشتری الف", "فضای مشتری الف"),
      ownerB: await mk("ownerB", "مالک ب", "شرکت ب"),
      salesB: await mk("salesB", "کارشناس فروش ب", "فضای فروش ب"),
    };
    wsA = cast.ownerA.ownWorkspaceId;
    wsB = cast.ownerB.ownWorkspaceId;
    await placeInWorkspace(cast.adminA, wsA, "admin");
    await placeInWorkspace(cast.sales, wsA, "member");
    await placeInWorkspace(cast.viewer, wsA, "viewer");
    await placeInWorkspace(cast.client, wsA, "client");
    await placeInWorkspace(cast.salesB, wsB, "member");
    seedA = await seedWorkspace(browser, cast.ownerA, "الف");
    seedB = await seedWorkspace(browser, cast.ownerB, "ب");
    expect(seedA.workspaceId).toBe(wsA);
    expect(seedB.workspaceId).toBe(wsB);
  });

  test("[R1] مدیر/مالک فضای کاری الف نمی‌تواند اسناد و قالب‌های شرکت ب را ببیند", async ({ browser }) => {
    for (const who of [cast.ownerA, cast.adminA]) {
      const { ctx, page } = await newPage(browser, { auth: who.auth });
      const secrets = [seedB.title, seedB.number, seedB.templateTitle, seedB.customerEmail, cast.ownerB.email];

      // کنترل مثبت: داده‌ی خودشان را می‌بینند (تا مسدودبودن بی‌معنا نباشد)
      await page.goto(`/contracts/${seedA.contractId}`);
      await expect(page.getByText(seedA.title).first()).toBeVisible();

      for (const p of [`/contracts/${seedB.contractId}`, `/contracts/${seedB.contractId}/print`, `/admin/contracts/${seedB.contractId}/edit`, `/admin/contracts/${seedB.contractId}/history`, `/admin/templates/${seedB.templateId}`]) {
        await expectBlocked(page, p, { secrets });
      }
      for (const p of [`/api/contracts/${seedB.contractId}/pdf`, `/api/contracts/${seedB.contractId}/attachments/1`, `/api/contracts/${seedB.contractId}/amendments/1/pdf`, `/api/contracts/${seedB.contractId}/signature/1`]) {
        await expectApiDenied(ctx, p);
      }

      // خروجی CSV و جستجوی سراسری فقط فضای خودی را برمی‌گردانند، حتی اگر شناسه‌ی بیگانه را بخواهند
      const csv = await (await ctx.request.get(`/api/admin/export?ids=${seedB.contractId}`)).text();
      for (const s of secrets) expect(csv).not.toContain(s);
      const ownCsv = await (await ctx.request.get("/api/admin/export")).text();
      expect(ownCsv).toContain(seedA.number);
      expect(ownCsv).not.toContain(seedB.number);

      const foreign = await ctx.request.get(`/api/admin/search?q=${encodeURIComponent(seedB.title)}`);
      expect(await foreign.text()).not.toContain(seedB.title);
      const own = await ctx.request.get(`/api/admin/search?q=${encodeURIComponent(seedA.title)}`);
      expect(await own.text()).toContain(seedA.title);

      // فهرست داشبورد
      await page.goto(`/admin?q=${encodeURIComponent(seedB.number)}`);
      expect(await page.content()).not.toContain(seedB.title);
      await ctx.close();
    }
  });

  test("[R1] دستکاری کوکی فضای کاری فعال (amz_ws) دسترسی به فضای ب نمی‌دهد", async ({ browser }) => {
    const ctx = await newContext(browser, { auth: cast.ownerA.auth });
    await ctx.addCookies([{ name: "amz_ws", value: String(wsB), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto("/admin");
    await expect(page.getByText("شرکت الف").first()).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(seedB.title);
    expect(html).not.toContain("شرکت ب");
    await page.goto("/admin/team");
    expect(await page.content()).not.toContain(cast.ownerB.email);
    await ctx.close();
  });

  test("[R2] بازپخش Server Action بین فضاها: حذف/لغو قرارداد و مدیریت اعضای ب از نشست مالک الف اثری ندارد", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { auth: cast.ownerA.auth });
    await page.goto(`/contracts/${seedA.contractId}`);
    const del = await captureForm(page.locator("form").filter({ has: page.getByRole("button", { name: "حذف", exact: true }) }));
    const cancel = await captureForm(page.locator("form").filter({ has: page.getByRole("button", { name: "لغو", exact: true }) }));
    const url = `/contracts/${seedA.contractId}`;

    await replayAction(ctx, url, cancel, { id: String(seedB.contractId) });
    await replayAction(ctx, url, del, { id: String(seedB.contractId) });
    const [b] = await sql<{ status: string }>("select status from contracts where id=$1", [seedB.contractId]);
    expect(b, "قرارداد شرکت ب نباید حذف شود").toBeDefined();
    expect(b.status, "قرارداد شرکت ب نباید لغو شود").toBe("sent");

    // اعضای تیم ب: حذف و تغییر نقش با memberId بیگانه
    const target = (await memberRow(wsB, cast.salesB.userId))!;
    await page.goto("/admin/team");
    const row = page.locator("tr", { hasText: cast.sales.email });
    const remove = await captureForm(row.locator("form").filter({ has: page.locator("button.btn-danger") }));
    const role = await captureForm(row.locator("form").filter({ has: page.locator("select[name=role]") }));
    await replayAction(ctx, "/admin/team", remove, { memberId: String(target.id) });
    await replayAction(ctx, "/admin/team", role, { memberId: String(target.id), role: "viewer" });
    const after = await memberRow(wsB, cast.salesB.userId);
    expect(after, "عضو شرکت ب نباید حذف شود").toBeDefined();
    expect(after!.role, "نقش عضو شرکت ب نباید تغییر کند").toBe("member");

    // کنترل مثبت: همین اکشن روی عضو خودی کار می‌کند (فرم ساختگی نیست) — ناظر به «عضو» ارتقا و برمی‌گردد
    const mine = (await memberRow(wsA, cast.viewer.userId))!;
    await replayAction(ctx, "/admin/team", role, { memberId: String(mine.id), role: "member" });
    expect((await memberRow(wsA, cast.viewer.userId))!.role).toBe("member");
    await replayAction(ctx, "/admin/team", role, { memberId: String(mine.id), role: "viewer" });
    expect((await memberRow(wsA, cast.viewer.userId))!.role).toBe("viewer");
    await ctx.close();
  });

  test("[R3] کلید API فضای الف فقط قراردادهای الف را می‌بیند؛ نشست مرورگر جای کلید را نمی‌گیرد", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { auth: cast.ownerA.auth });
    await page.goto("/admin/api");
    await page.getByPlaceholder(/نام کلید/).fill("کلید آزمون الف");
    await page.getByRole("button", { name: "ساخت کلید" }).click();
    const plain = (await page.locator("code", { hasText: /^emz_[a-f0-9]{48}$/ }).first().textContent())?.trim() ?? "";
    expect(plain).toMatch(/^emz_[a-f0-9]{48}$/);

    const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${plain}`, "x-forwarded-for": "10.77.3.9" } });
    const list = await api.get("/api/v1/contracts");
    expect(list.status()).toBe(200);
    const text = await list.text();
    expect(text).toContain(seedA.number);
    expect(text).not.toContain(seedB.number);
    expect(text).not.toContain(seedB.title);
    const foreign = await api.get(`/api/v1/contracts/${seedB.contractId}`);
    expect(foreign.status()).toBe(404);
    expect((await api.get(`/api/v1/contracts/${seedA.contractId}`)).status()).toBe(200);
    await api.dispose();

    // کوکی نشست بدون کلید → 401؛ کلید ساختگی → 401
    expect((await ctx.request.get("/api/v1/contracts")).status()).toBe(401);
    const fake = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer emz_${"0".repeat(48)}`, "x-forwarded-for": "10.77.3.10" } });
    expect((await fake.get("/api/v1/contracts")).status()).toBe(401);
    await fake.dispose();
    await ctx.close();
  });

  test("[R4] کارشناس فروش: بخش‌های مالی و تنظیمات بسته است (ریدایرکت + پیام عدم‌دسترسی)", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { auth: cast.sales.auth });

    // کنترل مثبت: کار روزمره‌ی فروش آزاد است
    for (const p of ["/admin", "/admin/new", "/admin/templates", "/admin/customers"]) {
      await page.goto(p);
      expect(new URL(page.url()).pathname, `${p} برای فروش باید باز باشد`).toBe(p);
    }
    await page.goto(`/contracts/${seedA.contractId}`);
    await expect(page.getByText(seedA.title).first()).toBeVisible();

    for (const p of FINANCE_AND_SETTINGS) {
      await expectBlocked(page, p, { allowRedirectTo: DENIED });
      await expect(alert(page).filter({ hasText: "اجازه" }).first(), `پیام عدم‌دسترسی برای ${p}`).toBeVisible();
    }
    // منوی کناری هم این بخش‌ها را نشان نمی‌دهد
    await page.goto("/admin");
    for (const p of ["/admin/billing", "/admin/wallet", "/admin/settings", "/admin/api"]) await expect(hasNav(page, p)).toHaveCount(0);
    await expect(hasNav(page, "/admin/templates").first()).toBeAttached();
    await ctx.close();

    // مالک همان فضا همین صفحه‌ها را می‌بیند (تفاوت فقط از نقش است)
    const o = await newPage(browser, { auth: cast.ownerA.auth });
    for (const p of ["/admin/billing", "/admin/settings", "/admin/api"]) {
      await o.page.goto(p);
      expect(new URL(o.page.url()).pathname).toBe(p);
    }
    await o.page.goto("/admin");
    for (const p of ["/admin/billing", "/admin/wallet", "/admin/settings", "/admin/api"]) await expect(hasNav(o.page, p).first()).toBeAttached();
    await o.ctx.close();
  });

  test("[R4] کارشناس فروش نمی‌تواند اعضای تیم را حذف/ارتقا دهد یا قرارداد را حذف و لغو کند (حتی با بازپخش مستقیم اکشن)", async ({ browser }) => {
    // رابط: فرم دعوت، انتخاب نقش و دکمه‌ی حذف برای فروش وجود ندارد
    const s = await newPage(browser, { auth: cast.sales.auth });
    await s.page.goto("/admin/team");
    await expect(s.page.getByRole("heading", { name: "دعوت عضو جدید" })).toHaveCount(0);
    await expect(s.page.locator("select[name=role]")).toHaveCount(0);
    await expect(s.page.locator("form button.btn-danger")).toHaveCount(0);
    await s.page.goto(`/contracts/${seedA.contractId}`);
    await expect(s.page.getByRole("button", { name: "حذف", exact: true })).toHaveCount(0);
    await expect(s.page.getByRole("button", { name: "لغو", exact: true })).toHaveCount(0);

    // اکشن‌های واقعی را از نشست مالک برمی‌داریم و با نشست فروش ارسال می‌کنیم
    const o = await newPage(browser, { auth: cast.ownerA.auth });
    await o.page.goto("/admin/team");
    const row = o.page.locator("tr", { hasText: cast.viewer.email });
    const remove = await captureForm(row.locator("form").filter({ has: o.page.locator("button.btn-danger") }));
    const role = await captureForm(row.locator("form").filter({ has: o.page.locator("select[name=role]") }));
    await o.page.goto(`/contracts/${seedA.contractId}`);
    const del = await captureForm(o.page.locator("form").filter({ has: o.page.getByRole("button", { name: "حذف", exact: true }) }));
    const cancel = await captureForm(o.page.locator("form").filter({ has: o.page.getByRole("button", { name: "لغو", exact: true }) }));
    await o.ctx.close();

    const viewer = (await memberRow(wsA, cast.viewer.userId))!;
    const self = (await memberRow(wsA, cast.sales.userId))!;
    await replayAction(s.ctx, "/admin/team", remove, { memberId: String(viewer.id) });
    expect(await memberRow(wsA, cast.viewer.userId), "فروش نباید عضوی را حذف کند").toBeDefined();
    await replayAction(s.ctx, "/admin/team", role, { memberId: String(self.id), role: "admin" });
    expect((await memberRow(wsA, cast.sales.userId))!.role, "ارتقای نقش خود (Privilege Escalation) باید رد شود").toBe("member");
    await replayAction(s.ctx, "/admin/team", role, { memberId: String(viewer.id), role: "admin" });
    expect((await memberRow(wsA, cast.viewer.userId))!.role).toBe("viewer");

    await replayAction(s.ctx, `/contracts/${seedA.contractId}`, cancel, { id: String(seedA.contractId) });
    await replayAction(s.ctx, `/contracts/${seedA.contractId}`, del, { id: String(seedA.contractId) });
    const [c] = await sql<{ status: string }>("select status from contracts where id=$1", [seedA.contractId]);
    expect(c, "فروش نباید قرارداد را حذف کند").toBeDefined();
    expect(c.status, "فروش نباید قرارداد را لغو کند").toBe("sent");
    await s.ctx.close();
  });

  test("[R5] سلسله‌مراتب: مدیر (admin) نه مالک را حذف می‌کند، نه کسی را مدیر/مالک می‌کند", async ({ browser }) => {
    const o = await newPage(browser, { auth: cast.ownerA.auth });
    await o.page.goto("/admin/team");
    const row = o.page.locator("tr", { hasText: cast.sales.email });
    const remove = await captureForm(row.locator("form").filter({ has: o.page.locator("button.btn-danger") }));
    const role = await captureForm(row.locator("form").filter({ has: o.page.locator("select[name=role]") }));
    await o.ctx.close();

    const a = await newPage(browser, { auth: cast.adminA.auth });
    await a.page.goto("/admin/team");
    await expect(a.page.getByRole("heading", { name: "دعوت عضو جدید" })).toBeVisible(); // مدیر مدیریت تیم دارد
    const owner = (await memberRow(wsA, cast.ownerA.userId))!;
    const sales = (await memberRow(wsA, cast.sales.userId))!;
    const self = (await memberRow(wsA, cast.adminA.userId))!;

    await replayAction(a.ctx, "/admin/team", remove, { memberId: String(owner.id) });
    expect(await memberRow(wsA, cast.ownerA.userId), "مدیر نباید مالک را حذف کند").toBeDefined();
    await replayAction(a.ctx, "/admin/team", role, { memberId: String(owner.id), role: "viewer" });
    expect((await memberRow(wsA, cast.ownerA.userId))!.role).toBe("owner");
    await replayAction(a.ctx, "/admin/team", role, { memberId: String(sales.id), role: "owner" });
    expect((await memberRow(wsA, cast.sales.userId))!.role, "مدیر نباید کسی را مالک کند").toBe("member");
    await replayAction(a.ctx, "/admin/team", role, { memberId: String(sales.id), role: "admin" });
    expect((await memberRow(wsA, cast.sales.userId))!.role, "مدیر نباید مدیر هم‌سطح بسازد").toBe("member");
    await replayAction(a.ctx, "/admin/team", remove, { memberId: String(self.id) });
    expect(await memberRow(wsA, cast.adminA.userId), "حذف خود ممنوع است").toBeDefined();
    // کنترل مثبت: مدیر می‌تواند ناظر را عضو کند (و برمی‌گرداند)
    const viewer = (await memberRow(wsA, cast.viewer.userId))!;
    await replayAction(a.ctx, "/admin/team", role, { memberId: String(viewer.id), role: "member" });
    expect((await memberRow(wsA, cast.viewer.userId))!.role).toBe("member");
    await replayAction(a.ctx, "/admin/team", role, { memberId: String(viewer.id), role: "viewer" });
    expect((await memberRow(wsA, cast.viewer.userId))!.role).toBe("viewer");
    await a.ctx.close();
  });

  test("[R6] ناظر (viewer) فقط مشاهده می‌کند: صدور/ساخت بسته است و همه‌ی بخش‌های مالی هم", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { auth: cast.viewer.auth });
    for (const p of ["/admin", "/admin/logs", "/admin/templates", "/admin/customers"]) {
      await page.goto(p);
      expect(new URL(page.url()).pathname, `${p} برای ناظر باید باز باشد`).toBe(p);
    }
    await page.goto(`/contracts/${seedA.contractId}`);
    await expect(page.getByText(seedA.title).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "حذف", exact: true })).toHaveCount(0);

    for (const p of ["/admin/new", "/admin/new/file", "/admin/collect/new", "/admin/templates/new", ...FINANCE_AND_SETTINGS.slice(0, 5)]) {
      await expectBlocked(page, p, { allowRedirectTo: DENIED });
    }
    await expect(alert(page).filter({ hasText: "اجازه" }).first()).toBeVisible();
    await ctx.close();
  });

  test("[R7] کاربر عادی: مسیرهای مدیریت کل (/platform) و صفحه‌ی سازنده‌ی سایت بسته است؛ مدیر کل می‌بیند", async ({ browser }) => {
    for (const who of [cast.ownerA, cast.adminA, cast.sales, cast.viewer, cast.client]) {
      const { ctx, page } = await newPage(browser, { auth: who.auth });
      for (const p of PLATFORM_PAGES) {
        await expectBlocked(page, p);
        expect(new URL(page.url()).pathname, `${who.key}: ${p} نباید باز بماند`).not.toMatch(/^\/(platform|admin\/landing)/);
      }
      for (const [p, m] of PLATFORM_APIS) await expectApiDenied(ctx, p, [401, 403, 404], m);
      // دکمه/پیوند مدیریت کل در منوی کاربر عادی نیست
      await page.goto("/dashboard");
      await expect(hasNav(page, "/platform")).toHaveCount(0);
      await ctx.close();
    }

    // کنترل مثبت: مدیر کل پلتفرم (نصب‌کننده)
    test.skip(!fs.existsSync(AUTH.admin), "نشست مدیر کل (آزمون‌های ۰۱) موجود نیست");
    const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
    await page.goto("/platform");
    expect(new URL(page.url()).pathname).toBe("/platform");
    await ctx.close();
  });

  test("[R7] بازپخش اکشن مالی پلتفرم (نرخ مالیات/فروشنده‌ی فاکتور) از نشست مالک فضای کاری اثری ندارد", async ({ browser }) => {
    test.skip(!fs.existsSync(AUTH.admin), "نشست مدیر کل (آزمون‌های ۰۱) موجود نیست");
    const adm = await newPage(browser, { auth: AUTH.admin });
    await adm.page.goto("/platform/finance");
    const field = adm.page.locator("#f-name");
    const before = await field.inputValue();
    const fields = await captureForm(adm.page.locator("form").filter({ has: adm.page.locator("#f-name") }));

    for (const who of [cast.ownerA, cast.adminA, cast.sales]) {
      const { ctx } = await newPage(browser, { auth: who.auth });
      await replayAction(ctx, "/platform/finance", fields, { sellerName: `هک‌شده-${who.key}`, taxPercent: "0" });
      await ctx.close();
    }
    await adm.page.reload();
    expect(await adm.page.locator("#f-name").inputValue(), "نام فروشنده‌ی فاکتور نباید تغییر کند").toBe(before);

    // کنترل مثبت: مدیر کل همین اکشن را می‌تواند اجرا کند
    const marker = `فروشنده-${Date.now().toString(36)}`;
    await replayAction(adm.ctx, "/platform/finance", fields, { sellerName: marker });
    await adm.page.reload();
    expect(await adm.page.locator("#f-name").inputValue()).toBe(marker);
    await adm.page.locator("#f-name").fill(before);
    await adm.page.getByRole("button", { name: "ذخیره", exact: true }).first().click();
    await adm.ctx.close();
  });

  test("[R8] مشتری (client) به پنل مدیریت راه ندارد و قرارداد غیرخودش را نمی‌بیند", async ({ browser }) => {
    const { ctx, page } = await newPage(browser, { auth: cast.client.auth });
    for (const p of ["/admin", "/admin/new", "/admin/templates", "/admin/team", "/admin/billing", "/admin/settings"]) {
      await expectBlocked(page, p);
      expect(new URL(page.url()).pathname).toBe("/dashboard");
    }
    await expectBlocked(page, `/contracts/${seedA.contractId}`, { secrets: [seedA.title, seedA.number] });
    await expectBlocked(page, `/contracts/${seedB.contractId}`, { secrets: [seedB.title, seedB.number] });
    await expectApiDenied(ctx, "/api/admin/export", [401, 403]);
    await expectApiDenied(ctx, `/api/contracts/${seedA.contractId}/pdf`, [403, 404]);
    await expectApiDenied(ctx, "/api/admin/search?q=قرارداد", [401, 403]);
    await ctx.close();
  });

  test("[R9] بدون ورود: همه‌ی مسیرهای خصوصی به /login می‌روند و APIها 401/403 می‌دهند", async ({ browser }) => {
    const { ctx, page } = await newPage(browser);
    for (const p of ["/admin", "/admin/team", "/admin/billing", "/platform", "/platform/finance", "/account", "/dashboard", `/contracts/${seedA.contractId}`, `/admin/contracts/${seedA.contractId}/edit`]) {
      await expectBlocked(page, p, { secrets: [seedA.title, seedA.number] });
      expect(new URL(page.url()).pathname, `${p} بدون ورود`).toBe("/login");
    }
    for (const p of ["/api/admin/export", "/api/admin/search?q=قرارداد", "/api/platform/health", "/api/platform/health/export", "/api/notifications", `/api/contracts/${seedA.contractId}/pdf`, "/api/account/export", "/api/v1/contracts", "/api/v1/stats"]) {
      await expectApiDenied(ctx, p, [401, 403]);
    }
    await ctx.close();
  });

  test("[R10] لغو دسترسی بلادرنگ: حذف عضو از تیم، نشست باز او را همان لحظه از پنل بیرون می‌اندازد", async ({ browser }) => {
    const s = await newPage(browser, { auth: cast.sales.auth });
    await s.page.goto("/admin");
    expect(new URL(s.page.url()).pathname).toBe("/admin");

    // مالک از رابط واقعی عضو را حذف می‌کند
    const o = await newPage(browser, { auth: cast.ownerA.auth });
    await o.page.goto("/admin/team");
    const row = o.page.locator("tr", { hasText: cast.sales.email });
    await row.locator("button.btn-danger").click();
    await o.page.getByRole("dialog").getByRole("button", { name: "بله، انجام شود" }).click();
    await expect.poll(async () => memberRow(wsA, cast.sales.userId), { timeout: 20_000 }).toBeUndefined();
    await o.ctx.close();

    // نشست قدیمی فروش بدون ورود دوباره هیچ دسترسی‌ای ندارد
    await expectBlocked(s.page, "/admin", { secrets: [seedA.title] });
    await expectBlocked(s.page, `/contracts/${seedA.contractId}`, { secrets: [seedA.title, seedA.number] });
    await expectApiDenied(s.ctx, "/api/admin/export", [401, 403]);
    await expectApiDenied(s.ctx, `/api/contracts/${seedA.contractId}/pdf`, [403, 404]);
    await s.ctx.close();
  });
});
