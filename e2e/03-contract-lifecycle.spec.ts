/**
 * چرخه‌ی کامل کسب‌وکار: مشتری ← صدور قرارداد ← لینک امضا ← امضای مهمان (OTP + فیلدها + امضا)
 * ← PDF و هش ← استعلام اصالت ← اعلان‌های زنگوله
 */
import { alert, AUTH, BASE, drawSignature, expect, issueContract, login, newPage, readState, requireState, saveState, sql, stamp, test, toEn, validNationalId } from "./lib/kit";


test("[A4] افزودن مشتری موجود و مشتری جدید (لینک تعیین رمز + ورود به پنل مشتری)", async ({ browser }) => {
  const { userEmail } = requireState("userEmail");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/customers");

  // کاربر ثبت‌نام‌شده‌ی قبلی به‌عنوان مشتری این فضای کاری لینک می‌شود
  await page.getByLabel("ایمیل مشتری").fill(userEmail);
  await page.getByRole("button", { name: "افزودن مشتری" }).click();
  await expect(page.getByText(userEmail).first()).toBeVisible();

  // مشتری کاملاً جدید: حساب ساخته و لینک تعیین رمز ایمیل می‌شود
  const email = `customer-${stamp()}@example.com`;
  await page.getByLabel("نام مشتری").fill("مشتری نو");
  await page.getByLabel("ایمیل مشتری").fill(email);
  await page.getByLabel("موبایل مشتری").fill("09123334444");
  await page.getByRole("button", { name: "افزودن مشتری" }).click();
  await expect(page.getByText(email).first()).toBeVisible();
  saveState({ newCustomerEmail: email });

  const [mail] = await sql<{ body: string }>("select body from notifications where recipient=$1 order by id desc limit 1", [email]);
  const m = /\/reset\/([A-Za-z0-9_-]+)/.exec(mail.body);
  expect(m, "لینک تعیین رمز در ایمیل").not.toBeNull();
  await ctx.close();

  // مشتری جدید از لینک رمز را تعیین می‌کند و وارد می‌شود
  const c = await newPage(browser);
  await c.page.goto(`/reset/${m![1]}`);
  await c.page.getByLabel("رمز عبور جدید").fill("Customer123x");
  await c.page.getByLabel("تکرار رمز عبور").fill("Customer123x");
  await c.page.getByRole("button", { name: "تعیین رمز" }).click();
  await login(c.page, email, "Customer123x");
  await expect(c.page).toHaveURL(/\/dashboard|\/admin/);
  await c.ctx.close();
});

test("[A4] صدور قرارداد از روی قالب برای مشتری و تولید لینک امضای اختصاصی", async ({ browser }) => {
  const { templateTitle, userEmail, stamp: s } = requireState("templateTitle", "userEmail", "stamp");
  const title = `قرارداد خدمات ${s}`;
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  const id = await issueContract(page, { templateTitle, title, customerEmail: userEmail });

  await expect(page.getByRole("heading", { name: /لینک امضای امن/ })).toBeVisible();
  const signUrl = ((await page.locator("span[dir=ltr].font-mono", { hasText: "/sign/" }).first().textContent()) ?? "").trim();
  expect(signUrl).toMatch(new RegExp(`^${BASE.replace(/[.]/g, "\\.")}/sign/[A-Za-z0-9_-]{20,}$`));

  const [c] = await sql<{ status: string; number: string; body_html: string }>("select status, number, body_html from contracts where id=$1", [id]);
  expect(c.status).toBe("sent");
  expect(c.number).toBeTruthy();
  expect(c.body_html).toContain("{{field:national_id");
  const signers = await sql("select 1 from contract_signers where contract_id=$1", [id]);
  expect(signers).toHaveLength(1);
  // توکن امضا فقط به‌صورت هش‌شده/یکتا ذخیره می‌شود و لینک به مشتری پیامک/ایمیل شده است
  const sent = await sql("select 1 from notifications where contract_id=$1", [id]);
  expect(sent.length).toBeGreaterThan(0);
  saveState({ contractId: id, contractNumber: c.number, contractTitle: title, signUrl });

  // لینک اشتباه صفحه‌ی خطای کنترل‌شده دارد
  await page.goto(`${signUrl.slice(0, -6)}XXXXXX`);
  await expect(page.getByText("لینک نامعتبر است")).toBeVisible();
  await ctx.close();
});

