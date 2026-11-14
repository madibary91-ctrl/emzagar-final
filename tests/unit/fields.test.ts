import { describe, expect, it } from "vitest";
import { defsForSigner, parseFieldDefs, renderFieldTokens, toEnDigits, validateFieldValue } from "@/modules/fields";
import { amendmentFingerprint, docFingerprint } from "@/modules/signing/fingerprint";
import { sniffMime, cleanFileName } from "@/modules/attachments/service";
import { renewalState, termEndFor } from "@/modules/renewals/service";
import { textToHtml } from "@/modules/amendments/service";
import { describeUserAgent } from "@/modules/auth/session";

describe("فیلدهای قابل‌پرکردن: تجزیه‌ی توکن", () => {
  it("توکن‌های معتبر را با پیش‌فرض‌ها می‌خواند و تکراری/نامعتبر را حذف می‌کند", () => {
    const defs = parseFieldDefs("<p>{{field:national_id|کد ملی|nid}} و {{field:addr|نشانی|address|opt|1}} {{field:national_id|دوباره|text}} {{field:Bad Key|x}} {{field:x}}</p>");
    expect(defs.map((d) => d.key)).toEqual(["national_id", "addr", "x"]);
    expect(defs[0]).toMatchObject({ type: "nid", required: true, signerPos: null, label: "کد ملی" });
    expect(defs[1]).toMatchObject({ type: "address", required: false, signerPos: 1 });
    expect(defs[2]).toMatchObject({ type: "text", label: "x" });
  });
  it("انتساب به امضاکننده: پیش‌فرض نفر آخر؛ شماره‌ی ناموجود هم به نفر آخر می‌رود", () => {
    const defs = parseFieldDefs("{{field:a|الف|text|req|1}} {{field:b|ب}} {{field:c|ج|text|req|9}}");
    expect(defsForSigner(defs, [1, 2], 1).map((d) => d.key)).toEqual(["a"]);
    expect(defsForSigner(defs, [1, 2], 2).map((d) => d.key)).toEqual(["b", "c"]);
  });
});

describe("فیلدهای قابل‌پرکردن: اعتبارسنجی", () => {
  const nid = { type: "nid" as const, label: "کد ملی", required: true };
  it("کد ملی: چک‌سام، ارقام فارسی، یکسان‌ها", () => {
    expect(validateFieldValue(nid, "0013542419")).toEqual({ ok: true, value: "0013542419" });
    expect(validateFieldValue(nid, "۰۰۱۳۵۴۲۴۱۹")).toEqual({ ok: true, value: "0013542419" });
    expect(validateFieldValue(nid, "0013542418").ok).toBe(false);
    expect(validateFieldValue(nid, "1111111111").ok).toBe(false);
    expect(validateFieldValue(nid, "123").ok).toBe(false);
    expect(validateFieldValue(nid, "").ok).toBe(false);
  });
  it("تاریخ شمسی نرمال می‌شود و ماه/روز نامعتبر رد می‌شود", () => {
    const d = { type: "date" as const, label: "تاریخ", required: true };
    expect(validateFieldValue(d, "۱۴۰۵/۲/۵")).toEqual({ ok: true, value: "1405/02/05" });
    expect(validateFieldValue(d, "1405-12-30")).toEqual({ ok: true, value: "1405/12/30" });
    expect(validateFieldValue(d, "1405/13/01").ok).toBe(false);
    expect(validateFieldValue(d, "1405/07/31").ok).toBe(false);
    expect(validateFieldValue(d, "2024/01/01").ok).toBe(false);
  });
  it("تلفن، عدد، ایمیل، نشانی، متن و اختیاری‌بودن", () => {
    expect(validateFieldValue({ type: "phone", label: "ت", required: true }, "۰۲۱-۸۸۸۸۸۸۸۸")).toEqual({ ok: true, value: "02188888888" });
    expect(validateFieldValue({ type: "number", label: "ع", required: true }, "۱٬۲۰۰٬۰۰۰")).toEqual({ ok: true, value: "1200000" });
    expect(validateFieldValue({ type: "number", label: "ع", required: true }, "12a").ok).toBe(false);
    expect(validateFieldValue({ type: "email", label: "ا", required: true }, "A@Ex.com")).toEqual({ ok: true, value: "a@ex.com" });
    expect(validateFieldValue({ type: "address", label: "ن", required: true }, "کوتاه").ok).toBe(false);
    expect(validateFieldValue({ type: "text", label: "م", required: true }, "x".repeat(201)).ok).toBe(false);
    expect(validateFieldValue({ type: "text", label: "م", required: false }, "   ")).toEqual({ ok: true, value: "" });
  });
  it("نویسه‌های کنترلی حذف می‌شوند", () => {
    expect(validateFieldValue({ type: "text", label: "م", required: true }, "a\u0000b\u202ec\n\nd")).toEqual({ ok: true, value: "a b c d" });
  });
  it("toEnDigits ارقام فارسی و عربی را تبدیل می‌کند", () => expect(toEnDigits("۱۲٣٤x")).toBe("1234x"));
});

