/**
 * حافظه‌ی حقوقی (شخصی‌سازی هوش مصنوعی): آپلود واقعی در مرورگر، مدیریت اسناد، اثر در دستیار نگارش، ریسپانسیو
 * سرویس AI به‌وسیله‌ی شبیه‌ساز پاسخ می‌دهد (هیچ تماس واقعی انجام نمی‌شود).
 */
import { AUTH, alert, expect, horizontalOverflow, newPage, sql, test } from "./lib/kit";

const WEB_DOC = `ماده ۱ — طراحی و توسعه وب‌سایت
مجری (کارفرما) متعهد می‌شود وب‌سایت فروشگاهی را در سه مرحله تحویل دهد و سه ماه پشتیبانی رایگان ارائه کند. شماره تماس مجری ۰۹۱۲۳۴۵۶۷۸۹ و ایمیل info@acme-e2e.ir است.
ماده ۲ — پرداخت
مبلغ قرارداد در سه قسط پرداخت می‌شود و تأخیر بیش از ده روز مشمول جریمه است.
ماده ۳ — فسخ
هر طرف می‌تواند با اخطار کتبی ده روزه قرارداد را فسخ کند و اطلاعات محرمانه افشا نمی‌شود.`;

const POLICY = `قانون ۱: سقف جریمه‌ی تأخیر هرگز نباید بیش از ۱۰ درصد مبلغ قرارداد باشد.
قانون ۲: حل اختلاف فقط از طریق داوری مرکز داوری تهران انجام می‌شود و مدت ضمانت حداقل شش ماه است.`;

test.describe.configure({ mode: "serial" });

test("[K1] حافظه‌ی حقوقی: صفحه در منو، خالی بودن اولیه و دسترسی ناشناس ممنوع", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin");
  await page.getByRole("link", { name: /حافظه‌ی حقوقی/ }).first().click();
  await page.waitForURL(/\/admin\/knowledge/);
  await expect(page.getByRole("heading", { name: "حافظه‌ی حقوقی" })).toBeVisible();
  await expect(page.getByTestId("kb-empty")).toBeVisible();
  expect(await page.content()).not.toMatch(/passwordHash|password_hash/);
  await ctx.close();

  const anon = await newPage(browser, {});
  await anon.page.goto("/admin/knowledge");
  await expect(anon.page).toHaveURL(/\/login/);
  const r = await anon.page.request.post("/api/ai/knowledge", { multipart: { files: { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from(WEB_DOC) } } });
  expect(r.status()).toBe(403);
  await anon.ctx.close();
});

