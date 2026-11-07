/**
 * جعبه‌ابزار مشترک آزمون‌های مرورگری امضاگیر.
 * - زمینه‌ی مرورگر (BrowserContext) با IP یکتا برای محدودیت نرخ
 * - نگهبان خودکار: هر استثنای JS در مرورگر یا پاسخ ۵xx سرور، آزمون را شکست می‌دهد
 * - دسترسی مستقیم (فقط‌خواندنی/آماده‌سازی) به دیتابیس آزمایشی برای تأیید نتیجه‌ی واقعی کارها
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";

export const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
export const DB_URL = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/emz_e2e";
export const STORAGE = process.env.E2E_STORAGE_DIR ?? path.resolve(".e2e-storage");
export const CRON_SECRET = process.env.CRON_SECRET ?? "e2e-cron-secret-0123456789";
export const REPORT_DIR = path.resolve("e2e/report");
const STATE_DIR = path.resolve("e2e/.state");
const STATE_FILE = path.join(STATE_DIR, "state.json");

/* ───────── دیتابیس ───────── */
let pool: Pool | undefined;
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  pool ??= new Pool({ connectionString: DB_URL, max: 2 });
  return (await pool.query(text, params)).rows as T[];
}

/* ───────── وضعیت مشترک بین فایل‌های آزمون (داستان یک‌پارچه) ───────── */
export type State = Partial<{
  stamp: string;
  adminEmail: string; adminPass: string; adminName: string; workspace: string;
  userEmail: string; userPass: string; userName: string; userMobile: string; userNewPass: string;
  templateTitle: string; contractId: number; contractNumber: string; signUrl: string; docHash: string;
  contractTitle: string; ticketId: number; ticketSubject: string; newCustomerEmail: string;
}>;
export function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}
export function saveState(patch: State): State {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}
export function requireState<K extends keyof State>(...keys: K[]): Required<Pick<State, K>> {
  const s = readState();
  for (const k of keys) if (s[k] === undefined) throw new Error(`وضعیت «${String(k)}» ساخته نشده؛ آزمون‌های قبلی را اجرا کنید (npm run e2e).`);
  return s as Required<Pick<State, K>>;
}
export const AUTH = {
  admin: path.join(STATE_DIR, "admin-auth.json"),
  user: path.join(STATE_DIR, "user-auth.json"),
};

/* ───────── نگهبان خطاهای مرورگر/سرور ───────── */
const crashes: string[] = [];
const serverErrors: string[] = [];
export const allowServerErrors = { value: false };