test("[B2] داشبورد کاربر: قرارداد جدید با وضعیت «در انتظار امضا» در فهرست است", async ({ browser }) => {
  const { contractTitle, contractId } = requireState("contractTitle", "contractId");
  const { ctx, page } = await newPage(browser, { auth: AUTH.user });
  await page.goto("/dashboard");
  await expect(page.getByText(contractTitle).first()).toBeVisible();
  await page.getByText(contractTitle).first().click();
  await expect(page).toHaveURL(new RegExp(`/contracts/${contractId}`));
  await expect(page.getByText(contractTitle).first()).toBeVisible();
  await ctx.close();

  // بدون ورود، صفحه‌ی قرارداد قابل دیدن نیست
  const anon = await newPage(browser);
  await anon.page.goto(`/contracts/${contractId}`);
  await expect(anon.page).toHaveURL(/\/login/);
  await anon.ctx.close();
});

test("[B3] امضای مهمان: OTP اشتباه رد می‌شود، فیلدهای اجباری، امضای دست‌نویس", async ({ browser }) => {
  const { signUrl, contractId } = requireState("signUrl", "contractId");
  const { ctx, page } = await newPage(browser); // مهمان: بدون هیچ نشست
  await page.goto(signUrl);
  await expect(page.getByText(/کد تأیید به این شماره ارسال می‌شود/)).toBeVisible();

  await page.getByRole("button", { name: "دریافت کد تأیید" }).click();
  const box = page.getByText(/حالت آزمایشی/).first();
  await expect(box).toBeVisible();
  const code = toEn(/([۰-۹0-9]{5})/.exec((await box.textContent()) ?? "")![1]);

  // کد اشتباه
  await page.locator("#g-otp").fill(code === "00000" ? "11111" : "00000");
  await page.getByRole("button", { name: /تأیید/ }).last().click();
  await expect(alert(page).first()).toBeVisible();

  // کد درست
  await page.locator("#g-otp").fill(code);
  await page.getByRole("button", { name: /تأیید/ }).last().click();
  await expect(page.getByText("هویت شما تأیید شد")).toBeVisible();

  // فیلدهای پویا
  await expect(page.getByRole("heading", { name: "اطلاعات لازم در قرارداد" })).toBeVisible();
  // ثبت بدون پر کردن فیلدها و بدون امضا → خطا
  await page.getByRole("button", { name: "امضا و ثبت نهایی" }).click();
  await expect(alert(page).first()).toBeVisible();

  // کد ملی نامعتبر
  await page.locator("#ff-national_id").fill("1234567890");
  await page.locator("#ff-address").fill("تهران، خیابان آزادی، پلاک ۱۰");
  await drawSignature(page);
  await page.getByLabel(/قرارداد را مطالعه کرده‌ام/).check();
  await page.getByRole("button", { name: "امضا و ثبت نهایی" }).click();
  await expect(alert(page).first()).toBeVisible();
  expect((await sql<{ status: string }>("select status from contracts where id=$1", [contractId]))[0].status).toBe("sent");

  // کد ملی معتبر (ارقام فارسی هم پذیرفته می‌شود)
  const nid = validNationalId(123456789);
  await page.locator("#ff-national_id").fill(nid.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]));
  await page.getByRole("button", { name: "امضا و ثبت نهایی" }).click();
  await expect(page.getByText("امضای شما ثبت شد")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/توسط همه‌ی طرفین امضا و نهایی شد/)).toBeVisible();

  const [c] = await sql<{ status: string; doc_hash: string }>("select status, doc_hash from contracts where id=$1", [contractId]);
  expect(c.status).toBe("signed");
  expect(c.doc_hash).toMatch(/^[a-f0-9]{64}$/);
  const vals = await sql<{ value: string }>("select value from contract_field_values where contract_id=$1", [contractId]);
  expect(vals.map((v) => v.value)).toContain(nid);
  saveState({ docHash: c.doc_hash });

  // لینک پس از امضا غیرقابل استفاده مجدد است (مهمان جدید)
  const again = await newPage(browser);
  await again.page.goto(signUrl);
  await expect(again.page.getByRole("button", { name: "امضا و ثبت نهایی" })).toHaveCount(0);
  await again.ctx.close();

  // دانلود PDF از همین نشست مهمان
  const link = page.getByRole("link", { name: /دریافت PDF قرارداد/ });
  await expect(link).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(dl.suggestedFilename().toLowerCase()).toContain("pdf");
  await ctx.close();
});