test("[K2] آپلود فایل واقعی: TXT موفق با حذف اطلاعات حساس، EXE و PDF رد", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/knowledge");
  await page.locator("#up-kind").selectOption("sample");
  await page.getByTestId("kb-file").setInputFiles([
    { name: "قرارداد-طراحی-سایت.txt", mimeType: "text/plain", buffer: Buffer.from(WEB_DOC, "utf8") },
    { name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ\u0090\u0000") },
    { name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 fake") },
  ]);
  const results = page.getByTestId("kb-upload-results");
  await expect(results).toContainText("قرارداد-طراحی-سایت.txt");
  await expect(results).toContainText("اطلاعات حساس حذف شد");
  await expect(results).toContainText("PDF");
  await expect(page.getByTestId("kb-doc")).toHaveCount(1);
  await expect(page.getByTestId("kb-fingerprint")).toBeVisible();

  const [row] = await sql<{ content: string; redactions: number; kind: string }>("select content, redactions, kind from ai_knowledge_docs where title = $1", ["قرارداد-طراحی-سایت"]);
  expect(row.redactions).toBe(2);
  expect(row.content).not.toMatch(/info@acme-e2e|09123456789|۰۹۱۲۳۴۵۶۷۸۹/);
  expect(row.kind).toBe("sample");

  // پیش‌نمایش نشان می‌دهد متن ذخیره‌شده پاک‌سازی شده است
  await page.getByRole("button", { name: /مشاهده قرارداد-طراحی-سایت/ }).click();
  await expect(page.getByTestId("kb-preview")).toContainText("طراحی و توسعه وب‌سایت");
  await expect(page.getByTestId("kb-preview")).not.toContainText("info@acme-e2e");
  await ctx.close();
});

test("[K3] چسباندن قوانین شرکت، دستورالعمل دائمی، غیرفعال/فعال و حذف", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/knowledge");
  await page.getByRole("tab", { name: "چسباندن متن" }).click();
  await page.locator("#p-title").fill("قوانین داخلی شرکت");
  await page.locator("#p-kind").selectOption("policy");
  await page.locator("#p-text").fill(POLICY);
  await page.getByRole("button", { name: "افزودن به حافظه" }).click();
  await expect(page.getByText("سند به حافظه افزوده شد.")).toBeVisible();
  await expect(page.getByTestId("kb-doc")).toHaveCount(2);

  // متن کوتاه → خطا
  await page.locator("#p-title").fill("کوتاه");
  await page.locator("#p-text").fill("x".repeat(80).slice(0, 79));
  // minLength مرورگر مانع ارسال می‌شود؛ فیلد باید نامعتبر باشد
  expect(await page.locator("#p-text").evaluate((el: HTMLTextAreaElement) => el.validity.tooShort || !el.checkValidity())).toBe(true);

  // دستورالعمل دائمی
  await page.locator("#kb-instr").fill("طرف اول را همیشه «کارفرما» بنامید.");
  await page.getByRole("button", { name: "ذخیره‌ی دستورالعمل" }).click();
  await expect(page.getByText("تنظیمات ذخیره شد.").first()).toBeVisible();
  const [st] = await sql<{ instructions: string; enabled: boolean }>("select instructions, enabled from ai_personalization order by workspace_id desc limit 1");
  expect(st.instructions).toContain("کارفرما");
  expect(st.enabled).toBe(true);

  // غیرفعال‌کردن یک سند و بازگرداندن
  const first = page.getByTestId("kb-doc").first();
  await first.getByRole("switch").click();
  await expect(first.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await first.getByRole("switch").click();
  await expect(first.getByRole("switch")).toHaveAttribute("aria-checked", "true");

  // تغییر نوع سند
  await first.getByRole("combobox").selectOption("clauses");
  await expect.poll(async () => (await sql<{ n: number }>("select count(*)::int n from ai_knowledge_docs where kind='clauses'"))[0].n).toBe(1);
  await first.getByRole("combobox").selectOption("sample");

  // حذف یک سند اضافه (با تأیید مرورگر)
  await page.getByRole("tab", { name: "چسباندن متن" }).click();
  await page.locator("#p-title").fill("موقت");
  await page.locator("#p-text").fill("این سند موقتی است و باید حذف شود. ".repeat(6));
  await page.getByRole("button", { name: "افزودن به حافظه" }).click();
  await expect(page.getByTestId("kb-doc")).toHaveCount(3);
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: /حذف موقت/ }).click();
  await expect(page.getByTestId("kb-doc")).toHaveCount(2);
  await ctx.close();
});

test("[K4] وارد کردن قالب‌ها/قراردادهای سامانه به حافظه", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/knowledge");
  await page.getByRole("tab", { name: "از قراردادهای من" }).click();
  await page.getByRole("button", { name: "قالب‌ها" }).click();
  const boxes = page.locator('input[name="ids"]');
  const n = await boxes.count();
  test.skip(n === 0, "قالبی در سامانه نیست");
  await boxes.first().check();
  await page.getByRole("button", { name: "افزودن موارد انتخاب‌شده" }).click();
  await expect(alert(page).or(page.getByRole("status")).first()).toBeVisible();
  await ctx.close();
});