function guard(page: Page) {
  page.on("pageerror", (e) => crashes.push(`${page.url()} → ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 500 && !allowServerErrors.value) serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
}

export const test = base.extend<{ guard: void }>({
  guard: [
    async ({}, use) => {
      crashes.length = 0;
      serverErrors.length = 0;
      allowServerErrors.value = false;
      await use();
      expect(crashes, "استثنای جاوااسکریپت در مرورگر").toEqual([]);
      expect(serverErrors, "پاسخ خطای ۵xx از سرور").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/* ───────── زمینه‌ی مرورگر ───────── */
let ctxSeq = 0;
const ipBase = 20 + (process.pid % 200);
export type Device = "desktop" | "tablet" | "mobile";
export const VIEWPORTS: Record<Device, { width: number; height: number; isMobile: boolean; hasTouch: boolean }> = {
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  tablet: { width: 768, height: 1024, isMobile: false, hasTouch: true },
  mobile: { width: 360, height: 740, isMobile: true, hasTouch: true },
};

export async function newContext(browser: Browser, opts: { auth?: string; device?: Device } = {}): Promise<BrowserContext> {
  const n = ++ctxSeq;
  const vp = VIEWPORTS[opts.device ?? "desktop"];
  const ctx = await browser.newContext({
    baseURL: BASE,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    storageState: opts.auth && fs.existsSync(opts.auth) ? opts.auth : undefined,
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    acceptDownloads: true,
    extraHTTPHeaders: { "x-forwarded-for": `10.${ipBase}.${Math.floor(n / 250)}.${(n % 250) + 1}` },
  });
  ctx.on("page", guard);
  return ctx;
}

export async function newPage(browser: Browser, opts: { auth?: string; device?: Device } = {}) {
  const ctx = await newContext(browser, opts);
  const page = await ctx.newPage();
  return { ctx, page };
}

/* ───────── ابزارهای متنی ───────── */
const FA = "۰۱۲۳۴۵۶۷۸۹";
export const toEn = (s: string) => s.replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)));
export const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);

/** کد ملی معتبر (الگوریتم رسمی) */
export function validNationalId(seed = Math.floor(Math.random() * 1e9)): string {
  const d = String(seed % 1_000_000_000).padStart(9, "0").split("").map(Number);
  if (new Set(d).size === 1) d[8] = (d[8] + 1) % 10;
  const sum = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
  const c = sum < 2 ? sum : 11 - sum;
  return d.join("") + c;
}

/** PNG معتبر برای بارگذاری لوگو/امضا */
export function makePng(w = 64, h = 64): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = x % 4 === 3 ? 255 : (x * 7 + y * 13) & 255;
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ───────── کنش‌های رابط کاربری ───────── */
export async function register(page: Page, v: { workspaceName: string; name: string; email: string; mobile: string; password: string }) {
  await page.goto("/register");
  await page.getByLabel("نام کسب‌وکار / فروشگاه").fill(v.workspaceName);
  await page.getByLabel("نام و نام خانوادگی شما").fill(v.name);
  await page.getByLabel("ایمیل", { exact: true }).fill(v.email);
  await page.getByLabel("موبایل").fill(v.mobile);
  await page.getByLabel("رمز عبور").fill(v.password);
  await page.getByRole("button", { name: "ساخت فضای کاری" }).click();
  await page.waitForURL(/\/verify-email/);
}

/** در حالت آزمایشی کد در صفحه نمایش داده می‌شود (همان کدی که ایمیل می‌شد) */
export async function readDevCode(page: Page, pattern: RegExp = /کد شما\s*([۰-۹0-9]{5,6})/): Promise<string> {
  const box = page.getByText(/حالت آزمایشی/).first();
  await expect(box).toBeVisible();
  const m = pattern.exec((await box.textContent()) ?? "");
  if (!m) throw new Error("کد آزمایشی در صفحه پیدا نشد");
  return toEn(m[1]);
}

export async function confirmEmail(page: Page) {
  const code = await readDevCode(page);
  await page.locator("#code").fill(code);
  await page.getByRole("button", { name: "تأیید ایمیل و ورود" }).click();
  await page.waitForURL((u) => !/\/verify-email/.test(u.pathname));
}

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "ورود", exact: true }).click();
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "خروج از حساب" }).click();
  await page.waitForURL(/\/login|\/$/);
}

export async function pickCustomer(page: Page, email: string) {
  await page.getByPlaceholder("جستجوی کاربر…").fill(email);
  const row = page.locator("label", { hasText: email }).first();
  await expect(row).toBeVisible();
  await row.locator("input[type=checkbox]").check();
}

/** صدور قرارداد از روی قالب برای یک مشتری؛ شناسه‌ی قرارداد ساخته‌شده را برمی‌گرداند */
export async function issueContract(page: Page, v: { templateTitle: string; title: string; customerEmail: string; expiryDays?: number }): Promise<number> {
  await page.goto("/admin/new");
  await page.locator("select[name=templateId]").selectOption({ label: v.templateTitle });
  await page.locator("input[name=title]").fill(v.title);
  await pickCustomer(page, v.customerEmail);
  if (v.expiryDays !== undefined) await page.locator("input[name=expiryDays]").fill(String(v.expiryDays));
  await page.locator("button[name=intent][value=issue]").click();
  await page.waitForURL(/\/contracts\/\d+/, { timeout: 30_000 });
  return Number(/\/contracts\/(\d+)/.exec(page.url())![1]);
}

/** رسم امضا روی بوم با ماوس واقعی (رویدادهای pointer) */
export async function drawSignature(page: Page) {
  const canvas = page.locator("canvas.signature-canvas").first();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const p = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const pts = [p(0.15, 0.6), p(0.25, 0.3), p(0.35, 0.7), p(0.5, 0.35), p(0.65, 0.65), p(0.8, 0.4)];
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const pt of pts.slice(1)) await page.mouse.move(pt.x, pt.y, { steps: 6 });
  await page.mouse.up();
}

/** آیا صفحه اسکرول افقی دارد؟ و کدام عنصرها از لبه‌ی دید بیرون زده‌اند؟ (جهت RTL هم درست سنجیده می‌شود) */
export async function horizontalOverflow(page: Page): Promise<{ overflow: number; offenders: string[] }> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const overflow = Math.max(0, document.documentElement.scrollWidth - vw);
    const bad: string[] = [];
    if (overflow > 1) {
      // وقتی صفحه سرریز دارد، مرورگر محتوا را به اندازه‌ی scrollX جابه‌جا می‌کند؛ لبه‌ی واقعی دید [shift, shift+vw] است
      const shift = Math.max(0, -window.scrollX);
      const inScroller = (el: Element) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
        }
        return false;
      };
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const outside = shift > 0 ? r.left < shift - overflow + 0.5 || r.right > shift + vw + 1 : r.right > vw + 1 || r.left < -1;
        if (outside && !inScroller(el)) {
          const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className.split(" ").slice(0, 3).join(".") : "";
          bad.push(`${el.tagName.toLowerCase()}${cls ? "." + cls : ""} [${Math.round(r.left)}→${Math.round(r.right)}]`);
          if (bad.length >= 6) break;
        }
      }
    }
    return { overflow, offenders: bad };
  });
}

/** هشدارهای واقعی صفحه (بدون «اعلام‌کننده‌ی مسیر» داخلی Next.js که آن هم role=alert دارد) */
export const alert = (page: Page) => page.locator('[role=alert]:not([id="__next-route-announcer__"])');

export function fileExists(...p: string[]) {
  return fs.existsSync(path.join(...p));
}
