/**
 * ابزارهای آزمون‌های «نقش‌محور و چندمستاجری» (RBAC / Tenant isolation).
 *
 * اصل طراحی: هر ادعای امنیتی دو بار سنجیده می‌شود —
 *   ۱) از رابط/پاسخ HTTP (ریدایرکت، 403/404، نبودن دکمه)؛
 *   ۲) از «وضعیت واقعی دیتابیس» (قرارداد هنوز هست، نقش عوض نشده، عضو حذف نشده).
 * و برای اطمینان از اینکه نبودنِ دکمه تنها سد نیست، «Server Action» واقعی (همان فرمی که مدیر می‌بیند) با
 * نشست کاربر کم‌دسترسی «بازپخش» (replay) می‌شود؛ یعنی حمله‌ی دست‌ساز بدون رابط کاربری.
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { BASE, confirmEmail, expect, newPage, register, sql, stamp } from "./kit";

const STATE_DIR = path.resolve("e2e/.state");
export const authFile = (key: string) => path.join(STATE_DIR, `rbac-${key}.json`);

export type Persona = {
  key: string;
  name: string;
  email: string;
  password: string;
  userId: number;
  /** فضای کاری که کاربر هنگام ثبت‌نام ساخته است */
  ownWorkspaceId: number;
  auth: string;
};

let mobileSeq = Math.floor(Math.random() * 9_000_000);
const nextMobile = () => `0913${String(1_000_000 + (mobileSeq++ % 9_000_000)).slice(0, 7)}`;

/** ثبت‌نام واقعی از رابط کاربری + تأیید ایمیل؛ نشست ذخیره می‌شود */
export async function createPersona(browser: Browser, key: string, name: string, workspaceName: string): Promise<Persona> {
  const email = `rbac-${key.toLowerCase()}-${stamp()}@example.com`;
  const password = "Rbac12345x";
  const { ctx, page } = await newPage(browser);
  await register(page, { workspaceName, name, email, mobile: nextMobile(), password });
  await confirmEmail(page);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  await ctx.storageState({ path: authFile(key) });
  await ctx.close();
  const [u] = await sql<{ id: number }>("select id from users where email=$1", [email]);
  const [m] = await sql<{ workspace_id: number }>("select workspace_id from workspace_members where user_id=$1 and role='owner' order by id limit 1", [u.id]);
  return { key, name, email, password, userId: u.id, ownWorkspaceId: m.workspace_id, auth: authFile(key) };
}

/**
 * عضویت تنها‌ی کاربر را به فضای کاری دیگری با نقش داده‌شده منتقل می‌کند
 * (معادل پذیرش دعوت‌نامه؛ تا «فضای فعال» او قطعاً همان فضا باشد).
 */
export async function placeInWorkspace(p: Persona, workspaceId: number, role: "owner" | "admin" | "member" | "viewer" | "client") {
  await sql("update workspace_members set workspace_id=$1, role=$2 where user_id=$3 and workspace_id=$4", [workspaceId, role, p.userId, p.ownWorkspaceId]);
}

export async function memberRow(workspaceId: number, userId: number) {
  const [r] = await sql<{ id: number; role: string }>("select id, role from workspace_members where workspace_id=$1 and user_id=$2", [workspaceId, userId]);
  return r as { id: number; role: string } | undefined;
}

/** صدور قرارداد از روی قالب (فرم فعلی «صدور قرارداد جدید»: جستجوی مشتریان ثبت‌شده + انتخاب با چک‌باکس) */
async function issueFromTemplate(page: Page, v: { templateTitle: string; title: string; customerEmail: string }): Promise<number> {
  await page.goto("/admin/new");
  await page.locator("select[name=templateId]").selectOption({ label: v.templateTitle });
  await page.locator("input[name=title]").fill(v.title);
  await page.getByPlaceholder(/جستجو در مشتریان/).fill(v.customerEmail);
  const row = page.locator("label", { hasText: v.customerEmail }).first();
  await expect(row).toBeVisible();
  await row.locator("input[type=checkbox]").check();
  await page.locator("button[name=intent][value=issue]").click();
  await page.waitForURL(/\/contracts\/\d+/, { timeout: 30_000 });
  return Number(/\/contracts\/(\d+)/.exec(page.url())![1]);
}

export type Seed = { workspaceId: number; templateId: number; templateTitle: string; contractId: number; title: string; number: string; customerEmail: string };

/** داده‌ی واقعی یک فضای کاری: قالب (ویرایشگر واقعی) + مشتری + قرارداد صادرشده */
export async function seedWorkspace(browser: Browser, owner: Persona, tag: string): Promise<Seed> {
  const s = stamp();
  const templateTitle = `قالب ${tag} ${s}`;
  const title = `قرارداد محرمانه ${tag} ${s}`;
  const customerEmail = `cust-${owner.key.toLowerCase()}-${s}@example.com`;
  const { ctx, page } = await newPage(browser, { auth: owner.auth });

  await page.goto("/admin/templates/new");
  await page.locator("input[name=title]").fill(templateTitle);
  const editor = page.locator("[contenteditable=true]").first();
  await editor.click();
  await page.keyboard.type(`این متن قرارداد ${tag} است و فقط اعضای همین فضای کاری حق دیدن آن را دارند. موضوع: خدمات مشاوره.`);
  await page.getByRole("button", { name: "ذخیره قالب" }).click();
  await expect(page).toHaveURL(/\/admin\/templates(\?|$)/);

  await page.goto("/admin/customers");
  await page.getByLabel("نام مشتری").fill(`مشتری ${tag}`);
  await page.getByLabel("ایمیل مشتری").fill(customerEmail);
  await page.getByLabel("موبایل مشتری").fill(nextMobile());
  await page.getByRole("button", { name: "افزودن مشتری" }).click();
  await expect(page.getByText(customerEmail).first()).toBeVisible();

  const contractId = await issueFromTemplate(page, { templateTitle, title, customerEmail });
  await ctx.close();

  const [t] = await sql<{ id: number; workspace_id: number }>("select id, workspace_id from templates where title=$1", [templateTitle]);
  const [c] = await sql<{ number: string; workspace_id: number }>("select number, workspace_id from contracts where id=$1", [contractId]);
  expect(c.workspace_id, "قرارداد باید در فضای کاری صادرکننده باشد").toBe(t.workspace_id);
  return { workspaceId: c.workspace_id, templateId: t.id, templateTitle, contractId, title, number: c.number, customerEmail };
}