test("[K5] دستیار نگارش در ویرایشگر قالب: کلید حافظه، تولید با شبیه‌ساز و نمایش منابع", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  const calls: string[] = [];
  page.on("request", (r) => r.url().includes("/api/ai/contract") && r.method() === "POST" && calls.push(r.postData() ?? ""));
  await page.goto("/admin/templates/new");
  await page.getByRole("button", { name: /نوشتن با هوش مصنوعی/ }).click();
  const dialog = page.getByRole("dialog", { name: "دستیار هوش مصنوعی" });
  await expect(dialog).toBeVisible();
  const toggle = dialog.getByTestId("ai-memory-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText("با حافظه‌ی حقوقی من بنویس");
  await expect(toggle.locator("input")).toBeChecked();

  await dialog.locator("#ai-prompt").fill("قرارداد طراحی سایت فروشگاهی با پشتیبانی سه ماهه و جریمه تأخیر");
  await dialog.getByRole("button", { name: "تولید متن" }).click();
  await expect(dialog.getByTestId("ai-sources")).toBeVisible({ timeout: 90_000 });
  await expect(dialog.getByTestId("ai-sources")).toContainText("قرارداد-طراحی-سایت");
  expect(JSON.parse(calls[0]).personalize).toBe(true);
  const [g] = await sql<{ prompt: string }>("select prompt from ai_generations order by id desc limit 1");
  expect(g.prompt.startsWith("[حافظه]")).toBe(true);

  // خاموش‌کردن کلید → درخواست بعدی بدون حافظه
  await toggle.locator("input").uncheck();
  await dialog.getByRole("button", { name: "تولید دوباره" }).click();
  await expect.poll(() => calls.length, { timeout: 90_000 }).toBe(2);
  expect(JSON.parse(calls[1]).personalize).toBe(false);
  await expect(dialog.getByTestId("ai-sources")).toHaveCount(0, { timeout: 90_000 });
  await ctx.close();
});

test("[K6] یادگیری شناسنامه‌ی نگارش با AI (شبیه‌ساز) و نمایش آن", async ({ browser }) => {
  const { ctx, page } = await newPage(browser, { auth: AUTH.admin });
  await page.goto("/admin/knowledge");
  const learn = page.getByTestId("kb-learn");
  await expect(learn).toBeEnabled();
  await learn.click();
  await expect(page.getByTestId("kb-profile")).toBeVisible({ timeout: 90_000 });
  const [p] = await sql<{ style_profile: string; profile_doc_count: number }>("select style_profile, profile_doc_count from ai_personalization order by workspace_id desc limit 1");
  expect(p.style_profile.length).toBeGreaterThan(50);
  expect(p.profile_doc_count).toBeGreaterThan(0);
  await ctx.close();
});

test("[K7] ریسپانسیو و دسترس‌پذیری: بدون اسکرول افقی در ۳ اندازه، فرم‌ها برچسب دارند", async ({ browser }) => {
  for (const device of ["mobile", "tablet", "desktop"] as const) {
    const { ctx, page } = await newPage(browser, { auth: AUTH.admin, device });
    await page.goto("/admin/knowledge");
    await expect(page.getByRole("heading", { name: "حافظه‌ی حقوقی" })).toBeVisible();
    const o = await horizontalOverflow(page);
    expect(o.overflow, `${device}: ${o.offenders.join(" | ")}`).toBeLessThanOrEqual(1);
    const unlabeled = await page.evaluate(() =>
      [...document.querySelectorAll("main input:not([type=hidden]):not(.sr-only), main select, main textarea")].filter((el) => {
        const e = el as HTMLInputElement;
        return !(e.labels && e.labels.length) && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby");
      }).map((el) => (el as HTMLInputElement).name || el.id),
    );
    expect(unlabeled, `${device}: فیلد بدون برچسب`).toEqual([]);
    await ctx.close();
  }
});