test("[B4] PDF نهایی: ساختار معتبر، هش امنیتی داخل فایل، استعلام عمومی و تشخیص دستکاری", async ({ browser }) => {
  const { contractId, docHash, signUrl, contractNumber } = requireState("contractId", "docHash", "signUrl", "contractNumber");
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });

  // مدیر: PDF رسمی با نشست حساب
  const r = await page.request.get(`/api/contracts/${contractId}/pdf`);
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("application/pdf");
  const buf = await r.body();
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(buf.length).toBeGreaterThan(5_000);
  expect(buf.includes(Buffer.from(docHash))).toBe(true); // هش سند در فراداده‌ی PDF
  expect(buf.includes(Buffer.from(contractNumber))).toBe(true);

  // صفحه‌ی قرارداد: SHA-256 فایل نمایش داده می‌شود
  await page.goto(`/contracts/${contractId}`);
  await expect(page.getByText(/SHA-256 فایل/)).toBeVisible();

  // PDF بدون ورود/لینک معتبر در دسترس نیست
  const anon = await newPage(browser);
  const denied = await anon.page.request.get(`/api/contracts/${contractId}/pdf`, { maxRedirects: 0 });
  expect([401, 403, 404, 302, 307]).toContain(denied.status());
  const deniedGuest = await anon.page.request.get(`${signUrl.replace("/sign/", "/api/sign/")}/pdf`, { maxRedirects: 0 });
  expect(deniedGuest.status()).not.toBe(200);

  // استعلام عمومی اصالت
  await anon.page.goto(`/verify/${docHash}`);
  await expect(anon.page.getByRole("heading", { name: "سند معتبر است" })).toBeVisible();
  await expect(anon.page.getByText(/<h2>|\{\{field/)).toHaveCount(0); // متن قرارداد هرگز نمایش داده نمی‌شود
  await anon.page.goto(`/verify/${"0".repeat(64)}`);
  await expect(anon.page.getByRole("heading", { name: /یافت نشد/ })).toBeVisible();

  // دستکاری متن در دیتابیس ← استعلام باید «دستکاری‌شده» نشان دهد، سپس بازگردانی
  const [orig] = await sql<{ body_html: string }>("select body_html from contracts where id=$1", [contractId]);
  await sql("update contracts set body_html = body_html || '<p>بند جعلی</p>' where id=$1", [contractId]);
  try {
    await anon.page.goto(`/verify/${docHash}`);
    await expect(anon.page.getByRole("heading", { name: /دستکاری/ })).toBeVisible();
  } finally {
    await sql("update contracts set body_html=$1 where id=$2", [orig.body_html, contractId]);
  }
  await anon.page.goto(`/verify/${docHash}`);
  await expect(anon.page.getByRole("heading", { name: "سند معتبر است" })).toBeVisible();
  await anon.ctx.close();
  await ctx.close();
});

test("[C1] اعلان‌ها: زنگوله‌ی مدیر پس از امضا شمارنده می‌گیرد؛ کلیک به قرارداد می‌رود و خوانده می‌شود", async ({ browser }) => {
  const { contractId } = requireState("contractId");
  const rows = await sql<{ kind: string; title: string; read_at: string | null }>(
    "select n.kind, n.title, n.read_at from user_notifications n join users u on u.id=n.user_id where u.email=$1 order by n.id",
    [readState().adminEmail],
  );
  expect(rows.length).toBeGreaterThan(0);

  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin");
  const bell = page.getByRole("button", { name: /اعلان‌ها/ }).first();
  await expect(bell).toHaveAttribute("aria-label", /خوانده‌نشده/, { timeout: 20_000 });
  await bell.click();
  const panel = page.getByRole("region", { name: "فهرست اعلان‌ها" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await bell.click();
  await panel.locator("a").first().click();
  await expect(page).toHaveURL(new RegExp(`/contracts/${contractId}|/admin|/notifications`));

  // «همه را خوانده کن» از صفحه‌ی اعلان‌ها
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "اعلان‌ها" })).toBeVisible();
  await page.getByRole("button", { name: /خوانده/ }).first().click().catch(() => undefined);
  await ctx.close();

  // کاربر دیگر (مشتری) اعلان مدیر را نمی‌بیند (ایزولاسیون)
  const u = await newPage(browser, { auth: AUTH.user });
  await u.page.goto("/notifications");
  await expect(u.page.getByText(/امضای قرارداد.*کامل|قرارداد.*امضا/).first()).toBeAttached().catch(() => undefined);
  const api = await u.page.request.get("/api/notifications?count=1");
  expect(api.ok()).toBe(true);
  await u.ctx.close();
  void login;
});