/* ───────── بازپخش Server Action (حمله‌ی دست‌ساز بدون رابط) ───────── */

export type FormFields = [string, string][];

/** همه‌ی فیلدهای رشته‌ای یک فرم (شامل شناسه‌ی اکشن مخفی React/Next) */
export async function captureForm(form: Locator): Promise<FormFields> {
  await expect(form).toBeAttached();
  const fields = await form.evaluate((f) => Array.from(new FormData(f as HTMLFormElement).entries()).filter(([, v]) => typeof v === "string") as [string, string][]);
  if (!fields.some(([k]) => k.startsWith("$ACTION"))) {
    // پیش از هیدراسیون، React شناسه را در فیلد مخفی می‌گذارد؛ اگر در DOM نبود از HTML خام می‌خوانیم
    const html = await form.evaluate((f) => (f as HTMLFormElement).outerHTML);
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="(\$ACTION[^"]*)"[^>]*value="([^"]*)"/g)) fields.push([m[1], m[2]]);
  }
  expect(
    fields.some(([k]) => k.startsWith("$ACTION")),
    "شناسه‌ی Server Action در فرم پیدا نشد؛ بازپخش ممکن نیست",
  ).toBe(true);
  return fields;
}

/** فرم را با نشست «ctx» (و مقادیر دست‌کاری‌شده) ارسال می‌کند؛ کد وضعیت پاسخ را برمی‌گرداند */
export async function replayAction(ctx: BrowserContext, pageUrl: string, fields: FormFields, override: Record<string, string> = {}): Promise<number> {
  const body: Record<string, string> = {};
  for (const [k, v] of fields) body[k] = v;
  for (const [k, v] of Object.entries(override)) body[k] = v;
  const res = await ctx.request.post(new URL(pageUrl, BASE).toString(), { multipart: body, maxRedirects: 0, headers: { origin: BASE } });
  return res.status();
}

/* ───────── ادعاهای مشترک ───────── */

const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

/**
 * مسیر باید برای این کاربر «بسته» باشد: یا ریدایرکت به جای دیگر، یا 401/403/404؛
 * و هیچ‌یک از رشته‌های محرمانه در پاسخ نباشد.
 */
export async function expectBlocked(page: Page, to: string, opts: { secrets?: string[]; allowRedirectTo?: RegExp } = {}) {
  const res = await page.goto(to, { waitUntil: "domcontentloaded" });
  const status = res?.status() ?? 0;
  const requested = new URL(to, BASE);
  // redirect() داخل صفحه‌ی استریم‌شده به‌صورت ریدایرکت سمت کلاینت (meta/JS) می‌آید؛ تا نشستن مقصد صبر می‌کنیم
  if (status < 400) {
    await page
      .waitForURL((u) => u.pathname !== requested.pathname, { timeout: 8_000 })
      .catch(() => undefined);
    await page.waitForLoadState("domcontentloaded");
  }
  const finalPath = pathOf(page.url());
  const redirected = new URL(page.url()).pathname !== requested.pathname;
  // Next هنگام استریم، صفحه‌ی «۴۰۴» را گاهی با کد 200 می‌فرستد؛ پس نمایش صفحه‌ی ۴۰۴ هم «بسته» حساب می‌شود
  const notFoundShown = (await page.getByText("۴۰۴ — صفحه پیدا نشد").count()) > 0 || (await page.locator("meta[name=robots][content*=noindex]").count()) > 0 && (await page.getByText("۴۰۴").count()) > 0;
  expect(status >= 400 || redirected || notFoundShown, `«${to}» باید بسته باشد (status=${status}, final=${finalPath})`).toBe(true);
  if (redirected && opts.allowRedirectTo) expect(finalPath, `مقصد ریدایرکت «${to}»`).toMatch(opts.allowRedirectTo);
  const body = await page.content();
  for (const s of opts.secrets ?? []) expect(body, `نشت داده در «${to}»`).not.toContain(s);
}

/** پاسخ API باید یکی از کدهای رد باشد */
export async function expectApiDenied(ctx: BrowserContext, to: string, codes: number[] = [401, 403, 404], method: "GET" | "POST" | "PUT" | "DELETE" = "GET") {
  const res = await ctx.request.fetch(new URL(to, BASE).toString(), { method, maxRedirects: 0, headers: { origin: BASE } });
  expect(codes, `${method} ${to} → ${res.status()}`).toContain(res.status());
  return res;
}

export const hasNav = (page: Page, href: string) => page.locator(`a[href="${href}"]`);