describe("جایگزینی توکن‌ها (امنیت XSS)", () => {
  it("مقدار escape می‌شود و جای خالی با عنوان نمایش داده می‌شود", () => {
    const html = "<p>کد ملی: {{field:nid|کد ملی|nid}} — {{field:addr|نشانی|address}}</p>";
    const web = renderFieldTokens(html, new Map([["addr", `<img src=x onerror=alert(1)>"`]]), "web");
    expect(web).not.toContain("<img");
    expect(web).toContain("&lt;img");
    expect(web).toContain("amz-field-blank");
    expect(web).toContain("amz-field-filled");
    const pdf = renderFieldTokens(html, new Map([["nid", "0013542419"]]), "pdf");
    expect(pdf).toContain("<strong>0013542419</strong>");
    expect(pdf).toContain("نشانی: ……");
  });
  it("توکن نامعتبر دست‌نخورده می‌ماند", () => expect(renderFieldTokens("{{field:Bad Key}}", new Map())).toBe("{{field:Bad Key}}"));
});

describe("اثر انگشت سند", () => {
  const signers = [{ userId: 1, signedAt: new Date("2025-01-01T00:00:00Z"), ip: "1.1.1.1" }];
  it("بدون فیلد دقیقاً فرمول قدیمی است (سازگاری با اسناد قبلی)", () => {
    expect(docFingerprint("<p>x</p>", signers, [])).toBe(docFingerprint("<p>x</p>", signers));
  });
  it("مقدار فیلد در هش اثر دارد و ترتیب مهم نیست", () => {
    const a = docFingerprint("<p>x</p>", signers, [{ key: "a", value: "1" }, { key: "b", value: "2" }]);
    expect(a).toBe(docFingerprint("<p>x</p>", signers, [{ key: "b", value: "2" }, { key: "a", value: "1" }]));
    expect(a).not.toBe(docFingerprint("<p>x</p>", signers, [{ key: "a", value: "1" }, { key: "b", value: "3" }]));
    expect(a).not.toBe(docFingerprint("<p>x</p>", signers, []));
  });
  it("اثر انگشت الحاقیه به قرارداد اصلی و متن وابسته است", () => {
    const acc = [{ userId: 1, decidedAt: new Date("2025-02-01T00:00:00Z"), ip: "1.1.1.1" }];
    const h = amendmentFingerprint("h1", 1, "<p>a</p>", acc);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toBe(amendmentFingerprint("h2", 1, "<p>a</p>", acc));
    expect(h).not.toBe(amendmentFingerprint("h1", 1, "<p>b</p>", acc));
    expect(h).not.toBe(amendmentFingerprint("h1", 2, "<p>a</p>", acc));
  });
});

describe("پیوست: تشخیص نوع از روی محتوا", () => {
  it("PDF/PNG/JPEG/WebP شناخته می‌شوند و بقیه رد می‌شوند", () => {
    expect(sniffMime(Buffer.from("%PDF-1.7\n..."))?.mime).toBe("application/pdf");
    expect(sniffMime(Buffer.from("89504e470d0a1a0a0000", "hex"))?.mime).toBe("image/png");
    expect(sniffMime(Buffer.from("ffd8ffe000104a46", "hex"))?.mime).toBe("image/jpeg");
    expect(sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))?.mime).toBe("image/webp");
    expect(sniffMime(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(sniffMime(Buffer.from("MZ\x90\x00"))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
  it("نام فایل پاک‌سازی می‌شود", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName('a"b<c>.png')).toBe("a_b_c_.png");
    expect(cleanFileName("")).toBe("file");
  });
});

describe("زمان‌بندی تمدید: منطق خالص", () => {
  const DAY = 86400000;
  it("termEndFor", () => {
    const t = new Date("2025-01-01T00:00:00Z");
    expect(termEndFor(t, 30)?.getTime()).toBe(t.getTime() + 30 * DAY);
    expect(termEndFor(t, 0)).toBeNull();
    expect(termEndFor(t, null)).toBeNull();
  });
  it("renewalState", () => {
    const now = Date.now();
    expect(renewalState({ termEndsAt: null, renewalNoticeDays: 30, renewed: false })).toBe("none");
    expect(renewalState({ termEndsAt: new Date(now + 90 * DAY), renewalNoticeDays: 30, renewed: false })).toBe("ok");
    expect(renewalState({ termEndsAt: new Date(now + 10 * DAY), renewalNoticeDays: 30, renewed: false })).toBe("due");
    expect(renewalState({ termEndsAt: new Date(now - DAY), renewalNoticeDays: 30, renewed: false })).toBe("ended");
    expect(renewalState({ termEndsAt: new Date(now - DAY), renewalNoticeDays: 30, renewed: true })).toBe("renewed");
  });
});

describe("متفرقه", () => {
  it("textToHtml متن را escape و پاراگراف‌بندی می‌کند", () => {
    const h = textToHtml("بند یک <script>alert(1)</script>\n\nبند دو\nخط بعد");
    expect(h).not.toContain("<script>");
    expect(h.match(/<p>/g)?.length).toBe(2);
    expect(h).toContain("<br");
  });
  it("describeUserAgent", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537")).toBe("Chrome روی Windows");
    expect(describeUserAgent("")).toBe("دستگاه ناشناس");
  });
});
