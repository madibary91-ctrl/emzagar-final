#!/usr/bin/env node
/**
 * تست دودی (Smoke) روی سرور در حال اجرا — بدون وابستگی.
 *   node scripts/smoke.mjs [آدرس]      (پیش‌فرض: http://127.0.0.1:3000)
 * خروجی: کد ۰ اگر همه‌ی بررسی‌ها موفق باشند.
 */
const BASE = (process.argv[2] || process.env.SMOKE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
let failed = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ✗ ${name}\n      ${e instanceof Error ? e.message : e}`);
  }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || "mismatch"}: انتظار ${b} ولی ${a}`); };
const get = (p, init) => fetch(BASE + p, { redirect: "manual", ...init });

// سامانه‌ی نصب‌نشده (دیتابیس بدون کاربر) همه‌ی صفحه‌ها را به /install می‌برد؛ در این حالت فقط بررسی‌های پیش از نصب اجرا می‌شود.
const probe = await get("/login");
if (probe.status === 307 && (probe.headers.get("location") || "").includes("/install")) {
  await check("سلامت: /api/health", async () => eq((await get("/api/health")).status, 200, "status"));
  await check("نصب‌کننده‌ی وب در دسترس است", async () => eq((await get("/install")).status, 200, "status"));
  console.log(`\nتست دودی روی ${BASE} (حالت «نصب‌نشده»)\n${results.join("\n")}\n\nبرای تست کامل، ابتدا نصب را تکمیل کنید و دوباره اجرا کنید.`);
  process.exit(failed ? 1 : 0);
}

await check("سلامت: /api/health", async () => {
  const r = await get("/api/health");
  eq(r.status, 200, "status");
});
for (const p of ["/login", "/register", "/forgot", "/verify", "/pricing"]) {
  await check(`صفحه‌ی عمومی ${p} باز می‌شود`, async () => {
    const r = await get(p);
    eq(r.status, 200, "status");
    if (!(r.headers.get("content-type") || "").includes("text/html")) throw new Error("HTML نیست");
  });
}
for (const p of ["/dashboard", "/admin", "/account", "/notifications", "/admin/renewals", "/contracts/1"]) {
  await check(`صفحه‌ی محافظت‌شده ${p} بدون ورود به /login هدایت می‌شود`, async () => {
    const r = await get(p);
    // Next با استریم، redirect() را گاهی به‌صورت 200 + <meta refresh> یا 307 برمی‌گرداند؛ هر دو یعنی هدایت به ورود
    if ([302, 303, 307, 308].includes(r.status)) {
      if (!(r.headers.get("location") || "").includes("/login")) throw new Error(`location=${r.headers.get("location")}`);
      return;
    }
    const html = await r.text();
    if (r.status !== 200 || !/http-equiv="refresh"[^>]*\/login/.test(html)) throw new Error(`status ${r.status} و بدون هدایت به /login`);
  });
}
for (const [m, p] of [["GET", "/api/notifications"], ["POST", "/api/notifications"], ["GET", "/api/account/export"], ["GET", "/api/contracts/1/pdf"], ["POST", "/api/contracts/1/attachments"], ["GET", "/api/contracts/1/amendments/1/pdf"]]) {
  await check(`API ${m} ${p} بدون ورود 401 می‌دهد`, async () => eq((await get(p, { method: m })).status, 401, "status"));
}
await check("لینک امضای نامعتبر: صفحه‌ی خطا (نه 500)", async () => {
  const r = await get(`/sign/${"a".repeat(43)}`);
  eq(r.status, 200, "status");
  if (!(await r.text()).includes("نامعتبر")) throw new Error("پیام نامعتبر نمایش داده نشد");
});
await check("لینک الحاقیه‌ی نامعتبر: صفحه‌ی خطا (نه 500)", async () => {
  const r = await get(`/amend/${"b".repeat(43)}`);
  eq(r.status, 200, "status");
  if (!(await r.text()).includes("نامعتبر")) throw new Error("پیام نامعتبر نمایش داده نشد");
});
await check("آپلود مهمان بدون نشست OTP رد می‌شود", async () => {
  eq((await get(`/api/sign/${"a".repeat(43)}/attachments`, { method: "POST", body: new FormData() })).status, 401, "status");
});
await check("استعلام اصالت با هش ناموجود: صفحه‌ی «یافت نشد»", async () => {
  const r = await get(`/verify/${"0".repeat(64)}`);
  eq(r.status, 200, "status");
});
await check("هدرهای امنیتی (nosniff، فریم‌بندی، بدون X-Powered-By)", async () => {
  const r = await get("/login");
  eq(r.headers.get("x-content-type-options"), "nosniff", "nosniff");
  eq(r.headers.get("x-frame-options"), "DENY", "xfo");
  if (r.headers.get("x-powered-by")) throw new Error("X-Powered-By نباید باشد");
});
await check("صفحه‌ی امضا کش نمی‌شود و ایندکس نمی‌شود", async () => {
  const r = await get(`/sign/${"a".repeat(43)}`);
  if (!(r.headers.get("cache-control") || "").includes("no-store")) throw new Error("no-store نیست");
  if (!(r.headers.get("x-robots-tag") || "").includes("noindex")) throw new Error("noindex نیست");
});
await check("مسیر ناموجود 404 می‌دهد", async () => eq((await get("/this-route-does-not-exist")).status, 404, "status"));

console.log(`\nتست دودی روی ${BASE}\n${results.join("\n")}\n\n${results.length - failed}/${results.length} موفق`);
process.exit(failed ? 1 : 0);
